// YouTube caption mode: shows the video's own captions plus YouTube's
// translation of them, in sync with the video, using the subtitle bar.
(async () => {
  if (window.__translatorYt) return;
  window.__translatorYt = true;

  const C = await import(chrome.runtime.getURL("captions.js"));
  const DEFAULTS = { youtubeCaptions: true, targetLang: "en", subtitleMode: "both", fontSize: 22, position: "bottom" };
  let settings = { ...DEFAULTS, ...((await chrome.storage.local.get("settings")).settings || {}) };

  const overlay = () => window.__cicadaOverlay;
  const captured = new Map(); // "video|lang|kind|tlang" -> {url, text}
  let v = null; // current video state
  let paused = false; // listening mode is running in this tab
  let navToken = 0;

  // ---- talking to yt-main.js (page context) ----
  const cmd = (data) => window.postMessage({ source: "translator-yt-cmd", ...data }, location.origin);
  const waiters = [];
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.source !== "translator-yt") return;
    const d = e.data;
    if (d.type === "timedtext") {
      try {
        const u = new URL(d.url);
        const key = [u.searchParams.get("v"), u.searchParams.get("lang"), u.searchParams.get("kind") || "", u.searchParams.get("tlang") || ""].join("|");
        if (d.text && d.text.trim()) captured.set(key, { url: d.url, text: d.text });
      } catch { /* ignore */ }
    }
    for (const w of [...waiters]) if (w.test(d)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(d); }
  });
  function waitFor(test, ms) {
    return new Promise((resolve) => {
      const w = { test, resolve };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); resolve(null); } }, ms);
    });
  }

  // ---- hide YouTube's own captions while ours are showing ----
  const style = document.createElement("style");
  style.textContent = "html.translator-yt-on .ytp-caption-window-container { display: none !important; }";
  (document.head || document.documentElement).appendChild(style);
  const hideNative = (on) => document.documentElement.classList.toggle("translator-yt-on", on);

  const currentId = () => new URL(location.href).searchParams.get("v");
  const sameBase = (a, b) => (a || "").split("-")[0].toLowerCase() === (b || "").split("-")[0].toLowerCase();

  function report(extra = {}) {
    if (!v) return;
    chrome.runtime.sendMessage({
      target: "background",
      type: "ytCues",
      videoId: v.id,
      title: v.title,
      state: v.state,
      message: v.message || "",
      lines: (v.cues || []).map((c, i) => ({ id: i + 1, time: C.clock(c.start), text: c.text, translation: v.trs?.[i] || "" })),
      ...extra,
    }).catch(() => {});
  }
  let reportTimer = null;
  const reportSoon = () => { clearTimeout(reportTimer); reportTimer = setTimeout(report, 800); };

  async function fetchText(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(String(res.status));
    return res.text();
  }

  function withParams(url, params) {
    const u = new URL(url, location.href);
    for (const [k, val] of Object.entries(params)) {
      if (val == null) u.searchParams.delete(k);
      else u.searchParams.set(k, val);
    }
    return u.href;
  }

  // ---- load one video ----
  async function load() {
    const token = ++navToken;
    teardown();
    if (!settings.youtubeCaptions || location.pathname !== "/watch") return;
    const id = currentId();
    if (!id) return;

    // Ask the page for its caption tracks (the player may still be loading).
    let info = null;
    for (let i = 0; i < 12 && token === navToken; i++) {
      cmd({ type: "tracks" });
      info = await waitFor((d) => d.type === "tracks", 1000);
      if (info && info.videoId === id) break;
      info = null;
      await new Promise((r) => setTimeout(r, 700));
    }
    if (token !== navToken) return;
    v = { id, title: info?.title || document.title, cues: [], trs: [], state: "loading" };
    const track = C.chooseTrack(info?.tracks || []);
    if (!track) {
      v.state = "none";
      v.message = "This video has no captions. Press Start to translate it by listening instead.";
      overlay()?.status("No captions on this video – open Translator and press Start to listen instead.");
      report();
      return;
    }
    v.track = track;

    // Get the original captions: from what the player downloads (most reliable),
    // or straight from the track's address.
    const key = [id, track.languageCode, track.kind || "", ""].join("|");
    let src = captured.get(key);
    if (!src) {
      cmd({ type: "enable", languageCode: track.languageCode, kind: track.kind });
      for (let i = 0; i < 25 && !src && token === navToken; i++) {
        await new Promise((r) => setTimeout(r, 200));
        src = captured.get(key);
      }
    }
    if (token !== navToken) return;
    let cues = src ? C.parseTimedtext(src.text) : [];
    let baseForTranslation = src?.url || track.baseUrl;
    if (!cues.length && track.baseUrl) {
      try {
        const url = withParams(track.baseUrl, { fmt: "json3" });
        cues = C.parseTimedtext(await fetchText(url));
        baseForTranslation = url;
      } catch { /* handled below */ }
    }
    if (token !== navToken) return;
    if (!cues.length) {
      v.state = "none";
      v.message = "Couldn't read this video's captions. Press Start to translate it by listening instead.";
      overlay()?.status("Couldn't read the captions – open Translator and press Start to listen instead.");
      report();
      return;
    }
    v.cues = cues;
    v.trs = cues.map(() => "");
    v.baseUrl = baseForTranslation;
    v.state = "ready";
    hideNative(true);
    report();
    await translateAll(token);
  }

  async function translateAll(token) {
    if (!v || !v.cues.length) return;
    v.trs = v.cues.map(() => "");
    v.aiFallback = false;
    if (settings.subtitleMode === "original" || sameBase(v.track.languageCode, settings.targetLang)) { reportSoon(); return; }
    const tlang = C.youtubeLang(settings.targetLang);
    try {
      const key = [v.id, v.track.languageCode, v.track.kind || "", tlang].join("|");
      const text = captured.get(key)?.text || (await fetchText(withParams(v.baseUrl, { fmt: "json3", tlang })));
      if (token !== navToken) return;
      const translated = C.parseTimedtext(text);
      if (!translated.length) throw new Error("empty");
      v.trs = C.pairTranslations(v.cues, translated);
    } catch {
      // YouTube wouldn't translate it; translate the lines as they come up instead.
      v.aiFallback = true;
    }
    reportSoon();
  }

  // AI fallback: translate the current line and the next few, once each.
  const asked = new Set();
  function aiTranslateAround(i) {
    if (!v?.aiFallback) return;
    for (let k = i; k < Math.min(v.cues.length, i + 4); k++) {
      const key = `${v.id}|${settings.targetLang}|${k}`;
      if (asked.has(key) || v.trs[k]) continue;
      asked.add(key);
      const context = v.cues.slice(Math.max(0, k - 3), k).map((c) => c.text);
      const vid = v.id;
      chrome.runtime.sendMessage({ target: "background", type: "translateText", text: v.cues[k].text, context })
        .then((res) => {
          if (res?.ok && v?.id === vid) { v.trs[k] = res.translation; reportSoon(); }
          else if (res && !res.ok) asked.delete(key);
        })
        .catch(() => asked.delete(key));
    }
  }

  // ---- keep the bar in sync with the video ----
  setInterval(() => {
    const ov = overlay();
    if (!ov || !v || v.state !== "ready" || paused || !settings.youtubeCaptions) return;
    const video = document.querySelector("#movie_player video") || document.querySelector("video");
    if (!video) return;
    const r = video.getBoundingClientRect();
    if (r.width > 0) ov.anchor({ left: r.left, top: r.top, width: r.width, bottom: r.bottom });
    const i = C.cueAt(v.cues, video.currentTime * 1000);
    if (i < 0) { ov.display([]); return; }
    aiTranslateAround(i);
    const show = [];
    // Automatic captions come in short pieces, so show the one before too.
    if (v.track.kind === "asr" && i > 0) show.push({ text: v.cues[i - 1].text, translation: v.trs[i - 1] });
    show.push({ text: v.cues[i].text, translation: v.trs[i] });
    ov.display(show);
  }, 120);

  function teardown() {
    v = null;
    asked.clear();
    hideNative(false);
    overlay()?.display([]);
  }

  // ---- reacting to changes ----
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    const old = settings;
    settings = { ...DEFAULTS, ...changes.settings.newValue };
    overlay()?.setSettings(settings);
    if (old.youtubeCaptions !== settings.youtubeCaptions) { load(); return; }
    if (v?.state === "ready" && (old.targetLang !== settings.targetLang || old.subtitleMode !== settings.subtitleMode)) {
      translateAll(navToken);
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.target !== "yt") return;
    if (msg.type === "pause") { paused = true; hideNative(false); overlay()?.anchor(null); }
    if (msg.type === "resume") { paused = false; if (v?.state === "ready") hideNative(true); }
    if (msg.type === "report") report();
  });

  let lastUrl = location.href;
  document.addEventListener("yt-navigate-finish", () => { if (location.href !== lastUrl || !v) { lastUrl = location.href; load(); } });
  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; load(); } }, 1000);

  overlay()?.setSettings(settings);
  load();
})();
