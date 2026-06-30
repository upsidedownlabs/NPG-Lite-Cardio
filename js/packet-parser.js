// Packet structure for the NPG-Lite BLE device
//
// The device sends data in one of two formats depending on channel count:
//
//   3CH device — 7 bytes per sample, 10 samples per BLE notification = 70 bytes
//     Byte 0      : sample counter (uint8, wraps 0-255)
//     Bytes 1-2   : CH0 raw ADC (int16, big-endian)
//     Bytes 3-4   : CH1 raw ADC (int16, big-endian)
//     Bytes 5-6   : CH2 raw ADC (int16, big-endian)
//
//   6CH device — 13 bytes per sample, 10 samples per BLE notification = 130 bytes
//     Byte 0      : sample counter (uint8, wraps 0-255)
//     Bytes 1-12  : CH0-CH5 raw ADC values (int16, big-endian each)
//
// Only CH0 is used for ECG display; all other channels are ignored.
// The packet format is auto-detected after connect from the device name (see connection.js).

// Convert a raw 12-bit ADC value (0-4095) to a normalised float in [-1, +1].
// The ADC midpoint (2048) maps to 0; full scale maps to ±1.
function normalizeSample(rawADC) {
  const ADC_MAX = 4095;
  return (rawADC - ADC_MAX / 2) * (2 / ADC_MAX);
}

// BLE notification handler: receives a block or single-sample DataView from the device,
// splits it into individual per-sample DataViews, and forwards each to processSample()
// in signal-processor.js for the full signal pipeline.
function handleNotification(event) {
  const value = event.target.value;
  if (value.byteLength === connection.newPacketLen) {
    // Block packet — split into BLOCK_COUNT individual samples
    // Use offset DataView (no buffer copy) to correctly handle value.byteOffset
    for (let i = 0; i < connection.newPacketLen; i += connection.singleSampleLen) {
      processSample(new DataView(value.buffer, value.byteOffset + i, connection.singleSampleLen));
    }
  } else if (value.byteLength === connection.singleSampleLen) {
    // Single-sample packet
    processSample(value);
  } else {
    console.log("Unexpected packet length: " + value.byteLength);
  }
}
