// Captures the tab's audio, keeps it audible, cuts it at pauses and sends each
// piece to the AI service. Results go back to the service worker.
import { Segmenter, downsample, encodeWav, TARGET_RATE } from "./segmenter.js";
import { transcribe, translate, looksHallucinated, AIError, setModelSwitchHandler } from "./ai.js";

setModelSwitchHandler((chatModel) => send({ type: "modelSwitch", chatModel }));

let session = null;

function send(msg) {
  chrome.runtime.sendMessage({ target: "background", ...msg }).catch(() => {});
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

async function start(streamId, settings) {
  await stop();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false,
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule("recorder-worklet.js");
  const source = ctx.createMediaStreamSource(stream);
  // Capturing a tab mutes it, so play it back so the user still hears it.
  source.connect(ctx.destination);
  const tap = new AudioWorkletNode(ctx, "tap-processor");
  source.connect(tap);

  const s = {
    stream, ctx, tap, settings,
    startedAt: Date.now(),
    capturedMs: 0,
    nextId: 1,
    recent: [], // recent original lines, for context
    queue: Promise.resolve(),
    inflight: 0,
    stopped: false,
    fatal: false,
    translations: new Set(),
  };
  s.segmenter = new Segmenter({
    onSegment: (samples) => {
      const endMs = s.capturedMs;
      const startMs = endMs - (samples.length / TARGET_RATE) * 1000;
      handleSegment(s, samples, startMs);
    },
  });
  tap.port.onmessage = (e) => {
    if (s.stopped) return;
    const block = downsample(e.data, ctx.sampleRate, TARGET_RATE);
    s.capturedMs += (block.length / TARGET_RATE) * 1000;
    // Warn when the tab is silent (often a muted video or player).
    let peak = 0;
    for (let i = 0; i < block.length; i++) peak = Math.max(peak, Math.abs(block[i]));
    if (peak > 0.003) {
      s.lastSoundMs = s.capturedMs;
      if (s.silentWarned) { s.silentWarned = false; send({ type: "status", state: "listening", message: "" }); }
    } else if (!s.silentWarned && s.capturedMs - (s.lastSoundMs || 0) > 6000) {
      s.silentWarned = true;
      send({ type: "status", state: "listening", message: "No sound is coming from this tab. Is the video or meeting muted?" });
    }
    s.segmenter.push(block);
  };
  stream.getAudioTracks()[0].addEventListener("ended", () => {
    send({ type: "status", state: "stopped", message: "The tab stopped sharing audio." });
    stop();
  });
  session = s;
  send({ type: "status", state: "listening" });
}

function handleSegment(s, samples, startMs) {
  if (s.fatal) return;
  if (s.inflight > 4) {
    send({ type: "status", state: "listening", message: "Falling behind – skipped a few seconds." });
    return;
  }
  const id = s.nextId++;
  const time = clock(startMs);
  const wav = new Blob([encodeWav(samples)], { type: "audio/wav" });
  s.inflight++;
  // Transcribe now (in parallel), but publish lines in order.
  const heard = transcribe(s.settings, wav, s.recent.slice(-2).join(" ")).catch((e) => e);
  s.queue = s.queue.then(async () => {
    const result = await heard;
    s.inflight--;
    if (s.stopped && !s.draining) return;
    if (result instanceof Error) return reportError(s, result, true);
    if (looksHallucinated(result)) return;
    s.recent.push(result);
    if (s.recent.length > 6) s.recent.shift();
    send({ type: "line", id, time, text: result });
    if (s.settings.subtitleMode === "original" || s.translationBroken) return;
    const context = s.recent.slice(-4, -1);
    const job = translate(s.settings, result, context)
      .then((t) => send({ type: "translation", id, translation: t }))
      .catch((e) => reportError(s, e));
    s.translations.add(job);
    job.finally(() => s.translations.delete(job));
  });
}

function reportError(s, e, hearing = false) {
  const kind = e instanceof AIError ? e.kind : "server";
  // A broken translation model shouldn't stop the transcript.
  const fatal = kind === "invalidKey" || kind === "noKey" || (kind === "badModel" && hearing);
  if (!fatal && kind === "badModel") {
    if (s.translationBroken) return;
    s.translationBroken = true;
    send({ type: "status", state: "listening", message: "Translation is off: " + e.message });
    return;
  }
  send({ type: fatal ? "status" : "status", state: fatal ? "error" : "listening", kind, message: e.message });
  if (fatal) {
    s.fatal = true;
    stop();
  }
}

async function stop() {
  const s = session;
  if (!s) return;
  session = null;
  s.draining = true;
  s.segmenter.flush();
  s.stopped = true;
  try { s.tap.port.onmessage = null; } catch { /* ignore */ }
  s.stream.getTracks().forEach((t) => t.stop());
  await s.ctx.close().catch(() => {});
  // Let the last pieces finish so the transcript is complete.
  await s.queue.catch(() => {});
  await Promise.allSettled([...s.translations]);
  send({ type: "status", state: "stopped" });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "start") {
    start(msg.streamId, msg.settings)
      .then(() => reply({ ok: true }))
      .catch((e) => {
        send({ type: "status", state: "error", kind: "capture", message: "Couldn't capture this tab's audio: " + e.message });
        reply({ ok: false, error: e.message });
      });
    return true;
  }
  if (msg.type === "stop") {
    stop().then(() => reply({ ok: true }));
    return true;
  }
  if (msg.type === "settings" && session) {
    session.settings = msg.settings;
  }
});
