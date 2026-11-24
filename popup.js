import { LANGUAGES, loadSettings, saveSettings } from "./settings.js";
import { sessionToMarkdown, renderMarkdown } from "./markdown.js";

const $ = (id) => document.getElementById(id);
let session = { status: { state: "idle" }, lines: [], notes: "", title: "" };
let activeTab = null;
let viewing = null; // a history entry being shown instead of the live session

function bg(type, extra = {}) {
  return chrome.runtime.sendMessage({ target: "background", type, ...extra });
}

function showError(text) {
  $("error").textContent = text || "";
  $("error").hidden = !text;
}

const STATUS_TEXT = {
  idle: "Not listening",
  starting: "Starting…",
  listening: "Listening",
  stopped: "Stopped",
  error: "Problem",
  youtube: "Showing YouTube's captions",
  "youtube-loading": "Loading YouTube's captions…",
  "youtube-none": "No YouTube captions",
};

function renderStatus() {
  const st = session.status;
  const here = st.tabId === activeTab?.id;
  const listening = st.state === "listening" || st.state === "starting";
  let text = STATUS_TEXT[st.state] || st.state;
  if (listening && !here) text += " on another tab";
  if (listening && session.title) text += ` · ${session.title}`;
  $("status").textContent = text;
  $("status").className = `status ${st.state}`;
  const yt = st.mode === "youtube" && here;
  $("toggle").textContent = listening ? "Stop" : yt && st.state === "youtube" ? "Listen instead" : "Start on this tab";
  if (yt && st.state === "youtube-none" && st.message) showError(st.message);
  $("toggle").classList.toggle("danger", listening);
  $("hint").hidden = listening || session.lines.length > 0;
  if (st.state === "error" && st.message) showError(st.message);
  else if (listening) showError(st.message || "");
}

function current() {
  return viewing || { ...session, startedAt: session.status.startedAt };
}

function renderLines() {
  const s = current();
  const ol = $("lines");
  const atBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 40;
  ol.innerHTML = "";
  for (const l of s.lines) {
    const li = document.createElement("li");
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = l.time;
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = l.text;
    li.append(time, text);
    if (l.translation && l.translation.trim() !== l.text.trim()) {
      const tr = document.createElement("div");
      tr.className = "tr";
      tr.textContent = l.translation;
      li.append(tr);
    }
    ol.append(li);
  }
  $("empty").hidden = s.lines.length > 0;
  if (atBottom || !viewing) ol.scrollTop = ol.scrollHeight;
}

function renderNotes() {
  const s = current();
  $("notesBody").innerHTML = s.notes ? renderMarkdown(s.notes) : "";
  $("makeNotes").hidden = !!viewing;
  $("makeNotes").textContent = s.notes ? "Rewrite notes" : "Write notes from the transcript";
}

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get("history");
  const ul = $("historyList");
  ul.innerHTML = "";
  for (const h of history) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = "link";
    const when = h.startedAt ? new Date(h.startedAt).toLocaleString() : "";
    b.textContent = `${h.title || "Session"} — ${when} (${h.lines.length} lines)`;
    b.addEventListener("click", () => {
      viewing = h;
      $("viewingBar")?.remove();
      const bar = document.createElement("div");
      bar.id = "viewingBar";
      bar.className = "viewing";
      bar.textContent = `Viewing: ${h.title || "Session"} `;
      const back = document.createElement("button");
      back.className = "link";
      back.textContent = "Back to live";
      back.onclick = () => { viewing = null; bar.remove(); renderAll(); };
      bar.append(back);
      document.querySelector(".tabs").before(bar);
      switchTab("transcript");
      renderAll();
    });
    li.append(b);
    ul.append(li);
  }
  $("historyEmpty").hidden = history.length > 0;
}

function renderAll() {
  renderStatus();
  renderLines();
  renderNotes();
}

function switchTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".pane").forEach((p) => (p.hidden = p.id !== name));
  if (name === "history") renderHistory();
}

async function toggle() {
  showError("");
  const st = session.status.state;
  if (st === "listening" || st === "starting") {
    await bg("stop");
    return;
  }
  if (!activeTab || /^(chrome|edge|about|chrome-extension):/.test(activeTab.url || "")) {
    showError("Open the meeting, video or stream tab first. Browser pages can't be captured.");
    return;
  }
  const settings = await loadSettings();
  if (!settings.apiKey) {
    showError("Add your AI service key in Settings first.");
    chrome.runtime.openOptionsPage();
    return;
  }
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
  } catch (e) {
    showError(/active stream/i.test(e.message) ? "This tab is already being captured. Stop the other capture first." : e.message);
    return;
  }
  viewing = null;
  $("viewingBar")?.remove();
  const res = await bg("start", { tabId: activeTab.id, streamId, tabTitle: activeTab.title });
  if (!res?.ok) showError(res?.error || "Couldn't start.");
  else if (!res.overlay) showError("Listening, but subtitles can't be drawn on this page. The transcript still appears here.");
}

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const settings = await loadSettings();
  const sel = $("targetLang");
  for (const [code, name] of LANGUAGES) sel.add(new Option(name, code, false, code === settings.targetLang));
  sel.addEventListener("change", () => saveSettings({ targetLang: sel.value }));

  // On YouTube, ask the page to send its captions for this video.
  if (activeTab?.id != null) chrome.tabs.sendMessage(activeTab.id, { target: "yt", type: "report" }).catch(() => {});
  session = await bg("session");
  renderAll();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.session) {
      session = changes.session.newValue;
      if (!viewing) renderAll();
      else renderStatus();
    }
  });

  $("toggle").addEventListener("click", toggle);
  $("settings").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  $("makeNotes").addEventListener("click", async () => {
    const btn = $("makeNotes");
    btn.disabled = true;
    btn.textContent = "Writing notes…";
    showError("");
    const res = await bg("notes");
    btn.disabled = false;
    if (!res?.ok) showError(res?.error || "Couldn't write notes.");
    renderNotes();
  });

  $("copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(sessionToMarkdown(current()));
    $("copy").textContent = "Copied";
    setTimeout(() => ($("copy").textContent = "Copy"), 1200);
  });

  $("download").addEventListener("click", () => {
    const s = current();
    const blob = new Blob([sessionToMarkdown(s)], { type: "text/markdown" });
    const a = document.createElement("a");
    const stamp = new Date(s.startedAt || Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, "-");
    a.href = URL.createObjectURL(blob);
    a.download = `subtitles-${stamp}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}

init();
