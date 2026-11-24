// Calls to an OpenAI-compatible AI service: speech-to-text, translation, notes.
import { languageName } from "./settings.js";

export class AIError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // invalidKey | rateLimited | network | server | badModel | noKey
  }
}

function endpoint(settings, path) {
  return settings.baseUrl.replace(/\/+$/, "") + path;
}

async function request(settings, path, init, timeoutMs = 30000) {
  if (!settings.apiKey) throw new AIError("noKey", "Add your AI service key in Settings.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(endpoint(settings, path), {
      ...init,
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${settings.apiKey}`, ...(init.headers || {}) },
    });
  } catch (e) {
    throw new AIError("network", e.name === "AbortError" ? "The AI service took too long to answer." : "Can't reach the AI service. Check your connection.");
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) return res.json();
  let detail = "";
  try {
    const body = await res.json();
    detail = body?.error?.message || JSON.stringify(body).slice(0, 200);
  } catch { /* ignore */ }
  if (res.status === 401 || res.status === 403) throw new AIError("invalidKey", "The AI service rejected your key. " + detail);
  if (res.status === 429 || res.status === 402) throw new AIError("rateLimited", "Rate limit or out of credit. " + detail);
  if (res.status === 404 || res.status === 400) throw new AIError("badModel", `The service refused the request (${res.status}). ${detail}`);
  throw new AIError("server", `AI service error ${res.status}. ${detail}`);
}

// Whisper-style models sometimes invent these on near-silence.
const HALLUCINATIONS = [
  /^thank(s| you)( so much)?( for watching| for listening)?[.!]*$/i,
  /^(please )?(like and )?subscribe[.!]*$/i,
  /^you[.!]*$/i,
  /^bye[.!]*$/i,
  /^\.+$/,
  /^字幕(由|提供).*$/,
  /^请不吝点赞.*$/,
  /^ご視聴ありがとうございました.*$/,
];

export function looksHallucinated(text) {
  const t = text.trim();
  if (!t) return true;
  return HALLUCINATIONS.some((re) => re.test(t));
}

export async function transcribe(settings, wavBlob, contextText) {
  const form = new FormData();
  form.append("file", wavBlob, "segment.wav");
  form.append("model", settings.hearModel);
  form.append("response_format", "json");
  const hint = [settings.wordList?.trim(), contextText?.trim()].filter(Boolean).join("\n");
  if (hint) form.append("prompt", hint.slice(-400));
  const json = await request(settings, "/audio/transcriptions", { method: "POST", body: form }, 30000);
  return (json.text || "").trim();
}

async function chat(settings, messages, maxTokens, timeoutMs) {
  const json = await request(
    settings,
    "/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: settings.chatModel, messages, temperature: 0.2, max_tokens: maxTokens }),
    },
    timeoutMs,
  );
  return (json.choices?.[0]?.message?.content || "").trim();
}

export async function translate(settings, text, previousLines) {
  const target = languageName(settings.targetLang);
  const system =
    `You are a live subtitle translator. Translate the user's line into ${target}. ` +
    `If the line is already in ${target}, return it unchanged. ` +
    `Keep names and technical terms accurate. Output only the translation, with no quotes or notes.` +
    (settings.wordList?.trim() ? `\nPreferred spellings of names and terms:\n${settings.wordList.trim()}` : "");
  const context = previousLines.length
    ? `Earlier lines, for context only (do not translate them):\n${previousLines.join("\n")}\n\nLine to translate:\n`
    : "";
  return chat(settings, [{ role: "system", content: system }, { role: "user", content: context + text }], 400, 20000);
}

export async function makeNotes(settings, lines, title) {
  const target = languageName(settings.targetLang);
  const transcript = lines.map((l) => `[${l.time}] ${l.text}`).join("\n");
  const system =
    `You write meeting notes from a live transcript. Write in ${target}, in Markdown, with these sections: ` +
    `## Summary (3-5 sentences), ## Topics and key points (bullets grouped by topic), ## Decisions, ## To-dos (who, what, when if said), ` +
    `## Names and terms. Only use what the transcript says; write "None" for an empty section. Speech recognition may mishear words, so fix obvious errors from context.`;
  const user = `Title: ${title || "Untitled"}\n\nTranscript:\n${transcript.slice(-60000)}`;
  return chat(settings, [{ role: "system", content: system }, { role: "user", content: user }], 2000, 90000);
}

export async function checkKey(settings) {
  await request(settings, "/models", { method: "GET" }, 15000);
  return true;
}
