// Web version: captures a shared tab/window or the microphone in this page,
// reusing the extension's segmenter, AI calls and Markdown helpers.
import { PROVIDERS, LANGUAGES, DEFAULTS } from "../settings.js";
import { Segmenter, downsample, encodeWav, TARGET_RATE } from "../segmenter.js";
import { transcribe, translate, makeNotes, checkKey, looksHallucinated, AIError, setModelSwitchHandler } from "../ai.js";
import { sessionToMarkdown, renderMarkdown } from "../markdown.js";

const $ = (id) => document.getElementById(id);

// localStorage can throw (private mode, blocked storage); the app still works without it.
function readStore(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not saved */ }
}

let settings = { ...DEFAULTS, ...readStore("settings", {}) };
let session = { title: "", startedAt: 0, lines: [], notes: "" };
let live = null; // the running capture
let viewing = null; // a history entry shown instead of the live session
let pip = null; // Document Picture-in-Picture window

setModelSwitchHandler((chatModel) => { settings.chatModel = chatModel; writeStore("settings", settings); });

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function setStatus(state, text) {
  $("status").className = `status ${state}`;
  $("status").textContent = text;
  const on = state === "listening" || state === "starting";
  $("toggle").textContent = on ? "Stop" : "Start listening";
  $("toggle").classList.toggle("danger", on);
  document.querySelectorAll('input[name="source"]').forEach((r) => (r.disabled = on));
}

function showError(text) {
  $("error").textContent = text || "";
  $("error").hidden = !text;
}

// ---------- Capture ----------

async function getStream(source) {
  if (source === "mic") {
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  }
  if (!navigator.mediaDevices.getDisplayMedia) throw new Error("This browser can't share a tab's audio. Use Chrome or Edge on a computer, or pick Microphone.");
  // Chrome needs video in the request; we drop it straight away.
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: "include", selfBrowserSurface: "exclude" });
  stream.getVideoTracks().forEach((t) => t.stop());
  if (!stream.getAudioTracks().length) {
    throw new Error("No audio was shared. Start again and tick “Share tab audio” (or “Share system audio”) in the dialog.");
  }
  return stream;
}

async function start() {
  showError("");
  if (!settings.apiKey) { showError("Add your AI service key in Settings first."); openSettings(); return; }
  const source = document.querySelector('input[name="source"]:checked').value;
  setStatus("starting", "Starting…");
  let stream;
  try {
    stream = await getStream(source);
  } catch (e) {
    setStatus("idle", "Not listening");
    if (e.name !== "NotAllowedError") showError(e.message);
    return;
  }
  viewing = null;
  const track = stream.getAudioTracks()[0];
  session = { title: (source === "mic" ? "In person" : track.label || "Shared audio") + " · " + new Date().toLocaleString(), startedAt: Date.now(), lines: [], notes: "" };
  renderAll();

  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule("../recorder-worklet.js");
  const src = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, "tap-processor");
  src.connect(tap); // not to the speakers: the shared tab still plays on its own

  const s = { stream, ctx, tap, capturedMs: 0, nextId: 1, recent: [], queue: Promise.resolve(), inflight: 0, stopped: false, translations: new Set() };
  s.segmenter = new Segmenter({
    onSegment: (samples) => handleSegment(s, samples, s.capturedMs - (samples.length / TARGET_RATE) * 1000),
  });
  tap.port.onmessage = (e) => {
    if (s.stopped) return;
    const block = downsample(e.data, ctx.sampleRate, TARGET_RATE);
    s.capturedMs += (block.length / TARGET_RATE) * 1000;
    let peak = 0;
    for (let i = 0; i < block.length; i++) peak = Math.max(peak, Math.abs(block[i]));
    if (peak > 0.003) {
      s.lastSoundMs = s.capturedMs;
      if (s.silentWarned) { s.silentWarned = false; showError(""); }
    } else if (!s.silentWarned && s.capturedMs - (s.lastSoundMs || 0) > 6000) {
      s.silentWarned = true;
      showError(source === "mic" ? "The microphone isn't picking anything up." : "No sound is coming through. Is the video or meeting muted?");
    }
    s.segmenter.push(block);
  };
  track.addEventListener("ended", () => stop("Sharing stopped."));
  live = s;
  setStatus("listening", "Listening");
}

function handleSegment(s, samples, startMs) {
  if (s.inflight > 4) { showError("Falling behind – skipped a few seconds."); return; }
  const id = s.nextId++;
  const time = clock(startMs);
  const wav = new Blob([encodeWav(samples)], { type: "audio/wav" });
  s.inflight++;
  // Transcribe in parallel, publish in order.
  const heard = transcribe(settings, wav, s.recent.slice(-2).join(" ")).catch((e) => e);
  s.queue = s.queue.then(async () => {
    const text = await heard;
    s.inflight--;
    if (text instanceof Error) return fail(s, text, true);
    if (looksHallucinated(text)) return;
    s.recent.push(text);
    if (s.recent.length > 6) s.recent.shift();
    const line = { id, time, text, translation: "" };
    session.lines.push(line);
    onLine(line);
    if (settings.subtitleMode === "original" || s.translationBroken) return;
    const job = translate(settings, text, s.recent.slice(-4, -1))
      .then((t) => { line.translation = t; onLine(line); })
      .catch((e) => fail(s, e));
    s.translations.add(job);
    job.finally(() => s.translations.delete(job));
  });
}

function fail(s, e, hearing = false) {
  const kind = e instanceof AIError ? e.kind : "server";
  const fatal = kind === "invalidKey" || kind === "noKey" || (kind === "badModel" && hearing);
  if (!fatal && kind === "badModel") {
    if (!s.translationBroken) { s.translationBroken = true; showError("Translation is off: " + e.message); }
    return;
  }
  showError(e.message);
  if (fatal) stop();
}

async function stop(message = "") {
  const s = live;
  if (!s) return;
  live = null;
  s.segmenter.flush();
  s.stopped = true;
  s.tap.port.onmessage = null;
  s.stream.getTracks().forEach((t) => t.stop());
  setStatus("stopping", "Finishing the last lines…");
  await s.ctx.close().catch(() => {});
  await s.queue.catch(() => {});
  await Promise.allSettled([...s.translations]);
  setStatus("stopped", "Stopped");
  if (message) showError(message);
  archive();
}

// ---------- Rendering ----------

function current() { return viewing || session; }

function showSub(line) {
  const both = settings.subtitleMode === "both";
  const trText = settings.subtitleMode === "original" ? line.text : line.translation || line.text;
  const orig = both && line.translation && line.translation.trim() !== line.text.trim() ? line.text : "";
  for (const doc of [document, pip?.document].filter(Boolean)) {
    const tr = doc.getElementById("subTr"), og = doc.getElementById("subOrig");
    if (!tr) continue;
    tr.textContent = trText;
    og.textContent = orig;
    tr.classList.toggle("pending", !line.translation && settings.subtitleMode !== "original");
  }
  $("hint").hidden = true;
}

function onLine(line) {
  showSub(line);
  if (!viewing) renderLines();
}

function renderLines() {
  const s = current();
  const ol = $("lines");
  const pane = $("pane-transcript");
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 60;
  ol.replaceChildren(...s.lines.map((l) => {
    const li = document.createElement("li");
    const t = document.createElement("span"); t.className = "time"; t.textContent = l.time;
    const x = document.createElement("div"); x.className = "text"; x.textContent = l.text;
    li.append(t, x);
    if (l.translation && l.translation.trim() !== l.text.trim()) {
      const tr = document.createElement("div"); tr.className = "tr"; tr.textContent = l.translation;
      li.append(tr);
    }
    return li;
  }));
  $("empty").hidden = s.lines.length > 0;
  if (atBottom && !viewing) pane.scrollTop = pane.scrollHeight;
}

function renderNotes() {
  const s = current();
  $("notesBody").innerHTML = s.notes ? renderMarkdown(s.notes) : ""; // renderMarkdown escapes HTML
  $("makeNotes").hidden = !!viewing;
  $("makeNotes").textContent = s.notes ? "Rewrite notes" : "Write notes from the transcript";
}

function renderHistory() {
  const list = readStore("history", []);
  $("noHistory").hidden = list.length > 0;
  $("history").replaceChildren(...list.map((h) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = "hist";
    const title = document.createElement("strong"); title.textContent = h.title || "Session";
    const meta = document.createElement("span"); meta.textContent = `${h.lines.length} lines${h.notes ? " · notes" : ""}`;
    b.append(title, meta);
    b.onclick = () => { viewing = h; renderAll(); selectTab("transcript"); };
    li.append(b);
    return li;
  }));
}

function renderAll() {
  $("viewing").hidden = !viewing;
  if (viewing) $("viewingTitle").textContent = viewing.title;
  renderLines();
  renderNotes();
  renderHistory();
}

function selectTab(name) {
  document.querySelectorAll(".tabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.pane === name)));
  document.querySelectorAll(".pane").forEach((p) => (p.hidden = p.id !== `pane-${name}`));
}

// Saves the session to history, replacing its own earlier entry.
function archive() {
  if (!session.lines.length) return;
  const list = readStore("history", []).filter((h) => h.startedAt !== session.startedAt);
  list.unshift(structuredClone(session));
  writeStore("history", list.slice(0, 20));
  renderHistory();
}

// ---------- Floating subtitles (Document Picture-in-Picture, Chrome 116+) ----------

async function popout() {
  if (pip) { pip.close(); return; }
  pip = await window.documentPictureInPicture.requestWindow({ width: 640, height: 150 });
  const link = pip.document.createElement("link");
  link.rel = "stylesheet"; link.href = new URL("web.css", location.href).href;
  pip.document.head.append(link);
  pip.document.body.className = "pip";
  pip.document.body.innerHTML = '<div class="subs"><p id="subTr" class="sub-tr"></p><p id="subOrig" class="sub-orig"></p></div>';
  const last = session.lines.at(-1);
  if (last) showSub(last);
  $("popout").textContent = "Close floating subtitles";
  pip.addEventListener("pagehide", () => { pip = null; $("popout").textContent = "Float subtitles over other windows"; });
}

// ---------- Settings ----------

function fillSettings() {
  $("provider").value = settings.provider;
  for (const k of ["apiKey", "baseUrl", "hearModel", "chatModel", "subtitleMode", "wordList"]) $(k).value = settings[k] ?? "";
  const p = PROVIDERS[settings.provider];
  $("keyLink").hidden = !p?.keyUrl;
  if (p?.keyUrl) $("keyLink").href = p.keyUrl;
  $("checkResult").textContent = "";
}

function readForm() {
  const next = { ...settings, provider: $("provider").value };
  for (const k of ["apiKey", "baseUrl", "hearModel", "chatModel", "subtitleMode", "wordList"]) next[k] = $(k).value.trim();
  return next;
}

function openSettings() { fillSettings(); $("settings").showModal(); }

// ---------- Wiring ----------

for (const [code, name] of LANGUAGES) $("targetLang").add(new Option(name, code));
$("targetLang").value = settings.targetLang;
$("targetLang").onchange = () => { settings.targetLang = $("targetLang").value; writeStore("settings", settings); };

for (const [id, p] of Object.entries(PROVIDERS)) $("provider").add(new Option(p.label, id));
$("provider").onchange = () => {
  const p = PROVIDERS[$("provider").value];
  $("baseUrl").value = p.baseUrl; $("hearModel").value = p.hearModel; $("chatModel").value = p.chatModel;
  $("keyLink").hidden = !p.keyUrl;
  if (p.keyUrl) $("keyLink").href = p.keyUrl;
  if (!p.baseUrl) $("settings").querySelector("details").open = true;
};
$("openSettings").onclick = openSettings;
$("save").onclick = () => {
  const next = readForm();
  if (next.baseUrl && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(next.baseUrl)) {
    $("checkResult").textContent = "Base URL must start with https:// (or http://localhost).";
    return;
  }
  settings = next;
  writeStore("settings", settings);
  $("settings").close();
};
$("check").onclick = async () => {
  const trial = readForm();
  $("checkResult").textContent = "Checking…";
  try {
    const r = await checkKey(trial);
    if (r.replaced) { $("chatModel").value = r.chatModel || ""; }
    $("checkResult").textContent = r.replaced ? `Key works. Switched the chat model to ${r.chatModel}.` : "Key works.";
  } catch (e) {
    $("checkResult").textContent = e.message;
  }
};

$("toggle").onclick = () => (live ? stop() : start());
$("backLive").onclick = () => { viewing = null; renderAll(); };
document.querySelectorAll(".tabs [role=tab]").forEach((b) => (b.onclick = () => selectTab(b.dataset.pane)));

$("makeNotes").onclick = async () => {
  if (!session.lines.length) { $("notesBody").textContent = "Nothing has been transcribed yet."; return; }
  $("makeNotes").disabled = true;
  $("makeNotes").textContent = "Writing notes…";
  try {
    session.notes = await makeNotes(settings, session.lines.map((l) => ({ time: l.time, text: l.text })), session.title);
    archive();
  } catch (e) {
    showError(e.message);
  }
  $("makeNotes").disabled = false;
  renderNotes();
};

$("copy").onclick = async () => {
  try { await navigator.clipboard.writeText(sessionToMarkdown(current())); $("copy").textContent = "Copied"; }
  catch { $("copy").textContent = "Couldn't copy"; }
  setTimeout(() => ($("copy").textContent = "Copy"), 1500);
};
$("download").onclick = () => {
  const s = current();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([sessionToMarkdown(s)], { type: "text/markdown" }));
  a.download = `${(s.title || "session").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

if ("documentPictureInPicture" in window) {
  $("popout").hidden = false;
  $("popout").onclick = () => popout().catch((e) => showError(e.message));
}
window.addEventListener("beforeunload", (e) => { if (live) e.preventDefault(); });

renderAll();
if (!settings.apiKey) openSettings();
