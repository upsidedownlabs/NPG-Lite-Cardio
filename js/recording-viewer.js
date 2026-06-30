// Recording viewer — loads, renders, and scrubs saved ECG recordings.

const STEP_SAMPLES = Math.round(SAMPLE_RATE * 0.5); // 0.5 s per arrow/wheel step

// Write the current viewer window into the two WebGL lines.
function renderViewerFrame() {
  const vd = connection.viewerData;
  if (!vd) return;
  const snap  = vd.samples;
  const peaks = vd.peaks;
  const off   = vd.offset;
  const total = vd.total;

  // ECG waveform line
  for (let i = 0; i < NUM_POINTS; i++) {
    const si = off + i;
    connection.line0.setY(i, si < total ? snap[si] : 0);
  }

  // Peak markers — search PEAK_HALF_WIDTH beyond each edge so a peak just outside
  // the window still renders its partial ⊓ into the visible area.
  const peakDisplay = new Float32Array(NUM_POINTS);
  peakDisplay.fill(NaN);
  if (peaks && connection.peaksVisible) {
    const searchStart = Math.max(0, off - PEAK_HALF_WIDTH);
    const searchEnd   = Math.min(total, off + NUM_POINTS + PEAK_HALF_WIDTH);
    for (let si = searchStart; si < searchEnd; si++) {
      if (!peaks[si]) continue;
      const y      = snap[si];
      const center = si - off;
      const lo     = Math.max(0, center - PEAK_HALF_WIDTH);
      const hi     = Math.min(NUM_POINTS - 1, center + PEAK_HALF_WIDTH);
      if (lo > hi) continue;
      peakDisplay[lo] = y - 0.08;
      for (let j = lo + 1; j < hi; j++) peakDisplay[j] = y;
      peakDisplay[hi] = y - 0.08;
    }
  }
  for (let i = 0; i < NUM_POINTS; i++) {
    connection.peakLine.setY(i, peakDisplay[i]);
  }
  connection.wglp.update();
}

function _sizeMinimap() {
  const dpr    = window.devicePixelRatio || 1;
  const canvas = connection.elements.minimapCanvas;
  const track  = connection.elements.minimapTrack;
  canvas.width  = Math.round(track.clientWidth  * dpr);
  canvas.height = Math.round(track.clientHeight * dpr);
}

// Draw the compressed waveform overview of the entire loaded recording.
function drawMinimap() {
  const vd = connection.viewerData;
  if (!vd || vd.total === 0) return;
  _sizeMinimap();
  const canvas = connection.elements.minimapCanvas;
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const lc = getLineColor();
  ctx.fillStyle = `rgba(${Math.round(lc[0]*255)},${Math.round(lc[1]*255)},${Math.round(lc[2]*255)},0.85)`;
  const total = vd.total;
  for (let x = 0; x < W; x++) {
    const s0 = Math.floor((x / W) * total);
    const s1 = Math.max(s0 + 1, Math.floor(((x + 1) / W) * total));
    let mn = Infinity, mx = -Infinity;
    for (let s = s0; s < Math.min(total, s1); s++) {
      const v = vd.samples[s];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (mn === Infinity) continue;
    const yTop = ((1 - mx) / 2) * H;
    const yBot = ((1 - mn) / 2) * H;
    ctx.fillRect(x, Math.max(0, yTop), 1, Math.max(1, yBot - yTop));
  }
  // Overlay R-peak markers as thin vertical lines
  if (connection.peaksVisible && vd.peaks) {
    const pc = getPeakColor();
    ctx.fillStyle = `rgba(${Math.round(pc[0]*255)},${Math.round(pc[1]*255)},${Math.round(pc[2]*255)},0.85)`;
    for (let x = 0; x < W; x++) {
      const s0 = Math.floor((x / W) * total);
      const s1 = Math.max(s0 + 1, Math.floor(((x + 1) / W) * total));
      for (let s = s0; s < Math.min(total, s1); s++) {
        if (vd.peaks[s]) { ctx.fillRect(x, 0, 1, H); break; }
      }
    }
  }
  updateMinimapViewport();
}

// Reposition the viewport highlight block over the current window.
function updateMinimapViewport() {
  const vd = connection.viewerData;
  if (!vd || vd.total === 0) return;
  const track  = connection.elements.minimapTrack;
  const vport  = connection.elements.minimapViewport;
  const trackW = track.clientWidth;
  const blockW = Math.min(trackW, (NUM_POINTS / vd.total) * trackW);
  const blockL = (vd.offset / vd.total) * trackW;
  vport.style.width = blockW + 'px';
  vport.style.left  = Math.max(0, Math.min(trackW - blockW, blockL)) + 'px';
}


function shiftViewer(deltaSamples) {
  if (!connection.viewerActive || !connection.viewerData) return;
  const vd = connection.viewerData;
  vd.offset = Math.max(0, Math.min(vd.max, vd.offset + deltaSamples));
  updateMinimapViewport();
  renderViewerFrame();
}


async function openRecordingViewer(filename) {
  try {
    if (connection.streaming) await stopStream();
    await (connection._writeQueue || Promise.resolve());
    const db = await openRecordingDB();

    // Load all batches for this filename
    const batches = await new Promise((res, rej) => {
      const req = db.transaction('ECGBatches', 'readonly')
        .objectStore('ECGBatches').index('filename').getAll(filename);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });

    let allRows;
    if (batches.length > 0) {
      batches.sort((a, b) => a.batchIndex - b.batchIndex);
      allRows = batches.flatMap(b => b.rows);
    } else {
      // Fallback: legacy single-record store
      const record = await new Promise((res, rej) => {
        const req = db.transaction('ECGRecordings', 'readonly')
          .objectStore('ECGRecordings').get(filename);
        req.onsuccess = () => res(req.result);
        req.onerror   = () => rej(req.error);
      });
      if (!record || !Array.isArray(record.content)) {
        console.error('Viewer: no data for', filename);
        return;
      }
      allRows = record.content;
    }

    const total = allRows.length;
    if (total === 0) return;

    // Extract CH0 samples into a typed array
    const samples = new Float32Array(total);
    for (let i = 0; i < total; i++) samples[i] = allRows[i][1];

    // Re-run Pan-Tompkins offline to annotate R-peaks in the recording
    const detector = new PanTompkinsDetector(SAMPLE_RATE);
    const peaks = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      const rT = detector.process(samples[i]);
      if (rT !== null && rT < total) peaks[rT] = 1;
    }

    const durationSec = total / SAMPLE_RATE;
    const mm = String(Math.floor(durationSec / 60)).padStart(2, '0');
    const ss = String(Math.floor(durationSec % 60)).padStart(2, '0');

    connection.viewerData = {
      samples,
      peaks,
      total,
      offset: 0,
      max: Math.max(0, total - NUM_POINTS),
      filename,
    };
    connection.viewerActive = true;
    updateButtonStates();

    // Hide BPM display — viewer header takes its place
    connection.elements.bpmDisplay.style.display = 'none';

    // Update viewer header (filename, duration, download, close)
    connection.elements.viewerFilenameEl.textContent = filename;
    connection.elements.viewerDurationEl.textContent =
      `${mm}:${ss} · ${total.toLocaleString()} samples`;
    connection.elements.viewerHeader.style.display = 'flex';

    // Show minimap with duration label
    connection.elements.minimapLabelRight.textContent = `${Math.round(durationSec)} s`;
    connection.elements.minimapWrap.style.display = 'block';
    connection.elements.dropup.classList.remove('open');

    renderViewerFrame();
    drawMinimap();
  } catch (e) {
    console.error('Viewer failed:', e);
  }
}

function closeRecordingViewer() {
  connection.viewerActive = false;
  connection.viewerData   = null;
  updateButtonStates();

  // Restore BPM display
  connection.elements.bpmDisplay.style.display = '';

  connection.elements.viewerHeader.style.display    = 'none';
  connection.elements.minimapWrap.style.display     = 'none';
  connection.elements.minimapLabelRight.textContent = '';

  // Clear WebGL lines so live view starts clean
  for (let i = 0; i < NUM_POINTS; i++) {
    connection.line0.setY(i, 0);
    connection.peakLine.setY(i, NaN);
  }
  connection.wglp.update();

  // Restart live stream if still connected and not manually paused
  if (connection.connected && !connection.displayPaused) {
    startStream();
  }
}


async function downloadFile(filename) {
  try {
    await (connection._writeQueue || Promise.resolve());
    const db = await openRecordingDB();
    const batches = await new Promise((res, rej) => {
      const req = db.transaction('ECGBatches', 'readonly')
        .objectStore('ECGBatches').index('filename').getAll(filename);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });

    let allRows;
    if (batches.length > 0) {
      batches.sort((a, b) => a.batchIndex - b.batchIndex);
      allRows = batches.flatMap(b => b.rows);
    } else {
      // Fallback: legacy single-record store
      const record = await new Promise((res, rej) => {
        const req = db.transaction('ECGRecordings', 'readonly')
          .objectStore('ECGRecordings').get(filename);
        req.onsuccess = () => res(req.result);
        req.onerror   = () => rej(req.error);
      });
      if (!record || !Array.isArray(record.content)) {
        console.error('Download: no data found for', filename);
        return;
      }
      allRows = record.content;
    }

    const csv = ['Sample Counter,CH0', ...allRows.map(r => `${r[0]},${r[1]}`)].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log('Downloaded:', filename, allRows.length, 'rows');
  } catch (e) {
    console.error('Download failed:', e);
  }
}


function initViewerControls(canvasContainer) {
  // Keyboard: arrow keys
  document.addEventListener("keydown", (e) => {
    if (!connection.viewerActive) return;
    if (e.key === "ArrowLeft")  { e.preventDefault(); shiftViewer(-STEP_SAMPLES); }
    if (e.key === "ArrowRight") { e.preventDefault(); shiftViewer(+STEP_SAMPLES); }
  });

  // Mouse wheel + 2-finger trackpad
  canvasContainer.addEventListener("wheel", (e) => {
    if (!connection.viewerActive) return;
    e.preventDefault();
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    shiftViewer(Math.round(delta * 2));
  }, { passive: false });

  // Canvas touch swipe — left swipe = forward, right swipe = back
  let swipeTouchId = null, swipePrevX = 0;
  canvasContainer.addEventListener("touchstart", (e) => {
    if (!connection.viewerActive) return;
    swipeTouchId = e.changedTouches[0].identifier;
    swipePrevX   = e.changedTouches[0].clientX;
  }, { passive: true });
  canvasContainer.addEventListener("touchmove", (e) => {
    if (!connection.viewerActive || swipeTouchId === null || !connection.viewerData) return;
    let t = null;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === swipeTouchId) { t = e.changedTouches[i]; break; }
    }
    if (!t) return;
    e.preventDefault();
    const dx = t.clientX - swipePrevX;
    swipePrevX = t.clientX;
    shiftViewer(Math.round(-dx * connection.viewerData.total / canvasContainer.clientWidth));
  }, { passive: false });
  canvasContainer.addEventListener("touchend",    () => { swipeTouchId = null; }, { passive: true });
  canvasContainer.addEventListener("touchcancel", () => { swipeTouchId = null; }, { passive: true });

  // Minimap viewport drag
  const minimapViewport = connection.elements.minimapViewport;
  const minimapTrack    = connection.elements.minimapTrack;
  let minimapDragging = false, trackDragging = false;
  let dragStartX = 0, dragStartOffset = 0;

  minimapViewport.addEventListener("pointerdown", (e) => {
    if (!connection.viewerActive) return;
    e.preventDefault();
    e.stopPropagation();
    minimapViewport.setPointerCapture(e.pointerId);
    minimapDragging = true;
    dragStartX      = e.clientX;
    dragStartOffset = connection.viewerData.offset;
  });
  minimapViewport.addEventListener("pointermove", (e) => {
    if (!minimapDragging || !connection.viewerActive || !connection.viewerData) return;
    const dx           = e.clientX - dragStartX;
    const trackW       = minimapTrack.clientWidth;
    const deltaSamples = Math.round((dx / trackW) * connection.viewerData.total);
    connection.viewerData.offset = Math.max(0, Math.min(connection.viewerData.max, dragStartOffset + deltaSamples));
    updateMinimapViewport();
    renderViewerFrame();
  });
  minimapViewport.addEventListener("pointerup",     () => { minimapDragging = false; });
  minimapViewport.addEventListener("pointercancel", () => { minimapDragging = false; });

  // Minimap track — click to jump, then drag
  minimapTrack.addEventListener("pointerdown", (e) => {
    if (e.target === minimapViewport || !connection.viewerActive || !connection.viewerData) return;
    e.preventDefault();
    minimapTrack.setPointerCapture(e.pointerId);
    trackDragging = true;
    const vd   = connection.viewerData;
    const rect = minimapTrack.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    vd.offset   = Math.max(0, Math.min(vd.max, Math.round(ratio * vd.total - NUM_POINTS / 2)));
    dragStartX      = e.clientX;
    dragStartOffset = vd.offset;
    updateMinimapViewport();
    renderViewerFrame();
  });
  minimapTrack.addEventListener("pointermove", (e) => {
    if (!trackDragging || !connection.viewerActive || !connection.viewerData) return;
    const dx           = e.clientX - dragStartX;
    const trackW       = minimapTrack.clientWidth;
    const deltaSamples = Math.round((dx / trackW) * connection.viewerData.total);
    connection.viewerData.offset = Math.max(0, Math.min(connection.viewerData.max, dragStartOffset + deltaSamples));
    updateMinimapViewport();
    renderViewerFrame();
  });
  minimapTrack.addEventListener("pointerup",     () => { trackDragging = false; });
  minimapTrack.addEventListener("pointercancel", () => { trackDragging = false; });
}
