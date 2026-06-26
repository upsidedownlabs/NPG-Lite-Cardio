// UI layer — DOM construction, button wiring, and display helpers
//
// Responsibilities:
//   - createDevicePanel()  : builds the full UI DOM tree, initialises the
//                            global `connection` state object, starts the
//                            animation loop and BPM update interval
//   - updateButtonStates() : syncs every button's enabled/icon/label state
//                            to the current connection flags
//   - showToast()          : brief save-confirmation popup above the recordings button
//   - refreshDropup()      : rebuilds the recordings list dropup
//   - togglePeaks()        : shows/hides R-peak markers on both live and viewer plots
//   - toggleDCFilter()     : enables/disables the DC (baseline-wander) filter
//   - triggerHeartbeat()   : flashes the heart icon on each detected R-peak
//   - updateBPMDisplay()   : writes the current BPM value into the header text
//   - resetBPMDisplay()    : resets BPM text to "-- BPM" (called on disconnect/stop)
//   - toggleTheme()        : switches dark ↔ light, persists to localStorage,
//                            repaints WebGL colours, grid, and minimap
//
// All other modules call the global functions above.
// DOM element references needed by other modules are stored on connection.elements.

// Global connection state — populated by createDevicePanel(), referenced by all modules.
let connection = null;

function createDevicePanel() {

  // ════════════════════════════════════════════════════════════
  // 1. BUILD DOM
  // ════════════════════════════════════════════════════════════

  // Root canvas container (fills the viewport)
  const canvasContainer = document.createElement("div");
  canvasContainer.classList.add("canvas-container");

  const canvas = document.createElement("canvas");
  canvasContainer.appendChild(canvas);

  // Overlay div — all HUD elements are children of this
  const overlay = document.createElement("div");
  overlay.classList.add("canvas-overlay");

  // ── UDL logo (top-left, theme-aware) ─────────────────────────────────────
  const udlLogo = document.createElement("a");
  udlLogo.classList.add("udl-logo");
  udlLogo.href   = "https://upsidedownlabs.tech/";
  udlLogo.target = "_blank";
  udlLogo.rel    = "noopener noreferrer";
  udlLogo.innerHTML = `
    <img class="logo-dark"         src="icons/udl_logo_white.svg"         alt="Upside Down Labs">
    <img class="logo-light"        src="icons/udl_logo_black.svg"         alt="Upside Down Labs">
    <img class="logo-dark-mobile"  src="icons/udl_logo_white_mobile.svg"  alt="Upside Down Labs">
    <img class="logo-light-mobile" src="icons/udl_logo_black_mobile.svg"  alt="Upside Down Labs">`;
  overlay.appendChild(udlLogo);

  // ── BPM display (top-center) ──────────────────────────────────────────────
  const overlayTop = document.createElement("div");
  overlayTop.classList.add("overlay-top");

  const bpmDisplay = document.createElement("div");
  bpmDisplay.classList.add("overlay-bpm");

  const heartIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  heartIcon.setAttribute("viewBox", "0 0 24 24");
  heartIcon.classList.add("heart-icon");
  const heartPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  heartPath.setAttribute("d", "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z");
  heartIcon.appendChild(heartPath);

  const bpmText = document.createElement("span");
  bpmText.textContent = "-- BPM";

  bpmDisplay.appendChild(heartIcon);
  bpmDisplay.appendChild(bpmText);
  overlayTop.appendChild(bpmDisplay);
  overlay.appendChild(overlayTop);

  // ── Top-right group: info | fullscreen | theme | disconnect ───────────────
  const bottomRightGroup = document.createElement("div");
  bottomRightGroup.classList.add("bottom-right-group");

  // Info button + panel
  const infoBtnWrapper = document.createElement("div");
  infoBtnWrapper.classList.add("info-btn-wrapper");
  const infoBtn = document.createElement("button");
  infoBtn.classList.add("info-btn");
  infoBtn.setAttribute("aria-label", "Show scale info");
  infoBtn.textContent = "i";
  const infoPanel = document.createElement("div");
  infoPanel.classList.add("info-panel");
  const totalSec = NUM_POINTS / SAMPLE_RATE;
  const largeBox = 100 / SAMPLE_RATE;
  const smallBox = 20  / SAMPLE_RATE;
  infoPanel.innerHTML =
    `<div class="info-panel-title">Scale reference</div>` +
    `<table>` +
    `<tr><td>Display window</td><td>${totalSec} s</td></tr>` +
    `<tr><td>Large box</td><td>${largeBox.toFixed(2)} s</td></tr>` +
    `<tr><td>Small box</td><td>${smallBox.toFixed(3)} s</td></tr>` +
    `<tr><td>Sample rate</td><td>${SAMPLE_RATE} Hz</td></tr>` +
    `</table>` +
    `<div class="info-panel-title" style="margin-top:10px">Signal filters</div>` +
    `<table>` +
    `<tr><td>Notch</td><td>50 Hz notch</td></tr>` +
    `<tr><td>ECG low-pass</td><td>30 Hz cutoff</td></tr>` +
    `<tr><td>DC removal</td><td>0.5 Hz high-pass</td></tr>` +
    `</table>`;
  infoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    infoPanel.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!infoBtnWrapper.contains(e.target)) infoPanel.classList.remove("open");
  });
  infoBtnWrapper.appendChild(infoBtn);
  infoBtnWrapper.appendChild(infoPanel);

  // Fullscreen button
  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.classList.add("fullscreen-btn");
  fullscreenBtn.setAttribute("aria-label", "Toggle fullscreen");
  fullscreenBtn.innerHTML = `
    <svg viewBox="0 0 24 24">
      <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
    </svg>`;
  fullscreenBtn.addEventListener("click", toggleFullscreen);

  // Theme toggle (in-overlay, shown when fullscreen)
  const fullscreenThemeToggle = document.createElement("button");
  fullscreenThemeToggle.classList.add("fullscreen-theme-toggle");
  fullscreenThemeToggle.setAttribute("aria-label", "Toggle theme in fullscreen");
  fullscreenThemeToggle.innerHTML = `
    <svg class="theme-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="4"/>
      <path d="M12 2v2"/><path d="M12 20v2"/>
      <path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/>
      <path d="M2 12h2"/><path d="M20 12h2"/>
      <path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>
    </svg>
    <svg class="theme-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>
    </svg>`;
  fullscreenThemeToggle.addEventListener('click', toggleTheme);

  // Disconnect button
  const disconnectBtn = document.createElement("button");
  disconnectBtn.classList.add("btn");
  disconnectBtn.setAttribute("aria-label", "Disconnect");
  disconnectBtn.title    = "Disconnect";
  disconnectBtn.disabled = true;
  disconnectBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m17 17-5 5V12l-5 5"/><path d="m2 2 20 20"/><path d="M14.5 9.5 17 7l-5-5v4.5"/>
    </svg>`;

  bottomRightGroup.appendChild(infoBtnWrapper);
  bottomRightGroup.appendChild(fullscreenBtn);
  bottomRightGroup.appendChild(fullscreenThemeToggle);
  bottomRightGroup.appendChild(disconnectBtn);
  overlay.appendChild(bottomRightGroup);

  // ── Bottom controls bar ───────────────────────────────────────────────────
  const controlsOverlay = document.createElement("div");
  controlsOverlay.classList.add("controls-overlay");

  // Connect / play-pause (center, larger)
  const connectToggleBtn = document.createElement("button");
  connectToggleBtn.classList.add("btn", "btn-connect-center");
  connectToggleBtn.setAttribute("aria-label", "Connect");
  connectToggleBtn.title = "Connect";
  connectToggleBtn.innerHTML = `
    <svg class="icon-connect" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m7 7 10 10-5 5V2l5 5L7 17"/>
    </svg>
    <svg class="icon-pause" style="display:none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>
    </svg>
    <svg class="icon-play" style="display:none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>
    </svg>`;

  // Record button
  const recordBtnWrapper = document.createElement("div");
  recordBtnWrapper.style.cssText = 'position:relative;display:flex';
  const recordBtn = document.createElement("button");
  recordBtn.classList.add("btn");
  recordBtn.disabled = true;
  recordBtn.setAttribute("aria-label", "Start recording");
  recordBtn.title = "Record";
  recordBtn.innerHTML = `
    <svg class="icon-record" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="8" fill="var(--primary)"/>
    </svg>
    <svg class="icon-stop" style="display:none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="5" y="5" width="14" height="14" rx="2" fill="var(--primary)"/>
    </svg>`;
  recordBtnWrapper.appendChild(recordBtn);

  // Recordings button + dropup
  const recordingsWrapper = document.createElement("div");
  recordingsWrapper.style.cssText = 'position:relative;display:flex';
  const fileManagerBtn = document.createElement("button");
  fileManagerBtn.classList.add("btn");
  fileManagerBtn.setAttribute("aria-label", "View recordings");
  fileManagerBtn.title = "Recordings";
  fileManagerBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5"/>
      <path d="M14 2v5a1 1 0 0 0 1 1h5"/>
      <path d="M8 12v-1"/><path d="M8 18v-2"/><path d="M8 7V6"/>
      <circle cx="8" cy="20" r="2"/>
    </svg>`;
  const dropup = document.createElement("div");
  dropup.classList.add("recordings-dropup");
  dropup.innerHTML = '<div class="recordings-dropup-header">This session</div><ul class="file-list"></ul>';
  document.addEventListener("click", (e) => {
    if (!recordingsWrapper.contains(e.target) && !dropup.contains(e.target))
      dropup.classList.remove("open");
  });
  const recToast = document.createElement("div");
  recToast.classList.add("rec-toast");
  recordingsWrapper.appendChild(fileManagerBtn);

  // Peaks toggle
  const peaksToggleBtn = document.createElement("button");
  peaksToggleBtn.classList.add("btn");
  peaksToggleBtn.setAttribute("aria-label", "Hide peaks");
  peaksToggleBtn.title = "Hide peaks";
  peaksToggleBtn.innerHTML = `
    <svg class="icon-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
    <svg class="icon-eye-off" style="display:none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/>
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/>
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/>
      <path d="m2 2 20 20"/>
    </svg>`;

  // DC filter toggle
  const dcToggleBtn = document.createElement("button");
  dcToggleBtn.classList.add("btn");
  dcToggleBtn.setAttribute("aria-label", "Disable DC filter");
  dcToggleBtn.title = "Disable DC filter";
  dcToggleBtn.innerHTML = `<img src="icons/dc-filter-icon.svg" alt="DC filter">`;

  // Order: recordings | record | connect/play-pause (center) | peaks | DC
  // dropup and recToast are absolute-positioned children of controlsOverlay so they
  // center on the full button row (left: 50% / translateX(-50%)), not just the recordings button.
  controlsOverlay.append(recordingsWrapper, recordBtnWrapper, connectToggleBtn, peaksToggleBtn, dcToggleBtn);
  controlsOverlay.appendChild(dropup);
  controlsOverlay.appendChild(recToast);
  overlay.appendChild(controlsOverlay);

  // ── Recording timer pill (above controls) ────────────────────────────────
  const recordingTimer = document.createElement("div");
  recordingTimer.classList.add("recording-timer");
  recordingTimer.style.display = "none";
  recordingTimer.innerHTML = '<div class="recording-dot"></div><span>00:00:00</span>';
  overlay.appendChild(recordingTimer);

  // ── Recording viewer header ───────────────────────────────────────────────
  const viewerHeader = document.createElement('div');
  viewerHeader.classList.add('viewer-header');
  viewerHeader.style.display = 'none';
  const viewerFilenameEl = document.createElement('span');
  viewerFilenameEl.classList.add('viewer-filename');
  const viewerDurationEl = document.createElement('span');
  viewerDurationEl.classList.add('viewer-duration');
  const viewerDownloadBtn = document.createElement('button');
  viewerDownloadBtn.classList.add('btn', 'viewer-close-btn');
  viewerDownloadBtn.setAttribute('aria-label', 'Download recording');
  viewerDownloadBtn.title = 'Download CSV';
  viewerDownloadBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  viewerDownloadBtn.addEventListener('click', () => {
    if (connection.viewerData) downloadFile(connection.viewerData.filename);
  });
  const viewerCloseBtn = document.createElement('button');
  viewerCloseBtn.classList.add('btn', 'viewer-close-btn');
  viewerCloseBtn.setAttribute('aria-label', 'Close recording viewer');
  viewerCloseBtn.title = 'Close viewer';
  viewerCloseBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
  viewerCloseBtn.addEventListener('click', closeRecordingViewer);
  viewerHeader.append(viewerFilenameEl, viewerDurationEl, viewerDownloadBtn, viewerCloseBtn);
  overlay.appendChild(viewerHeader);

  // ── Minimap scrubber ──────────────────────────────────────────────────────
  const minimapWrap     = document.createElement("div");
  minimapWrap.classList.add("minimap-wrap");
  const minimapTrack    = document.createElement("div");
  minimapTrack.classList.add("minimap-track");
  const minimapCanvas   = document.createElement("canvas");
  minimapCanvas.classList.add("minimap-canvas");
  const minimapViewport = document.createElement("div");
  minimapViewport.classList.add("minimap-viewport");
  const minimapLabelLeft = document.createElement("div");
  minimapLabelLeft.classList.add("minimap-offset-label", "minimap-offset-label--left");
  minimapLabelLeft.textContent = "0 s";
  const minimapLabelRight = document.createElement("div");
  minimapLabelRight.classList.add("minimap-offset-label", "minimap-offset-label--right");
  minimapTrack.appendChild(minimapCanvas);
  minimapTrack.appendChild(minimapViewport);
  minimapWrap.appendChild(minimapLabelLeft);
  minimapWrap.appendChild(minimapLabelRight);
  minimapWrap.appendChild(minimapTrack);
  overlay.appendChild(minimapWrap);

  canvasContainer.appendChild(overlay);
  document.getElementById("deviceContainer").appendChild(canvasContainer);

  // ════════════════════════════════════════════════════════════
  // 2. INITIALISE GLOBAL CONNECTION STATE
  // ════════════════════════════════════════════════════════════
  connection = {
    // BLE device handles
    device: null, server: null, controlChar: null, dataChar: null,
    _notifHandler: null, _dataCheckInterval: null, _samplesThisSecond: 0,
    streaming: false, connected: false, displayPaused: false,

    // Signal data (circular buffer)
    canvas,
    dataCh0: new Float32Array(NUM_POINTS),
    sampleIndex: 0,
    prevSampleCounter: null,
    droppedSamples: 0,

    // WebGL references (set by initPlot in realtime-plot.js)
    wglp: null, line0: null, peakLine: null,

    // Filter instances
    notch0: new NotchFilter(),
    ecg0:   new ECGFilter(),
    dc0:    new DCFilter(),
    dcEnabled: true,

    // Peak detection
    peakFlags:    new Uint8Array(NUM_POINTS),
    panTompkins:  new PanTompkinsDetector(SAMPLE_RATE),
    absN: 0,

    // Signal quality
    _sqiPower: 0, signalGood: false, signalRegular: false, _flatlineSamples: 0,

    // Heartbeat animation timer
    _heartbeatTimer: null,

    // Packet format (overwritten after connect based on device name)
    singleSampleLen: 7,   // 3CH default
    newPacketLen:    70,  // 3CH default

    // Recording viewer
    viewerActive: false, viewerData: null,
    peaksVisible: true,

    // Recording
    isRecording: false, recordingStartTime: null,
    recordingData: [], recordingFilename: null,
    recordingTimer: null, totalRecordedSamples: 0,
    recordingDurationLimit: null,
    _batchIndex: 0, _writeQueue: null, _db: null,
    sessionRecordings: [],

    // DOM element refs used by other modules (recording.js, connection.js, recording-viewer.js)
    elements: {
      bpmText,
      heartIcon,
      recordingTimer,
      viewerHeader,
      viewerFilenameEl,
      viewerDurationEl,
      minimapWrap,
      minimapLabelRight,
      minimapCanvas,
      minimapViewport,
      minimapTrack,
      dropup,
      recToast,
      fileManagerBtn,
      canvasContainer,
    },
  };

  // ════════════════════════════════════════════════════════════
  // 3. CANVAS SIZING + RESIZE OBSERVER
  // ════════════════════════════════════════════════════════════
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.round(window.innerWidth  * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);

  const resizeObserver = new ResizeObserver(() => {
    const newDpr = window.devicePixelRatio || 1;
    const w = Math.round(canvasContainer.clientWidth  * newDpr);
    const h = Math.round(canvasContainer.clientHeight * newDpr);
    if (w !== canvas.width || h !== canvas.height) {
      canvas.width  = w;
      canvas.height = h;
      if (connection.wglp) {
        connection.wglp = new WebglPlot(canvas);
        if (connection.line0)    connection.wglp.addLine(connection.line0);
        if (connection.peakLine) connection.wglp.addLine(connection.peakLine);
        applyThemeColors();
      }
    }
    drawGrid();
  });
  resizeObserver.observe(canvasContainer);

  // ════════════════════════════════════════════════════════════
  // 4. INIT WEBGL PLOT, ANIMATION, BPM INTERVAL
  // ════════════════════════════════════════════════════════════
  initPlot(canvas);   // realtime-plot.js
  drawGrid();         // realtime-plot.js
  animate();          // realtime-plot.js

  // BPM display update at 1 Hz — Pan-Tompkins maintains 8-beat RR average
  // (AAMI EC13 / IEC 60601-2-27 standard smoothing); no extra windowing needed.
  setInterval(() => updateBPMDisplay(computeBPM()), 1000);

  // ════════════════════════════════════════════════════════════
  // 5. WIRE UP BUTTON EVENTS
  // ════════════════════════════════════════════════════════════
  connectToggleBtn.addEventListener("click", () => {
    if (!connection.connected) {
      connectBLE();          // connection.js
    } else {
      toggleDisplayPause();  // connection.js
    }
  });

  disconnectBtn.addEventListener("click", disconnectBLE);
  recordBtn.addEventListener("click", toggleRecording);
  peaksToggleBtn.addEventListener("click", togglePeaks);
  dcToggleBtn.addEventListener("click", toggleDCFilter);

  fileManagerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    refreshDropup();
    dropup.classList.toggle("open");
  });

  // Init viewer scrub controls (keyboard, wheel, touch, minimap)
  initViewerControls(canvasContainer); // recording-viewer.js

  updateButtonStates();
  loadRecordingsFromDB(); // recording.js — restore persisted recordings on page load

  // ════════════════════════════════════════════════════════════
  // 6. FULLSCREEN HELPER (local — only needs canvasContainer)
  // ════════════════════════════════════════════════════════════
  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(err => console.error("Error exiting fullscreen:", err));
      canvasContainer.classList.remove("fullscreen");
      if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
    } else {
      try {
        await canvasContainer.requestFullscreen();
        canvasContainer.classList.add("fullscreen");
        if (screen.orientation && screen.orientation.lock)
          await screen.orientation.lock("landscape");
      } catch (err) { console.error("Error entering fullscreen:", err); }
    }
  }
}

// ════════════════════════════════════════════════════════════
// GLOBAL UI HELPERS  (called by connection.js, recording.js, signal-processor.js)
// ════════════════════════════════════════════════════════════

// Sync every button's enabled/icon/label to the current connection flags.
function updateButtonStates() {
  if (!connection) return;
  const isConn   = connection.connected;
  const isPaused = connection.displayPaused;
  const isRec    = connection.isRecording;
  const isViewer = !!connection.viewerActive;
  const recTooShort = isRec && (Date.now() - connection.recordingStartTime) < MIN_RECORDING_MS;

  // Connect / play-pause button icons
  const connectToggleBtn = document.querySelector('.btn-connect-center');
  if (connectToggleBtn) {
    connectToggleBtn.querySelector('.icon-connect').style.display = (!isConn)             ? 'block' : 'none';
    connectToggleBtn.querySelector('.icon-pause').style.display   = (isConn && !isPaused) ? 'block' : 'none';
    connectToggleBtn.querySelector('.icon-play').style.display    = (isConn && isPaused)  ? 'block' : 'none';
    connectToggleBtn.setAttribute('aria-label', !isConn ? 'Connect' : isPaused ? 'Resume display' : 'Pause display');
    connectToggleBtn.title = !isConn ? 'Connect' : isPaused ? 'Resume' : 'Pause';
    connectToggleBtn.disabled = isRec || isViewer || !!connection._streamBusy;
  }

  // Disconnect button
  const disconnectBtn = connection.elements
    ? connection.elements.canvasContainer.querySelector('.bottom-right-group .btn')
    : null;
  if (disconnectBtn) disconnectBtn.disabled = !isConn;

  // Record button
  const recordBtns = document.querySelectorAll('.controls-overlay .btn:not(.btn-connect-center)');
  // Find record button by its icon-record child
  document.querySelectorAll('.controls-overlay .btn').forEach(btn => {
    if (!btn.querySelector('.icon-record')) return;
    btn.disabled = !isConn || recTooShort || isViewer || isPaused;
    btn.querySelector('.icon-record').style.display = isRec ? 'none'  : 'block';
    btn.querySelector('.icon-stop').style.display   = isRec ? 'block' : 'none';
    btn.setAttribute('aria-label', isRec ? 'Stop recording' : 'Start recording');
    btn.title = recTooShort ? 'Minimum recording duration: 12 s' : isRec ? 'Stop recording' : 'Record';
    if (isRec) btn.classList.add("recording");
    else        btn.classList.remove("recording");
  });

  // View (eye) buttons in the recordings dropup — disabled while recording is active
  document.querySelectorAll('.file-action-btn.view').forEach(btn => {
    btn.disabled = isRec;
  });

  // Recordings button — disabled while recording (can't browse files mid-recording)
  if (connection.elements?.fileManagerBtn) {
    connection.elements.fileManagerBtn.disabled = isRec;
  }

  // Slide dropup above the recording timer pill when both are visible
  if (connection.elements?.dropup) {
    connection.elements.dropup.classList.toggle('timer-active', isRec);
  }
}

// Flash the heart icon for 200 ms on each detected R-peak.
function triggerHeartbeat() {
  if (!connection || !connection.elements) return;
  const heartIcon = connection.elements.heartIcon;
  heartIcon.classList.add("beating");
  clearTimeout(connection._heartbeatTimer);
  connection._heartbeatTimer = setTimeout(() => heartIcon.classList.remove("beating"), 200);
}

// Write current BPM to the header display.
function updateBPMDisplay(bpm) {
  if (!connection || !connection.elements) return;
  connection.elements.bpmText.textContent = bpm !== null ? Math.round(bpm) + " BPM" : "-- BPM";
}

// Reset BPM text — called on disconnect and stream stop.
function resetBPMDisplay() {
  if (!connection || !connection.elements) return;
  connection.elements.bpmText.textContent = "-- BPM";
}

// Show a brief toast above the recordings button (auto-dismisses after 4.5 s).
let _toastTimer = null;
function showToast(html) {
  if (!connection || !connection.elements) return;
  const recToast = connection.elements.recToast;
  if (!recToast) return;
  recToast.innerHTML = html;
  recToast.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => recToast.classList.remove("show"), 4500);
}

// Rebuild the recordings dropup list from connection.sessionRecordings.
function refreshDropup() {
  if (!connection || !connection.elements) return;
  const fileList = connection.elements.dropup.querySelector(".file-list");
  if (!fileList) return;
  fileList.innerHTML = "";
  if (connection.sessionRecordings.length === 0) {
    fileList.innerHTML = '<li class="no-files">No recordings this session</li>';
    return;
  }
  connection.sessionRecordings.slice().reverse().forEach(rec => {
    const li = document.createElement("li");
    li.classList.add("file-item");
    li.innerHTML = `
      <span class="file-name" contenteditable="true" spellcheck="false" title="${rec.filename}">${rec.filename}</span>
      <div class="file-actions">
        <button class="file-action-btn view" data-filename="${rec.filename}" title="View recording">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        <button class="file-action-btn download" data-filename="${rec.filename}" title="Download CSV">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
        </button>
        <button class="file-action-btn delete" data-filename="${rec.filename}" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>`;
    li.querySelector(".view").addEventListener("click", (e) => {
      openRecordingViewer(e.currentTarget.dataset.filename);
    });
    li.querySelector(".download").addEventListener("click", (e) => {
      downloadFile(e.currentTarget.dataset.filename);
    });
    li.querySelector(".delete").addEventListener("click", (e) => {
      const fn = e.currentTarget.dataset.filename;
      connection.sessionRecordings = connection.sessionRecordings.filter(r => r.filename !== fn);
      deleteFile(fn);
      refreshDropup();
    });

    // Inline rename — click the filename text to edit, blur/Enter to confirm
    const nameEl = li.querySelector(".file-name");
    nameEl.addEventListener("click", (e) => e.stopPropagation()); // don't close dropup
    nameEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); nameEl.blur(); }
      if (e.key === "Escape") { nameEl.textContent = rec.filename; nameEl.blur(); }
    });
    nameEl.addEventListener("blur", () => {
      const newName = nameEl.textContent.trim();
      if (!newName || newName === rec.filename) { nameEl.textContent = rec.filename; return; }
      const finalName = newName.endsWith(".csv") ? newName : newName + ".csv";
      renameFile(rec.filename, finalName);
      rec.filename = finalName;
      nameEl.textContent = finalName;
      nameEl.title = finalName;
      li.querySelector(".view").dataset.filename     = finalName;
      li.querySelector(".download").dataset.filename = finalName;
      li.querySelector(".delete").dataset.filename   = finalName;
    });

    fileList.appendChild(li);
  });
}

// Toggle R-peak marker visibility on both live plot and recording viewer.
function togglePeaks() {
  if (!connection) return;
  connection.peaksVisible = !connection.peaksVisible;
  const peaksToggleBtn = document.querySelector('.btn .icon-eye')?.closest('.btn');

  if (connection.peaksVisible) {
    const c = getPeakColor();
    connection.peakLine.color = new ColorRGBA(c[0], c[1], c[2], 1);
    document.querySelectorAll('.btn').forEach(btn => {
      if (!btn.querySelector('.icon-eye')) return;
      btn.querySelector('.icon-eye').style.display     = 'block';
      btn.querySelector('.icon-eye-off').style.display = 'none';
      btn.setAttribute('aria-label', 'Hide peaks');
      btn.title = 'Hide peaks';
    });
  } else {
    connection.peakLine.color = new ColorRGBA(0, 0, 0, 0);
    document.querySelectorAll('.btn').forEach(btn => {
      if (!btn.querySelector('.icon-eye')) return;
      btn.querySelector('.icon-eye').style.display     = 'none';
      btn.querySelector('.icon-eye-off').style.display = 'block';
      btn.setAttribute('aria-label', 'Show peaks');
      btn.title = 'Show peaks';
    });
  }
  if (connection.viewerActive) { renderViewerFrame(); drawMinimap(); }
}

// Toggle the DC (baseline-wander) high-pass filter on/off.
function toggleDCFilter() {
  if (!connection) return;
  connection.dcEnabled = !connection.dcEnabled;
  document.querySelectorAll('.btn').forEach(btn => {
    const img = btn.querySelector('img[alt="DC filter"]');
    if (!img) return;
    if (connection.dcEnabled) {
      connection.dc0.reset();
      img.src = 'icons/dc-filter-icon.svg';
      btn.setAttribute('aria-label', 'Disable DC filter');
      btn.title = 'Disable DC filter';
    } else {
      img.src = 'icons/dc-filter-off-icon.svg';
      btn.setAttribute('aria-label', 'Enable DC filter');
      btn.title = 'Enable DC filter';
    }
  });
}

// ════════════════════════════════════════════════════════════
// THEME TOGGLE  (also called by the overlay button inside createDevicePanel)
// ════════════════════════════════════════════════════════════
function toggleTheme() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  if (isLight) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('theme', 'dark');
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('theme', 'light');
  }
  applyThemeColors();  // realtime-plot.js
  drawGrid();          // realtime-plot.js
  if (connection && connection.viewerActive) drawMinimap(); // recording-viewer.js
}
