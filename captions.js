// Reads YouTube caption files (json3 or XML) into simple cues.
// No browser APIs beyond DOMParser (only used for XML), so it's testable.

function decode(text) {
  return text
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function clean(text) {
  return text.replace(/\s+/g, " ").trim();
}

export function parseJson3(json) {
  const events = (json.events || []).filter((e) => Array.isArray(e.segs));
  const cues = [];
  for (const e of events) {
    const text = clean(e.segs.map((s) => s.utf8 || "").join(""));
    if (!text) continue;
    const start = e.tStartMs || 0;
    cues.push({ start, end: start + (e.dDurationMs || 2000), text });
  }
  return finish(cues);
}

export function parseXml(xml) {
  const cues = [];
  // srv3: <p t="1000" d="2000">..</p>   srv1: <text start="1.0" dur="2.0">..</text>
  const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  const tRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  const attr = (a, n) => { const m = a.match(new RegExp(`\\b${n}="([^"]*)"`)); return m ? m[1] : null; };
  let m;
  while ((m = pRe.exec(xml))) {
    const start = Number(attr(m[1], "t") || 0);
    const text = clean(decode(m[2].replace(/<[^>]+>/g, "")));
    if (text) cues.push({ start, end: start + Number(attr(m[1], "d") || 2000), text });
  }
  if (!cues.length) {
    while ((m = tRe.exec(xml))) {
      const start = Math.round(Number(attr(m[1], "start") || 0) * 1000);
      const text = clean(decode(decode(m[2].replace(/<[^>]+>/g, ""))));
      if (text) cues.push({ start, end: start + Math.round(Number(attr(m[1], "dur") || 2) * 1000), text });
    }
  }
  return finish(cues);
}

export function parseTimedtext(text) {
  const t = (text || "").trim();
  if (!t) return [];
  if (t.startsWith("{")) {
    try { return parseJson3(JSON.parse(t)); } catch { return []; }
  }
  if (t.startsWith("<")) return parseXml(t);
  return [];
}

// Sort, and stop each cue where the next begins so only one is "current".
function finish(cues) {
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
    // Keep short gaps from blinking the bar off.
    else if (cues[i + 1].start - cues[i].end < 600) cues[i].end = cues[i + 1].start;
  }
  return cues;
}

// Index of the cue showing at time ms, or -1. Binary search.
export function cueAt(cues, ms) {
  let lo = 0, hi = cues.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= ms) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found >= 0 && ms < cues[found].end) return found;
  return -1;
}

// Pair each original cue with the translated cue that starts closest to it.
export function pairTranslations(orig, translated) {
  if (!translated.length) return orig.map(() => "");
  return orig.map((c) => {
    const i = cueAt(translated, c.start + 1);
    const hit = i >= 0 ? translated[i] : translated.find((t) => Math.abs(t.start - c.start) < 300);
    return hit ? hit.text : "";
  });
}

export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// YouTube's codes for its own translation where they differ from ours.
export function youtubeLang(code) {
  return { "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" }[code] || code;
}

// Pick the caption track to read: a human-made one in the spoken language if
// there is one, otherwise the automatic one.
export function chooseTrack(tracks) {
  if (!tracks.length) return null;
  const asr = tracks.find((t) => t.kind === "asr");
  if (asr) {
    const base = asr.languageCode.split("-")[0];
    const manual = tracks.find((t) => t.kind !== "asr" && t.languageCode.split("-")[0] === base);
    return manual || asr;
  }
  return tracks[0];
}
