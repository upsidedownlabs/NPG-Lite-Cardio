// Low-Pass Butterworth IIR digital filter
// Sampling rate: 500.0 Hz, frequency: 30.0 Hz
// Filter is order 2, implemented as second-order sections (biquads)
// Reference: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.butter.html
// Reference: https://github.com/upsidedownlabs/BioAmp-Filter-Designer

class ECGFilter {
  constructor() {
    this.z1 = 0;
    this.z2 = 0;
  }

  process(input) {
    let output = input;
    this.x1 = output - (-1.47548044 * this.z1) - (0.58691951 * this.z2);
    output   = 0.02785977 * this.x1 + (0.05571953 * this.z1) + (0.02785977 * this.z2);
    this.z2  = this.z1;
    this.z1  = this.x1;
    return output;
  }

  reset() {
    this.z1 = 0;
    this.z2 = 0;
  }
}
