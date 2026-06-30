// Real-time ECG rendering — WebGL plot, animation loop, grid, and theme colours.

// Destructure from the UMD bundle at file scope so all functions below can use these directly.
// webglplot.umd.js is loaded before this file so WebglPlotBundle is already defined.
const { WebglPlot, ColorRGBA, WebglLine } = WebglPlotBundle;

const PEAK_HALF_WIDTH = 7;   // ±7 samples (~28 ms) either side of each R-peak
const GAP_WIDTH       = 24;  // blank samples ahead of write head (~48 ms sweep gap)

// Reused scratch buffer for building peak marker shapes each frame (avoids allocation)
let _peakDisplay = null; // Float32Array(NUM_POINTS), allocated in initPlot()

function getLineColor() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  // Dark : #00E676 bright lime-green (cardiac monitor standard, IEC 60601-1-8)
  // Light: #1565C0 dark blue
  return isLight ? [0.082, 0.396, 0.753] : [0.0, 0.902, 0.463];
}

function getPeakColor() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  // Dark : #FF1744 vivid red  |  Light: #C62828 deep red
  return isLight ? [0.776, 0.157, 0.157] : [1.0, 0.090, 0.267];
}

// Apply both colours live — called on init and on every theme toggle.
function applyThemeColors() {
  if (!connection || !connection.line0 || !connection.peakLine) return;
  const lc = getLineColor();
  connection.line0.color = new ColorRGBA(lc[0], lc[1], lc[2], 1);
  if (connection.peaksVisible) {
    const pc = getPeakColor();
    connection.peakLine.color = new ColorRGBA(pc[0], pc[1], pc[2], 1);
  }
}

// ECG paper grid — small square = 0.04 s, large = 0.20 s. Recomputed on resize.
function drawGrid() {
  const cont = connection && connection.elements ? connection.elements.canvasContainer : null;
  if (!cont) return;
  const w       = cont.clientWidth;
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const sm = (w / NUM_POINTS) * 20;  // px per small square (0.04 s)
  const lg = sm * 5;                 // px per large square (0.20 s)
  // Dark: whitish-grey — neutral, no colour conflict with the green trace
  // Light: blackish-grey — clear on white background
  const major = isLight ? 'rgba(80,80,80,0.18)'  : 'rgba(155,155,155,0.15)';
  const minor = isLight ? 'rgba(80,80,80,0.09)'  : 'rgba(175,175,175,0.06)';
  cont.style.backgroundImage = [
    `repeating-linear-gradient(to right,  ${major} 0, ${major} 1px, transparent 1px, transparent ${lg}px)`,
    `repeating-linear-gradient(to bottom, ${major} 0, ${major} 1px, transparent 1px, transparent ${lg}px)`,
    `repeating-linear-gradient(to right,  ${minor} 0, ${minor} 1px, transparent 1px, transparent ${sm}px)`,
    `repeating-linear-gradient(to bottom, ${minor} 0, ${minor} 1px, transparent 1px, transparent ${sm}px)`,
  ].join(', ');
}

function initPlot(canvas) {
  _peakDisplay = new Float32Array(NUM_POINTS);

  connection.wglp = new WebglPlot(canvas);

  // ECG waveform line
  const lc = getLineColor();
  connection.line0 = new WebglLine(new ColorRGBA(lc[0], lc[1], lc[2], 1), NUM_POINTS);
  connection.line0.lineWidth = 40;  // thick for clinical legibility (IEC 60601-1-8)
  connection.line0.arrangeX();
  connection.wglp.addLine(connection.line0);

  // R-peak marker line
  const pc = getPeakColor();
  connection.peakLine = new WebglLine(new ColorRGBA(pc[0], pc[1], pc[2], 1), NUM_POINTS);
  connection.peakLine.lineWidth = 4;
  connection.peakLine.arrangeX();
  connection.wglp.addLine(connection.peakLine);
}

// Animation loop — runs at ~60 Hz; holds the last frame when paused or viewer is open.
function animate() {
  requestAnimationFrame(animate);
  if (!connection || !connection.dataCh0) return;

  if (connection.viewerActive || connection.displayPaused) {
    connection.wglp.update();
    return;
  }

  const d = connection.dataCh0;

  // Compute signal baseline (mean) — used only for peak marker vertical positioning
  let baselineSum = 0;
  for (let i = 0; i < NUM_POINTS; i++) baselineSum += d[i];
  const baseline = baselineSum / NUM_POINTS;

  // Build ECG line and ⊓-shaped peak markers in a single pass.
  // NaN → WebGL skips that segment, so only the ⊓ shape renders (no connectors).
  // Samples inside the sweep gap are NaN so the line breaks at the write head.
  _peakDisplay.fill(NaN);
  const capHeight = 0.08;
  const head = connection.sampleIndex;

  for (let i = 0; i < NUM_POINTS; i++) {
    const inGap = ((i - head + NUM_POINTS) % NUM_POINTS) < GAP_WIDTH;
    connection.line0.setY(i, inGap ? NaN : d[i]);

    if (connection.peakFlags[i]) {
      const y = d[i];
      if (y > baseline) {
        const topY = y;
        const botY = y - capHeight;
        const lo   = Math.max(0, i - PEAK_HALF_WIDTH);
        const hi   = Math.min(NUM_POINTS - 1, i + PEAK_HALF_WIDTH);
        _peakDisplay[lo] = botY;
        for (let j = lo + 1; j < hi; j++) _peakDisplay[j] = topY;
        _peakDisplay[hi] = botY;
      }
    }
  }

  // Write peak markers — no gap blanking so markers persist until data overwrites them
  for (let i = 0; i < NUM_POINTS; i++) {
    connection.peakLine.setY(i, _peakDisplay[i]);
  }

  connection.wglp.update();
}
