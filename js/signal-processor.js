// Per-sample signal processing — filters, SQI, and Pan-Tompkins peak detection.

function processSample(dataView) {
  if (dataView.byteLength !== connection.singleSampleLen) return;
  connection._samplesThisSecond++;

  // 1. dropped-packet detection
  const sampleCounter = dataView.getUint8(0);
  if (connection.prevSampleCounter === null) {
    connection.prevSampleCounter = sampleCounter;
  } else {
    const expected = (connection.prevSampleCounter + 1) % 256;
    if (sampleCounter !== expected) {
      const skipped = (sampleCounter - expected + 256) % 256;
      connection.droppedSamples += skipped;
      console.log(`Samples lost: ${connection.droppedSamples}`);
    }
    connection.prevSampleCounter = sampleCounter;
  }

  // 2. normalize ADC value
  const writePos = connection.sampleIndex;
  connection.peakFlags[writePos] = 0; // clear stale peak flag for this slot

  const rawCh0 = dataView.getInt16(1, false); // big-endian
  let normCh0  = normalizeSample(Math.max(0, Math.min(4095, rawCh0)));

  // 3. signal quality — EMA of pre-filter power; drops near 0 when electrodes are off
  const wasGood = connection.signalGood;
  connection._sqiPower = 0.999 * connection._sqiPower + 0.001 * normCh0 * normCh0;
  connection.signalGood = connection._sqiPower > SQI_FLAT_THRESHOLD;

  // 4. if signal returns after >500 ms flatline, reset all filters so they re-calibrate cleanly
  if (!connection.signalGood) {
    if (connection._flatlineSamples < 65535) connection._flatlineSamples++;
  } else {
    if (!wasGood && connection._flatlineSamples > 250) {
      connection.panTompkins.reset();
      connection.notch0.reset();
      connection.ecg0.reset();
      connection.dc0.reset();
      connection.sampleIndex = 0;
      connection.dataCh0.fill(0);
      connection.peakFlags.fill(0);
    }
    connection._flatlineSamples = 0;
  }

  // 5–7. filter chain
  if (connection.dcEnabled) normCh0 = connection.dc0.process(normCh0);
  normCh0 = connection.ecg0.process(connection.notch0.process(normCh0));

  connection.dataCh0[writePos] = normCh0;
  connection.sampleIndex = (connection.sampleIndex + 1) % NUM_POINTS;

  // 8. R-peak detection
  const rTime = connection.panTompkins.process(normCh0);

  // RR-interval coefficient of variation distinguishes real ECG (regular
  // intervals, CV < 0.15) from floating-wire noise that triggers the detector
  // on random spikes (CV > 0.30). Returns "bad" until ≥ 4 intervals are seen.
  connection.signalRegular = connection.panTompkins._rrCV() < RR_CV_THRESHOLD;

  if (rTime !== null && connection.signalGood && connection.signalRegular) {
    connection.peakFlags[rTime % NUM_POINTS] = 1;
    triggerHeartbeat(); // defined in button-ui.js
  }
  connection.absN++;

  // 9. append to recording if active
  if (connection.isRecording) {
    connection.recordingData.push([sampleCounter, normCh0]);
    connection.totalRecordedSamples++;

    if (connection.recordingData.length >= 500) {
      flushRecordingData(); // defined in recording.js
    }

    if (connection.recordingDurationLimit !== null) {
      const elapsed = Date.now() - connection.recordingStartTime;
      if (elapsed >= connection.recordingDurationLimit) {
        stopRecording(); // defined in recording.js
      }
    }
  }
}

// Compute the current BPM from the Pan-Tompkins detector.
// Returns a number in [40, 120] if the signal is valid, or null.
function computeBPM() {
  if (!connection || !connection.signalRegular) return null;
  const bpm = connection.panTompkins.bpm;
  return (bpm >= 40 && bpm <= 120) ? bpm : null;
}
