import { PROVIDERS, LANGUAGES, loadSettings, saveSettings, originPattern } from "./settings.js";
import { checkKey } from "./ai.js";

const $ = (id) => document.getElementById(id);
const FIELDS = ["provider", "apiKey", "baseUrl", "hearModel", "chatModel", "targetLang", "subtitleMode", "position", "fontSize", "wordList"];

function read() {
  const v = {};
  for (const f of FIELDS) v[f] = $(f).value;
  v.fontSize = Number(v.fontSize);
  v.youtubeCaptions = $("youtubeCaptions").checked;
  v.apiKey = v.apiKey.trim();
  v.baseUrl = v.baseUrl.trim();
  return v;
}

function setKeyLink(provider) {
  const url = PROVIDERS[provider]?.keyUrl;
  $("keyLink").hidden = !url;
  if (url) $("keyLink").href = url;
}

// Custom services need permission to be contacted.
async function ensureAccess(baseUrl) {
  const pattern = originPattern(baseUrl);
  if (!pattern) throw new Error("The base URL isn't valid.");
  const has = await chrome.permissions.contains({ origins: [pattern] });
  if (has) return;
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) throw new Error(`Allow access to ${new URL(baseUrl).host} so the extension can reach it.`);
}

async function init() {
  for (const [key, p] of Object.entries(PROVIDERS)) $("provider").add(new Option(p.label, key));
  for (const [code, name] of LANGUAGES) $("targetLang").add(new Option(name, code));
  const s = await loadSettings();
  for (const f of FIELDS) $(f).value = s[f];
  $("youtubeCaptions").checked = s.youtubeCaptions !== false;
  $("youtubeCaptions").addEventListener("change", () => saveSettings({ youtubeCaptions: $("youtubeCaptions").checked }));
  $("fontSizeValue").textContent = `${s.fontSize}px`;
  setKeyLink(s.provider);
  if (s.provider === "custom") $("advanced").open = true;

  $("provider").addEventListener("change", () => {
    const p = PROVIDERS[$("provider").value];
    $("baseUrl").value = p.baseUrl;
    $("hearModel").value = p.hearModel;
    $("chatModel").value = p.chatModel;
    setKeyLink($("provider").value);
    if ($("provider").value === "custom") $("advanced").open = true;
  });
  $("fontSize").addEventListener("input", () => ($("fontSizeValue").textContent = `${$("fontSize").value}px`));

  // Save subtitle choices as soon as they change, so nothing is lost by forgetting Save.
  for (const f of ["targetLang", "subtitleMode", "position", "fontSize", "wordList"]) {
    $(f).addEventListener("change", () => saveSettings({ [f]: f === "fontSize" ? Number($(f).value) : $(f).value }));
  }

  $("save").addEventListener("click", async () => {
    const v = read();
    try {
      if (!v.baseUrl || !v.hearModel || !v.chatModel) throw new Error("Fill in the base URL and both models under Advanced.");
      await ensureAccess(v.baseUrl);
      await saveSettings(v);
      $("saved").className = "ok";
      $("saved").textContent = "Saved";
    } catch (e) {
      $("saved").className = "bad";
      $("saved").textContent = e.message;
    }
    setTimeout(() => ($("saved").textContent = ""), 4000);
  });

  $("check").addEventListener("click", async () => {
    const v = read();
    $("checkResult").className = "";
    $("checkResult").textContent = "Checking…";
    try {
      await ensureAccess(v.baseUrl);
      const res = await checkKey(v);
      if (res.chatModel && res.chatModel !== v.chatModel) {
        v.chatModel = res.chatModel;
        $("chatModel").value = res.chatModel;
      }
      await saveSettings(v);
      $("checkResult").className = "ok";
      $("checkResult").textContent = res.replaced
        ? `Key works – saved. "${res.replaced}" isn't available, so translation now uses "${res.chatModel}".`
        : "Key works – saved";
    } catch (e) {
      $("checkResult").className = "bad";
      $("checkResult").textContent = e.message;
    }
  });
}

init();
