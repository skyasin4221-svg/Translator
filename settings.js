// Shared settings and AI provider presets.

export const PROVIDERS = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    hearModel: "gpt-4o-mini-transcribe",
    chatModel: "gpt-4o-mini",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  groq: {
    label: "Groq (fast, has a free tier)",
    baseUrl: "https://api.groq.com/openai/v1",
    hearModel: "whisper-large-v3-turbo",
    chatModel: "llama-3.3-70b-versatile",
    keyUrl: "https://console.groq.com/keys",
  },
  custom: {
    label: "Other OpenAI-compatible service",
    baseUrl: "",
    hearModel: "whisper-1",
    chatModel: "",
    keyUrl: "",
  },
};

export const LANGUAGES = [
  ["en", "English"], ["zh-CN", "Chinese (Simplified)"], ["zh-TW", "Chinese (Traditional)"],
  ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"],
  ["ru", "Russian"], ["ja", "Japanese"], ["ko", "Korean"], ["ar", "Arabic"], ["hi", "Hindi"],
  ["ur", "Urdu"], ["bn", "Bengali"], ["tr", "Turkish"], ["fa", "Persian"], ["pl", "Polish"],
  ["nl", "Dutch"], ["sv", "Swedish"], ["uk", "Ukrainian"], ["vi", "Vietnamese"], ["th", "Thai"],
  ["id", "Indonesian"], ["ms", "Malay"],
];

export function languageName(code) {
  const hit = LANGUAGES.find(([c]) => c === code);
  return hit ? hit[1] : code;
}

export const DEFAULTS = {
  provider: "openai",
  apiKey: "",
  baseUrl: PROVIDERS.openai.baseUrl,
  hearModel: PROVIDERS.openai.hearModel,
  chatModel: PROVIDERS.openai.chatModel,
  targetLang: "en",
  subtitleMode: "both", // both | translation | original
  fontSize: 22,
  position: "bottom", // bottom | top
  wordList: "",
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function originPattern(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}
