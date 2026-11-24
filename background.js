// Service worker: owns the session state, the offscreen audio page and the
// subtitle overlay in the captured tab.
import { loadSettings } from "./settings.js";
import { makeNotes } from "./ai.js";

const EMPTY = { status: { state: "idle" }, lines: [], notes: "", title: "" };

// All state changes go through one chain so rapid messages can't overwrite each other.
let chain = Promise.resolve();
function update(fn) {
  chain = chain.then(async () => {
    const { session = EMPTY } = await chrome.storage.session.get("session");
    const next = (await fn(structuredClone(session))) || session;
    await chrome.storage.session.set({ session: next });
    return next;
  });
  return chain;
}

async function getSession() {
  await chain;
  const { session = EMPTY } = await chrome.storage.session.get("session");
  return session;
}

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Capture the tab's audio to make live subtitles.",
    });
  } catch (e) {
    if (!String(e.message).includes("single offscreen")) throw e;
  }
}

async function toTab(tabId, msg) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { target: "overlay", ...msg });
  } catch {
    /* overlay not present in this tab (e.g. page navigated) */
  }
}

async function injectOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["overlay.js"] });
    return true;
  } catch {
    return false; // chrome:// pages, the Web Store, etc.
  }
}

async function archive(session) {
  if (!session.lines.length) return;
  const { history = [] } = await chrome.storage.local.get("history");
  history.unshift({
    id: session.status.startedAt || Date.now(),
    title: session.title,
    startedAt: session.status.startedAt,
    lines: session.lines,
    notes: session.notes,
  });
  await chrome.storage.local.set({ history: history.slice(0, 20) });
}

async function start({ tabId, streamId, tabTitle }) {
  const settings = await loadSettings();
  if (!settings.apiKey) {
    return { ok: false, error: "Add your AI service key in Settings first." };
  }
  const old = await getSession();
  if (old.status.state === "listening") await stop();
  await archive(await getSession());
  await update(() => ({
    status: { state: "starting", tabId, startedAt: Date.now() },
    lines: [],
    notes: "",
    title: tabTitle || "",
  }));
  await ensureOffscreen();
  const overlay = await injectOverlay(tabId);
  // The audio page may still be loading; retry until it answers.
  let res;
  for (let i = 0; i < 20; i++) {
    try {
      res = await chrome.runtime.sendMessage({ target: "offscreen", type: "start", streamId, settings });
      if (res) break;
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!res?.ok) {
    await update((s) => { s.status = { state: "error", message: res?.error || "Couldn't start." }; return s; });
    return { ok: false, error: res?.error };
  }
  if (overlay) await toTab(tabId, { type: "settings", settings });
  return { ok: true, overlay };
}

async function stop() {
  const session = await getSession();
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "stop" });
  } catch { /* no offscreen page */ }
  await update((s) => { s.status = { ...s.status, state: "stopped", message: "" }; return s; });
  await toTab(session.status.tabId, { type: "stopped" });
  try { await chrome.offscreen.closeDocument(); } catch { /* already closed */ }
}

async function onOffscreen(msg) {
  const session = await getSession();
  const tabId = session.status.tabId;
  if (msg.type === "line") {
    await update((s) => { s.lines.push({ id: msg.id, time: msg.time, text: msg.text, translation: "" }); return s; });
    await toTab(tabId, { type: "line", id: msg.id, text: msg.text });
  } else if (msg.type === "translation") {
    await update((s) => {
      const line = s.lines.find((l) => l.id === msg.id);
      if (line) line.translation = msg.translation;
      return s;
    });
    await toTab(tabId, { type: "translation", id: msg.id, translation: msg.translation });
  } else if (msg.type === "status") {
    if (msg.state === "stopped" && session.status.state === "stopped") return;
    await update((s) => {
      s.status = { ...s.status, state: msg.state, kind: msg.kind, message: msg.message || "" };
      return s;
    });
    if (msg.state === "error" || msg.state === "stopped") await toTab(tabId, { type: "status", state: msg.state, message: msg.message });
  }
}

async function notes() {
  const settings = await loadSettings();
  const session = await getSession();
  if (!session.lines.length) return { ok: false, error: "Nothing has been transcribed yet." };
  const lines = session.lines.map((l) => ({ time: l.time, text: l.text }));
  try {
    const md = await makeNotes(settings, lines, session.title);
    await update((s) => { s.notes = md; return s; });
    return { ok: true, notes: md };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.target !== "background") return;
  const handlers = {
    start: () => start(msg),
    stop: () => stop().then(() => ({ ok: true })),
    notes: () => notes(),
    session: () => getSession(),
    reinject: async () => {
      const s = await getSession();
      const ok = await injectOverlay(s.status.tabId);
      if (ok) await toTab(s.status.tabId, { type: "settings", settings: await loadSettings() });
      return { ok };
    },
  };
  if (handlers[msg.type]) {
    handlers[msg.type]().then(reply, (e) => reply({ ok: false, error: e.message }));
    return true;
  }
  onOffscreen(msg);
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const settings = changes.settings.newValue;
  const session = await getSession();
  if (session.status.state !== "listening") return;
  chrome.runtime.sendMessage({ target: "offscreen", type: "settings", settings }).catch(() => {});
  toTab(session.status.tabId, { type: "settings", settings });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-subtitles") return;
  const session = await getSession();
  toTab(session.status.tabId, { type: "toggle" });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await getSession();
  if (session.status.tabId === tabId && session.status.state === "listening") stop();
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});
