// Pan-Tompkins R-peak detector (Pan & Tompkins 1985), adapted for 500 Hz.
// Timing constants are scaled 4× from the original 125 Hz reference rate.

class PanTompkinsDetector {
  constructor(fs) {
    this.fs = fs;
    const s = fs / 125;                          // scale factor = 4 at 500 Hz

    // timing constants (samples)
    this.MWI_WIN  = Math.round(20 * s);          // 80  samples  (~160 ms)
    this.REFRACT  = Math.round(25 * s);          // 100 samples  (~200 ms)
    this.LEARN_N  = fs * 2;                      // 1000 samples (2 s fast calibration)
    this.R_BACK   = Math.round(22 * s);          // 88  samples  — search window behind MWI peak
    this.R_FWD    = Math.round(3  * s);          // 12  samples  — search window ahead
    this.TW_MIN   = Math.round(25 * s);          // 100 samples  — T-wave zone start
    this.TW_MAX   = Math.round(45 * s);          // 180 samples  — T-wave zone end
    this.TW_SLOPE_RATIO  = 0.5;
    this.RECOVER_MIN_GAP = Math.round(fs / 2);   // 250 samples  — min gap between watchdog fires
    this.NO_QRS_ABS      = fs;                   // 500 samples  — absolute no-QRS limit
    this.MW_BASE_ALPHA   = 0.01;
    this.DECAY_SPKI      = 0.50;
    this.ECG_HIST_LEN    = Math.round(240 * s);  // 960 samples  — ECG history for R localisation

    // ECG circular history (for R-peak localisation)
    this.ecgHist  = new Float64Array(this.ECG_HIST_LEN);
    this.slopeHist = new Float64Array(this.ECG_HIST_LEN);
    this.ecgTime  = new Uint32Array(this.ECG_HIST_LEN);
    this.ecgW     = 0;

    // 5-point derivative buffer
    this.dBuf = new Float64Array(5);
    this.dW   = 0;

    // moving window integrator
    this.mwiBuf = new Float64Array(this.MWI_WIN);
    this.mwiW   = 0;
    this.mwiSum = 0;

    // MWI peak tracker state
    this.m0 = 0; this.t0 = 0;
    this.m1 = 0; this.t1 = 0;
    this.m2 = 0; this.t2 = 0;

    // adaptive thresholds
    this.SPKI = 0; this.NPKI = 0;
    this.TH1  = 0; this.TH2  = 0;

    // QRS state
    this.lastQRS      = 0;
    this.lastQRSSlope = 0;

    // RR interval history
    this.rrBuf = new Float64Array(8);
    this.rrW   = 0; this.rrN = 0;
    this.rrAvg = fs; // initialise to 1 s

    // searchback state
    this.sbPeakVal  = 0;
    this.sbPeakTime = 0;

    // learning phase state
    this.learnCount = 0;
    this.learnMax   = 0;
    this.learnSum   = 0;

    // watchdog state
    this.mwBaseInit = false;
    this.mwBase     = 0;
    this.lastRecover = 0;

    // BPM history (separate 8-beat rolling average)
    this.bpmHist = new Float64Array(8);
    this.bpmHW   = 0; this.bpmHN = 0;
    this.bpm     = 0;
    this.lastRTime = 0;

    // absolute sample counter
    this.n = 0;
  }

  // Reset all internal state — call before each new streaming session.
  reset() {
    this.ecgHist.fill(0); this.slopeHist.fill(0); this.ecgTime.fill(0); this.ecgW = 0;
    this.dBuf.fill(0); this.dW = 0;
    this.mwiBuf.fill(0); this.mwiW = 0; this.mwiSum = 0;
    this.m0 = 0; this.t0 = 0; this.m1 = 0; this.t1 = 0; this.m2 = 0; this.t2 = 0;
    this.SPKI = 0; this.NPKI = 0; this.TH1 = 0; this.TH2 = 0;
    this.lastQRS = 0; this.lastQRSSlope = 0;
    this.rrBuf.fill(0); this.rrW = 0; this.rrN = 0; this.rrAvg = this.fs;
    this.sbPeakVal = 0; this.sbPeakTime = 0;
    this.learnCount = 0; this.learnMax = 0; this.learnSum = 0;
    this.mwBaseInit = false; this.mwBase = 0; this.lastRecover = 0;
    this.bpmHist.fill(0); this.bpmHW = 0; this.bpmHN = 0; this.bpm = 0; this.lastRTime = 0;
    this.n = 0;
  }

  // 5-point symmetric derivative
  _deriv5(x) {
    this.dBuf[this.dW] = x;
    this.dW = (this.dW + 1) % 5;
    const i   = this.dW;
    const xn2 = this.dBuf[(i + 3) % 5];
    const xn1 = this.dBuf[(i + 4) % 5];
    const xp1 = this.dBuf[(i + 1) % 5];
    const xp2 = this.dBuf[(i + 2) % 5];
    return (-xn2 - 2 * xn1 + 2 * xp1 + xp2) / 8.0;
  }

  // moving window integrator — O(1) circular buffer
  _mwi(x) {
    this.mwiSum -= this.mwiBuf[this.mwiW];
    this.mwiBuf[this.mwiW] = x;
    this.mwiSum += x;
    this.mwiW = (this.mwiW + 1) % this.MWI_WIN;
    return this.mwiSum / this.MWI_WIN;
  }

  // update 8-beat RR average
  _rrUpdate(rr) {
    this.rrBuf[this.rrW] = rr;
    this.rrW = (this.rrW + 1) & 7;
    if (this.rrN < 8) this.rrN++;
    let s = 0;
    for (let i = 0; i < this.rrN; i++) s += this.rrBuf[i];
    this.rrAvg = s / this.rrN;
  }

  // update 8-beat BPM rolling average
  _bpmUpdate(rTime) {
    if (this.lastRTime === 0) { this.lastRTime = rTime; return; }
    const rr = rTime - this.lastRTime;
    this.lastRTime = rTime;
    if (rr < 10 || rr > this.fs * 3) return;
    this.bpmHist[this.bpmHW] = rr;
    this.bpmHW = (this.bpmHW + 1) & 7;
    if (this.bpmHN < 8) this.bpmHN++;
    let sum = 0;
    for (let i = 0; i < this.bpmHN; i++) sum += this.bpmHist[i];
    this.bpm = (60 * this.fs) / (sum / this.bpmHN);
  }

  // RR coefficient of variation — real ECG < 0.15, noise > 0.30; returns 1.0 until 4 intervals seen
  _rrCV() {
    if (this.bpmHN < 4) return 1.0;
    let sum = 0;
    for (let i = 0; i < this.bpmHN; i++) sum += this.bpmHist[i];
    const mean = sum / this.bpmHN;
    if (mean <= 0) return 1.0;
    let sumSq = 0;
    for (let i = 0; i < this.bpmHN; i++) {
      const d = this.bpmHist[i] - mean;
      sumSq += d * d;
    }
    return Math.sqrt(sumSq / this.bpmHN) / mean;
  }

  // best slope in a window around a time point
  _slopeAround(timeCenter, halfWin) {
    let best = 0;
    for (let k = 0; k < this.ECG_HIST_LEN; k++) {
      const idx = (this.ecgW + this.ECG_HIST_LEN - 1 - k) % this.ECG_HIST_LEN;
      const dt  = (this.ecgTime[idx] | 0) - (timeCenter | 0);
      if (dt >  halfWin) continue;
      if (dt < -halfWin) break;
      if (this.slopeHist[idx] > best) best = this.slopeHist[idx];
    }
    return best;
  }

  // find the true R-peak location near an MWI-detected QRS time
  _findRpeak(qrsTime) {
    let bestVal = -Infinity, bestSlope = -1, bestTime = 0;
    for (let k = 0; k < this.ECG_HIST_LEN; k++) {
      const idx = (this.ecgW + this.ECG_HIST_LEN - 1 - k) % this.ECG_HIST_LEN;
      const dt  = (this.ecgTime[idx] | 0) - (qrsTime | 0);
      if (dt >  this.R_FWD)  continue;
      if (dt < -this.R_BACK) break;
      const v = this.ecgHist[idx];
      const s = this.slopeHist[idx];
      if (v > bestVal || (v === bestVal && s > bestSlope)) {
        bestVal = v; bestSlope = s; bestTime = this.ecgTime[idx];
      }
    }
    return bestTime > 0 ? bestTime : null;
  }

  // recalculate both thresholds from SPKI / NPKI
  _updateTH() {
    this.TH1 = this.NPKI + 0.25 * (this.SPKI - this.NPKI);
    this.TH2 = 0.40 * this.TH1;
  }

  // validate a QRS candidate (refractory, T-wave, and RR checks)
  _acceptQRS(peakTime) {
    if (this.lastQRS !== 0) {
      const dt = peakTime - this.lastQRS;
      if (dt < this.REFRACT) return false;
      if (dt >= this.TW_MIN && dt <= this.TW_MAX) {
        const sNow = this._slopeAround(peakTime, 2);
        if (this.lastQRSSlope > 0 && sNow < this.TW_SLOPE_RATIO * this.lastQRSSlope)
          return false;
      }
      if (this.rrN >= 2 && (peakTime - this.lastQRS) < 0.30 * this.rrAvg)
        return false;
    }
    return true;
  }

  // watchdog — decays SPKI when no QRS detected for too long
  _watchdog() {
    if (this.n < this.LEARN_N || this.lastQRS === 0) return;
    let blindLimit = Math.floor(1.5 * this.rrAvg);
    if (blindLimit < this.NO_QRS_ABS) blindLimit = this.NO_QRS_ABS;
    if ((this.n - this.lastQRS) <= blindLimit) return;
    if ((this.n - this.lastRecover) < this.RECOVER_MIN_GAP) return;
    this.lastRecover = this.n;
    this.SPKI *= this.DECAY_SPKI;
    this.NPKI  = 0.90 * this.NPKI + 0.10 * this.mwBase;
    if (this.NPKI < 1e-12) this.NPKI = 1e-12;
    if (this.SPKI < this.NPKI) this.SPKI = this.NPKI;
    this._updateTH();
    this.sbPeakVal = 0; this.sbPeakTime = 0;
  }

  // process an MWI local maximum as a QRS candidate; returns R-peak sample-time or null
  _handleMWIPeak(peakVal, peakTime) {
    if (this.n < this.LEARN_N) {
      this.learnCount++;
      this.learnSum += peakVal;
      if (peakVal > this.learnMax) this.learnMax = peakVal;
      if (this.n === this.LEARN_N - 1) {
        this.SPKI = this.learnMax;
        this.NPKI = this.learnCount > 0
          ? this.learnSum / this.learnCount
          : 0.1 * this.learnMax;
        this._updateTH();
      }
      return null;
    }

    const isQRS = peakVal >= this.TH1 && this._acceptQRS(peakTime);
    if (!isQRS) {
      this.NPKI = 0.125 * peakVal + 0.875 * this.NPKI;
      this._updateTH();
      if (peakVal > this.TH2 && peakVal > this.sbPeakVal) {
        this.sbPeakVal  = peakVal;
        this.sbPeakTime = peakTime;
      }
      return null;
    }

    const rr = this.lastQRS === 0 ? this.rrAvg : (peakTime - this.lastQRS);
    this.lastQRS = peakTime;
    this._rrUpdate(rr);
    this.lastQRSSlope = this._slopeAround(peakTime, 2);
    this.SPKI = 0.125 * peakVal + 0.875 * this.SPKI;
    this._updateTH();
    this.sbPeakVal = 0; this.sbPeakTime = 0;

    const rT    = this._findRpeak(peakTime);
    const rTime = rT !== null ? rT : peakTime;
    this._bpmUpdate(rTime);
    return rTime;
  }

  // searchback — recover a missed beat after 1.66× rrAvg silence
  _searchback() {
    if (this.n < this.LEARN_N || this.lastQRS === 0) return null;
    if ((this.n - this.lastQRS) <= 1.66 * this.rrAvg) return null;
    if (this.sbPeakTime !== 0 && this.sbPeakVal >= this.TH2 &&
        this._acceptQRS(this.sbPeakTime)) {
      const rr = this.sbPeakTime - this.lastQRS;
      this.lastQRS = this.sbPeakTime;
      this._rrUpdate(rr);
      this.lastQRSSlope = this._slopeAround(this.sbPeakTime, 2);
      this.SPKI = 0.125 * this.sbPeakVal + 0.875 * this.SPKI;
      this._updateTH();
      const rT    = this._findRpeak(this.sbPeakTime);
      const rTime = rT !== null ? rT : this.sbPeakTime;
      this.sbPeakVal = 0; this.sbPeakTime = 0;
      this._bpmUpdate(rTime);
      return rTime;
    }
    this.sbPeakVal = 0; this.sbPeakTime = 0;
    this.NPKI *= 0.95;
    this._updateTH();
    return null;
  }

  // feed one filtered ECG sample; returns R-peak sample-time or null
  // Returns the absolute sample-time of an R-peak when one is detected, or null.
  process(ecgSample) {
    const n     = this.n;
    const d     = this._deriv5(ecgSample);
    const slope = Math.abs(d);
    const mw    = this._mwi(d * d);

    // Store ECG history for R-peak localisation
    this.ecgHist[this.ecgW]   = ecgSample;
    this.slopeHist[this.ecgW] = slope;
    this.ecgTime[this.ecgW]   = n;
    this.ecgW = (this.ecgW + 1) % this.ECG_HIST_LEN;

    // Shift 3-point MWI window
    this.m0 = this.m1; this.t0 = this.t1;
    this.m1 = this.m2; this.t1 = this.t2;
    this.m2 = mw;      this.t2 = n;

    // Watchdog noise baseline tracking
    if (n >= this.LEARN_N) {
      if (!this.mwBaseInit) { this.mwBase = mw; this.mwBaseInit = true; }
      if (mw < this.TH1)
        this.mwBase = (1 - this.MW_BASE_ALPHA) * this.mwBase + this.MW_BASE_ALPHA * mw;
      this._watchdog();
    }

    let rPeak = null;
    if (n >= 2 && this.m1 > this.m0 && this.m1 >= this.m2)
      rPeak = this._handleMWIPeak(this.m1, this.t1);

    const sb = this._searchback();
    if (sb !== null) rPeak = sb;

    this.n++;
    return rPeak; // absolute sample-time, or null
  }
}
