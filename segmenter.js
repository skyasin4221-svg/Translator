// Splits a stream of audio into speech segments at pauses, and encodes WAV.
// Pure logic with no browser APIs, so it can be tested in Node.

export const TARGET_RATE = 16000;

export function downsample(input, fromRate, toRate = TARGET_RATE) {
  if (fromRate === toRate) return Float32Array.from(input);
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : input[start] || 0;
  }
  return out;
}

function rms(samples) {
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  return Math.sqrt(s / Math.max(1, samples.length));
}

export class Segmenter {
  constructor({
    rate = TARGET_RATE,
    frameMs = 30,
    minSpeechMs = 600,
    pauseMs = 650,
    maxSegmentMs = 12000,
    minSegmentMs = 1200,
    onSegment,
  } = {}) {
    this.rate = rate;
    this.frameLen = Math.round((rate * frameMs) / 1000);
    this.frameMs = frameMs;
    this.minSpeechMs = minSpeechMs;
    this.pauseMs = pauseMs;
    this.maxSegmentMs = maxSegmentMs;
    this.minSegmentMs = minSegmentMs;
    this.onSegment = onSegment;
    this.pending = new Float32Array(0);
    this.frames = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    this.noise = 0.004; // adaptive noise floor
    this.preroll = []; // a little audio before speech starts
  }

  push(samples) {
    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    let i = 0;
    for (; i + this.frameLen <= merged.length; i += this.frameLen) {
      this.frame(merged.subarray(i, i + this.frameLen));
    }
    this.pending = merged.slice(i);
  }

  frame(f) {
    const level = rms(f);
    const isSpeech = level > Math.max(0.01, this.noise * 3);
    if (!isSpeech) this.noise = this.noise * 0.95 + level * 0.05;
    const copy = Float32Array.from(f);

    if (this.frames.length === 0 && !isSpeech) {
      this.preroll.push(copy);
      if (this.preroll.length > 10) this.preroll.shift();
      return;
    }
    if (this.frames.length === 0) {
      this.frames.push(...this.preroll);
      this.preroll = [];
    }
    this.frames.push(copy);
    if (isSpeech) {
      this.speechMs += this.frameMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += this.frameMs;
    }
    const lengthMs = this.frames.length * this.frameMs;
    const pauseEnds = this.silenceMs >= this.pauseMs && lengthMs >= this.minSegmentMs;
    if (pauseEnds || lengthMs >= this.maxSegmentMs) this.cut();
    else if (this.silenceMs >= this.pauseMs * 2 && this.speechMs < this.minSpeechMs) this.reset();
  }

  cut() {
    if (this.speechMs >= this.minSpeechMs) {
      const total = this.frames.reduce((n, f) => n + f.length, 0);
      const out = new Float32Array(total);
      let o = 0;
      for (const f of this.frames) { out.set(f, o); o += f.length; }
      this.onSegment?.(out, this.speechMs);
    }
    this.reset();
  }

  reset() {
    this.frames = [];
    this.speechMs = 0;
    this.silenceMs = 0;
  }

  flush() {
    if (this.frames.length) this.cut();
  }
}

export function encodeWav(samples, rate = TARGET_RATE) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}
