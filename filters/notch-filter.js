// Band-Stop Butterworth IIR digital filter
// Sampling rate: 500.0 Hz, frequency: [48.0, 52.0] Hz
// Filter is order 2, implemented as second-order sections (biquads)
// Reference: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.butter.html
// Reference: https://github.com/upsidedownlabs/BioAmp-Filter-Designer

class NotchFilter {
  constructor() {
    this.z1_1 = 0; this.z2_1 = 0;
    this.z1_2 = 0; this.z2_2 = 0;
  }

  process(input) {
    let output = input;

    // Section 1
    this.x_1 = output - (-1.56858163 * this.z1_1) - (0.96424138 * this.z2_1);
    output    = 0.96508099 * this.x_1 + (-1.56202714 * this.z1_1) + (0.96508099 * this.z2_1);
    this.z2_1 = this.z1_1;
    this.z1_1 = this.x_1;

    // Section 2
    this.x_2 = output - (-1.61100358 * this.z1_2) - (0.96592171 * this.z2_2);
    output    = 1.0 * this.x_2 + (-1.61854514 * this.z1_2) + (1.0 * this.z2_2);
    this.z2_2 = this.z1_2;
    this.z1_2 = this.x_2;

    return output;
  }

  reset() {
    this.z1_1 = 0; this.z2_1 = 0;
    this.z1_2 = 0; this.z2_2 = 0;
  }
}
