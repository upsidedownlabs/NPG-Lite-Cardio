// Handles BLE connection, data streaming, and auto-disconnect logic.

async function connectBLE() {
  try {
    if (!navigator.bluetooth) {
      console.log("Web Bluetooth API not available.");
      return;
    }
    console.log("Requesting Bluetooth device...");
    connection.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "NPG" }],
      optionalServices: [SERVICE_UUID],
    });

    // Reset the UI if the device drops unexpectedly (out of range, powered off, etc.)
    connection.device.addEventListener('gattserverdisconnected', () => {
      if (!connection.connected) return;
      console.log("Device unexpectedly disconnected.");
      if (connection._dataCheckInterval) {
        clearInterval(connection._dataCheckInterval);
        connection._dataCheckInterval = null;
      }
      if (connection.isRecording) stopRecording();
      if (connection._notifHandler) {
        try { connection.dataChar.removeEventListener("characteristicvaluechanged", connection._notifHandler); } catch (e) { /* ignore */ }
        connection._notifHandler = null;
      }
      connection.connected = false;
      connection.streaming = false;
      updateButtonStates();
      connection.dataCh0.fill(0);
      connection.peakFlags.fill(0);
      connection.sampleIndex = 0;
      connection.panTompkins.reset();
      connection.notch0.reset();
      connection.ecg0.reset();
      connection.dc0.reset();
      resetBPMDisplay();
    });

    // gatt.connect() can resolve before the stack is fully ready.
    // Retry the full discovery block up to 3 times, resolving connection and re-connection issues.
    console.log("Connecting to GATT Server...");
    let service;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        connection.server = await connection.device.gatt.connect();
        if (!connection.server.connected) throw new Error("Not connected after gatt.connect()");
        console.log("Getting Service...");
        service = await connection.server.getPrimaryService(SERVICE_UUID);
        console.log("Getting Control Characteristic...");
        connection.controlChar = await service.getCharacteristic(CONTROL_CHAR_UUID);
        console.log("Getting Data Characteristic...");
        connection.dataChar = await service.getCharacteristic(DATA_CHAR_UUID);
        break;
      } catch (e) {
        try { connection.device?.gatt?.disconnect(); } catch (_) { /* ignore */ }
        if (attempt === 3) throw e;
        console.log(`Connection attempt ${attempt} failed, retrying in ${attempt}s...`);
        await new Promise(r => setTimeout(r, attempt * 1000));
      }
    }

    // Auto-detect packet format from device name:
    //   "NPG"      → 3CH  (7 bytes/sample, 70 bytes/block)
    //   "NPG 6CH"  → 6CH  (13 bytes/sample, 130 bytes/block)
    const devName = connection.device.name || '';
    if (devName.includes('6CH')) {
      connection.singleSampleLen = 13;
      connection.newPacketLen    = BLOCK_COUNT * 13; // 130
      console.log('6CH device detected — packet size: 130 bytes');
    } else {
      connection.singleSampleLen = 7;
      connection.newPacketLen    = BLOCK_COUNT * 7;  // 70
      console.log('3CH device detected — packet size: 70 bytes');
    }

    connection.connected = true;
    updateButtonStates();
    console.log("Device connected.");
    await startStream();
  } catch (error) {
    console.log("Error connecting: " + error);
  }
}

async function disconnectBLE() {
  // Clear the watchdog immediately so it doesn't fire during teardown
  if (connection._dataCheckInterval) {
    clearInterval(connection._dataCheckInterval);
    connection._dataCheckInterval = null;
  }
  try {
    if (connection.isRecording) stopRecording();
    if (connection.dataChar && connection._notifHandler) {
      connection.dataChar.removeEventListener("characteristicvaluechanged", connection._notifHandler);
      connection._notifHandler = null;
      try { await connection.dataChar.stopNotifications(); } catch (e) { /* ignore */ }
    }
    if (connection.controlChar) {
      try { await connection.controlChar.writeValue(new TextEncoder().encode("STOP")); } catch (e) { /* ignore */ }
    }
    if (connection.device && connection.device.gatt.connected) {
      try { await connection.device.gatt.disconnect(); } catch (e) { /* ignore */ }
    }
  } finally {
    // Always reset state even if any step above threw an error
    connection.connected    = false;
    connection.streaming    = false;
    connection.displayPaused = false;
    updateButtonStates();
    connection.dataCh0.fill(0);
    connection.peakFlags.fill(0);
    connection.sampleIndex = 0;
    connection.panTompkins.reset();
    connection.notch0.reset();
    connection.ecg0.reset();
    connection.dc0.reset();
    connection._sqiPower     = 0;
    connection.signalGood    = false;
    connection.signalRegular = false;
    connection._flatlineSamples = 0;
    resetBPMDisplay();
    console.log("Device disconnected.");
  }
}

async function startStream() {
  try {
    if (!connection.dataChar || !connection.controlChar) {
      console.log("Device not connected.");
      return;
    }
    // Reset detector and circular buffer so positions stay in sync
    connection.panTompkins.reset();
    connection.notch0.reset();
    connection.ecg0.reset();
    connection.dc0.reset();
    connection.sampleIndex      = 0;
    connection.dataCh0.fill(0);
    connection.peakFlags.fill(0);
    connection.prevSampleCounter = null;
    connection.droppedSamples    = 0;
    connection._sqiPower         = 0;
    connection.signalGood        = false;
    connection.signalRegular     = false;
    connection._flatlineSamples  = 0;

    console.log("Sending START command...");
    await connection.controlChar.writeValue(new TextEncoder().encode("START"));
    console.log("Starting notifications...");
    await connection.dataChar.startNotifications();

    // Guard against duplicate listeners if the browser returns a cached
    // characteristic object on reconnect within the same page session.
    if (connection._notifHandler) {
      connection.dataChar.removeEventListener("characteristicvaluechanged", connection._notifHandler);
    }
    connection._notifHandler = handleNotification; // defined in packet-parser.js
    connection.dataChar.addEventListener("characteristicvaluechanged", connection._notifHandler);
    connection.streaming = true;
    connection._samplesThisSecond = 0;

    // Watchdog: auto-disconnect if no samples received for 1 second
    if (connection._dataCheckInterval) clearInterval(connection._dataCheckInterval);
    connection._dataCheckInterval = setInterval(() => {
      if (connection.streaming && connection._samplesThisSecond === 0) {
        console.log("No data received for 1 s — auto-disconnecting.");
        clearInterval(connection._dataCheckInterval);
        connection._dataCheckInterval = null;
        disconnectBLE();
      }
      connection._samplesThisSecond = 0;
    }, 1000);

    console.log("Streaming started.");
  } catch (error) {
    console.log("Error starting stream: " + error);
  }
}

async function stopStream() {
  if (connection._dataCheckInterval) {
    clearInterval(connection._dataCheckInterval);
    connection._dataCheckInterval = null;
  }
  if (connection.dataChar && connection._notifHandler) {
    connection.dataChar.removeEventListener("characteristicvaluechanged", connection._notifHandler);
    try { await connection.dataChar.stopNotifications(); } catch (e) { /* ignore */ }
  }
  if (connection.controlChar) {
    try { await connection.controlChar.writeValue(new TextEncoder().encode("STOP")); } catch (e) { /* ignore */ }
  }
  connection.streaming = false;
  resetBPMDisplay();
  console.log("Streaming stopped.");
}

// Toggle between live-stream and paused state.
// When paused: stream stops but device stays connected.
// When resumed: stream restarts from scratch (filters reset via startStream).
//
// _streamBusy guard: rapid clicks would stack overlapping BLE calls
// (startNotifications while stopNotifications is still running), which
// deadlocks the WebBluetooth stack and crashes the browser tab.
async function toggleDisplayPause() {
  if (connection._streamBusy) return;
  connection._streamBusy = true;
  updateButtonStates();
  try {
    connection.displayPaused = !connection.displayPaused;
    if (connection.displayPaused) {
      await stopStream();
    } else {
      await startStream();
    }
  } finally {
    connection._streamBusy = false;
    updateButtonStates();
  }
}
