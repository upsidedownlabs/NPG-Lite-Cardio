// High-Pass Butterworth IIR digital filter
// Sampling rate: 500.0 Hz, frequency: 0.5 Hz
// Filter is order 2, implemented as second-order sections (biquads)
// Reference: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.butter.html
// Reference: https://github.com/upsidedownlabs/BioAmp-Filter-Designer

class DCFilter {
  constructor() {
    this.z1_0 = 0.0;
    this.z2_0 = 0.0;
  }

  process(input) {
    let output = input;
    const x0   = output - (-1.99111429 * this.z1_0) - (0.99115360 * this.z2_0);
    output      = 0.99556697 * x0 + (-1.99113394 * this.z1_0) + (0.99556697 * this.z2_0);
    this.z2_0   = this.z1_0;
    this.z1_0   = x0;
    return output;
  }

  reset() {
    this.z1_0 = 0.0;
    this.z2_0 = 0.0;
  }
}
