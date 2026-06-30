// ECG recording — start, stop, flush batches to IndexedDB, and delete recordings.

// Open (and cache) the IndexedDB connection.
async function openRecordingDB() {
  if (connection._db) return connection._db;
  connection._db = await new Promise((res, rej) => {
    const req = indexedDB.open('ECGRecordings', 3);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('ECGRecordings'))
        db.createObjectStore('ECGRecordings', { keyPath: 'filename' });
      // Append-only batch store — each batch is an independent record
      if (!db.objectStoreNames.contains('ECGBatches')) {
        const store = db.createObjectStore('ECGBatches', { keyPath: 'batchKey' });
        store.createIndex('filename', 'filename', { unique: false });
      }
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
  return connection._db;
}

// Snapshot the current recording buffer and write it to IndexedDB as one batch.
// Uses a serial promise queue (_writeQueue) so overlapping flush calls cannot
// interleave and overwrite each other's data.
function flushRecordingData() {
  if (!connection.recordingData.length) return;
  const rows       = [...connection.recordingData]; // snapshot; stream continues accumulating
  connection.recordingData = [];
  const filename   = connection.recordingFilename;
  const batchIndex = connection._batchIndex++;
  const batchKey   = `${filename}|${String(batchIndex).padStart(8, '0')}`;

  connection._writeQueue = (connection._writeQueue || Promise.resolve())
    .then(async () => {
      try {
        const db = await openRecordingDB();
        await new Promise((res, rej) => {
          const req = db.transaction('ECGBatches', 'readwrite')
            .objectStore('ECGBatches').put({ batchKey, filename, batchIndex, rows });
          req.onsuccess = () => res();
          req.onerror   = () => rej(req.error);
        });
      } catch (e) {
        console.error('IDB write failed:', e);
      }
    });
}

function startRecording() {
  connection.isRecording        = true;
  connection.recordingStartTime = Date.now();
  connection.recordingData      = [];
  connection.totalRecordedSamples = 0;
  connection._batchIndex        = 0;

  // Timestamp-based filename: ECG-YYYYMMDD-HHMMSS.csv
  const now = new Date();
  connection.recordingFilename =
    `ECG-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-` +
    `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}.csv`;

  // Show recording timer via DOM refs stored on connection.elements
  const timerEl = connection.elements.recordingTimer;
  timerEl.querySelector('span').textContent = '00:00:00';
  timerEl.style.display = 'flex';

  // Update timer every second; also re-evaluates stop-button enable at 12 s
  connection.recordingTimer = setInterval(() => {
    const elapsed = Date.now() - connection.recordingStartTime;
    const h = Math.floor(elapsed / 3600000);
    const m = Math.floor((elapsed % 3600000) / 60000);
    const s = Math.floor((elapsed % 60000) / 1000);
    timerEl.querySelector('span').textContent =
      `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    updateButtonStates();
  }, 1000);

  updateButtonStates();
  console.log("Recording started:", connection.recordingFilename);
}

function stopRecording() {
  connection.isRecording = false;
  const durationMs = Date.now() - connection.recordingStartTime;

  // Flush any remaining buffered samples
  if (connection.recordingData.length > 0) flushRecordingData();

  // Hide timer
  connection.elements.recordingTimer.style.display = 'none';
  clearInterval(connection.recordingTimer);
  connection.recordingTimer = null;
  updateButtonStates();

  // Discard recordings shorter than MIN_RECORDING_MS — clean up any batches
  // already written to IDB before we decided to discard
  if (durationMs < MIN_RECORDING_MS) {
    const fn = connection.recordingFilename;
    connection._writeQueue = (connection._writeQueue || Promise.resolve())
      .then(() => deleteFile(fn));
    showToast(
      `<strong style="color:var(--primary)">Recording too short</strong>` +
      `Minimum duration is ${MIN_RECORDING_MS / 1000} s — recording discarded.`
    );
    console.log("Recording discarded (too short):", fn);
    return;
  }

  // Format duration as MM:SS
  const secs = Math.floor(durationMs / 1000);
  const mm   = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss   = String(secs % 60).padStart(2, '0');
  const durationStr = `${mm}:${ss}`;

  // Add to in-session list and refresh the recordings dropup
  connection.sessionRecordings.push({
    filename: connection.recordingFilename,
    duration: durationStr,
    samples:  connection.totalRecordedSamples,
  });
  refreshDropup();

  // Non-blocking save confirmation
  showToast(
    `<strong>✓ Recording saved</strong>` +
    `${connection.recordingFilename}<br>` +
    `Duration: ${durationStr} &nbsp;•&nbsp; Samples: ${connection.totalRecordedSamples.toLocaleString()}`
  );
  console.log("Recording stopped:", connection.recordingFilename, "samples:", connection.totalRecordedSamples);
}

function toggleRecording() {
  if (connection.isRecording) {
    const elapsed = Date.now() - connection.recordingStartTime;
    if (elapsed < MIN_RECORDING_MS) {
      // Show a brief tooltip near the button (mirrors the PC hover title on touch devices)
      const btn = document.querySelector('.recording-locked');
      if (btn) {
        btn.classList.add('show-tip');
        clearTimeout(btn._tipTimer);
        btn._tipTimer = setTimeout(() => btn.classList.remove('show-tip'), 2000);
      }
      return;
    }
    stopRecording();
  } else {
    startRecording();
  }
}

// On page load, read all ECGBatches from IndexedDB and restore them into
// connection.sessionRecordings so recordings survive page reloads.
async function loadRecordingsFromDB() {
  try {
    const db = await openRecordingDB();
    const batches = await new Promise((res, rej) => {
      const req = db.transaction('ECGBatches', 'readonly')
        .objectStore('ECGBatches').getAll();
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });

    // Aggregate sample counts per filename
    const fileMap = new Map(); // filename → total sample count
    for (const batch of batches) {
      const prev = fileMap.get(batch.filename) || 0;
      fileMap.set(batch.filename, prev + (batch.rows ? batch.rows.length : 0));
    }

    // Convert to sorted list (oldest first, by embedded timestamp in filename)
    const existing = new Set(connection.sessionRecordings.map(r => r.filename));
    fileMap.forEach((totalSamples, filename) => {
      if (existing.has(filename)) return; // already tracked (e.g. just stopped)
      const secs = Math.round(totalSamples / SAMPLE_RATE);
      const mm   = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss   = String(secs % 60).padStart(2, '0');
      connection.sessionRecordings.push({
        filename,
        duration: `${mm}:${ss}`,
        samples:  totalSamples,
      });
    });

    // Sort by filename (timestamps embedded: ECG-YYYYMMDD-HHMMSS.csv)
    connection.sessionRecordings.sort((a, b) => a.filename.localeCompare(b.filename));

    if (fileMap.size > 0) refreshDropup();
  } catch (e) {
    console.error('loadRecordingsFromDB failed:', e);
  }
}

// Rename all IDB batch records from oldName to newName.
// Reads all batches first, then deletes the old keys and re-inserts with the new filename.
async function renameFile(oldName, newName) {
  try {
    const db = await openRecordingDB();
    const batches = await new Promise((res, rej) => {
      const req = db.transaction('ECGBatches', 'readonly')
        .objectStore('ECGBatches').index('filename').getAll(IDBKeyRange.only(oldName));
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
    if (!batches.length) return;
    await new Promise((res, rej) => {
      const tx = db.transaction(['ECGBatches', 'ECGRecordings'], 'readwrite');
      tx.oncomplete = () => res();
      tx.onerror    = () => rej(tx.error);
      const batchStore = tx.objectStore('ECGBatches');
      for (const batch of batches) {
        batchStore.delete(batch.batchKey);
        const newKey = `${newName}|${String(batch.batchIndex).padStart(8, '0')}`;
        batchStore.put({ ...batch, batchKey: newKey, filename: newName });
      }
      tx.objectStore('ECGRecordings').delete(oldName);
    });
    console.log('Renamed:', oldName, '→', newName);
  } catch (e) {
    console.error('Rename failed:', e);
  }
}

// Delete all IDB data for a given filename (both the batch store and the legacy store).
async function deleteFile(filename) {
  try {
    const db = await openRecordingDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(['ECGBatches', 'ECGRecordings'], 'readwrite');
      tx.oncomplete = () => res();
      tx.onerror    = () => rej(tx.error);
      tx.onabort    = () => rej(tx.error);
      // Delete all batch records for this filename via cursor
      const batchStore = tx.objectStore('ECGBatches');
      const req = batchStore.index('filename').openKeyCursor(IDBKeyRange.only(filename));
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) { batchStore.delete(cursor.primaryKey); cursor.continue(); }
      };
      // Also remove from legacy store if present
      tx.objectStore('ECGRecordings').delete(filename);
    });
    console.log('Deleted:', filename);
  } catch (e) {
    console.error('Delete failed:', e);
  }
}
