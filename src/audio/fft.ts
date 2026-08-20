/**
 * Iterative radix-2 Cooley-Tukey FFT, in-place on separate real/imag arrays.
 *
 * The analyser runs one of these per STFT frame — roughly twenty thousand of
 * them for a four-minute track — so the twiddle factors and bit-reversal
 * permutation are precomputed once per size rather than per call.
 */
export class FFT {
  readonly size: number;
  private levels: number;
  private cosTable: Float32Array;
  private sinTable: Float32Array;
  private reverse: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    this.levels = Math.log2(size) | 0;

    const half = size / 2;
    this.cosTable = new Float32Array(half);
    this.sinTable = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((2 * Math.PI * i) / size);
    }

    this.reverse = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < this.levels; b++) r |= ((i >>> b) & 1) << (this.levels - 1 - b);
      this.reverse[i] = r;
    }
  }

  /** Transforms `re`/`im` in place. Both must be `size` long. */
  transform(re: Float32Array, im: Float32Array): void {
    const n = this.size;

    for (let i = 0; i < n; i++) {
      const j = this.reverse[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >>> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const c = this.cosTable[k];
          const s = this.sinTable[k];
          const l = j + half;
          const tre = re[l] * c + im[l] * s;
          const tim = -re[l] * s + im[l] * c;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }

  /** Magnitude spectrum of a real signal. Returns `size/2` bins. */
  magnitudes(input: Float32Array, out: Float32Array): void {
    const n = this.size;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    re.set(input.subarray(0, n));
    this.transform(re, im);
    const half = n >>> 1;
    for (let i = 0; i < half; i++) {
      out[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    }
  }
}

/** Periodic Hann window of the given length. */
export function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}
