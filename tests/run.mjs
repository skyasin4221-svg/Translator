// Tests for the parts that don't need a browser: node tests/run.mjs
import assert from "node:assert/strict";
import { Segmenter, encodeWav, downsample, TARGET_RATE } from "../segmenter.js";
import { sessionToMarkdown, renderMarkdown } from "../markdown.js";
import { looksHallucinated } from "../ai.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok -", name); }

function tone(ms, amp = 0.2, freq = 220) {
  const n = Math.round((TARGET_RATE * ms) / 1000);
  return Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / TARGET_RATE));
}
const silence = (ms) => new Float32Array(Math.round((TARGET_RATE * ms) / 1000));
function feed(seg, parts) { for (const p of parts) for (let i = 0; i < p.length; i += 4096) seg.push(p.subarray(i, i + 4096)); }

test("cuts two phrases at the pause between them", () => {
  const out = [];
  const seg = new Segmenter({ onSegment: (s) => out.push(s.length / TARGET_RATE) });
  feed(seg, [silence(1000), tone(2000), silence(1000), tone(1500), silence(1200)]);
  assert.equal(out.length, 2);
  assert.ok(out[0] > 2 && out[0] < 3.3, `first ${out[0]}`);
});

test("silence alone produces nothing", () => {
  const out = [];
  const seg = new Segmenter({ onSegment: (s) => out.push(s) });
  feed(seg, [silence(10000)]);
  seg.flush();
  assert.equal(out.length, 0);
});

test("short click is ignored", () => {
  const out = [];
  const seg = new Segmenter({ onSegment: (s) => out.push(s) });
  feed(seg, [silence(500), tone(150), silence(3000)]);
  seg.flush();
  assert.equal(out.length, 0);
});

test("long speech is split at the max length", () => {
  const out = [];
  const seg = new Segmenter({ onSegment: (s) => out.push(s.length / TARGET_RATE) });
  feed(seg, [tone(30000)]);
  seg.flush();
  assert.equal(out.length, 3);
  assert.ok(out.every((d) => d <= 12.1));
});

test("flush emits the last phrase", () => {
  const out = [];
  const seg = new Segmenter({ onSegment: (s) => out.push(s) });
  feed(seg, [tone(2000)]);
  assert.equal(out.length, 0);
  seg.flush();
  assert.equal(out.length, 1);
});

test("WAV header is valid 16 kHz mono PCM", () => {
  const buf = encodeWav(tone(100));
  const v = new DataView(buf);
  const str = (o) => String.fromCharCode(...new Uint8Array(buf, o, 4));
  assert.equal(str(0), "RIFF"); assert.equal(str(8), "WAVE"); assert.equal(str(36), "data");
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(buf.byteLength, 44 + 1600 * 2);
});

test("downsample 48k to 16k", () => {
  assert.equal(downsample(new Float32Array(4800), 48000).length, 1600);
});

test("hallucination filter", () => {
  assert.ok(looksHallucinated("Thank you for watching!"));
  assert.ok(looksHallucinated("   "));
  assert.ok(!looksHallucinated("Thank you for joining today, let's start with sales."));
});

test("markdown export and safe rendering", () => {
  const md = sessionToMarkdown({ title: "Call", startedAt: 0, notes: "## Summary\nGood", lines: [{ time: "0:01", text: "Hola", translation: "Hello" }] });
  assert.match(md, /\*\*\[0:01\]\*\* Hola/);
  assert.match(md, /> Hello/);
  const html = renderMarkdown("## Hi\n- <script>x</script> **b**");
  assert.ok(!html.includes("<script>"));
  assert.match(html, /<strong>b<\/strong>/);
});

console.log(`\n${passed} passed`);
