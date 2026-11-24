// Subtitle bar drawn over the captured tab. Injected by the service worker.
(() => {
  if (window.__cicadaOverlay) {
    window.__cicadaOverlay.show();
    return;
  }

  const host = document.createElement("div");
  host.id = "cicada-tab-subtitles";
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; left: 0; right: 0; pointer-events: none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .bar {
        margin: 0 auto; max-width: min(960px, 92vw); box-sizing: border-box;
        padding: 10px 18px; border-radius: 12px;
        background: rgba(17, 17, 20, 0.82); color: #fff;
        font-family: -apple-system, "Segoe UI", Roboto, "Noto Sans", "PingFang SC", "Microsoft YaHei", sans-serif;
        text-align: center; line-height: 1.35;
        box-shadow: 0 6px 24px rgba(0,0,0,0.35);
        transition: opacity 160ms ease;
      }
      .bar.empty { display: none; }
      .bar.see-through { opacity: 0.12; }
      .line + .line { margin-top: 6px; }
      .line.old { opacity: 0.6; }
      .tr { font-weight: 600; }
      .orig { color: #c9c9cf; font-size: 0.72em; }
      .orig:only-child { color: #fff; font-size: 1em; font-weight: 600; }
      .status { font-size: 13px; color: #ffb38a; }
    </style>
    <div class="bar empty" part="bar"></div>`;
  const bar = root.querySelector(".bar");

  let settings = { subtitleMode: "both", fontSize: 22, position: "bottom" };
  let lines = []; // {id, text, translation}
  let hidden = false;
  let hideTimer = null;

  function place() {
    host.style.top = settings.position === "top" ? "24px" : "";
    host.style.bottom = settings.position === "top" ? "" : "48px";
    bar.style.fontSize = `${settings.fontSize || 22}px`;
  }

  function esc(t) {
    const d = document.createElement("div");
    d.textContent = t;
    return d.innerHTML;
  }

  function render() {
    const show = lines.slice(-2);
    bar.innerHTML = show
      .map((l, i) => {
        const old = i < show.length - 1 ? " old" : "";
        const tr = l.translation && l.translation.trim() !== l.text.trim() ? l.translation : "";
        let inner = "";
        if (settings.subtitleMode === "original") inner = `<div class="orig">${esc(l.text)}</div>`;
        else if (settings.subtitleMode === "translation") inner = `<div class="tr">${esc(tr || l.text)}</div>`;
        else inner = (tr ? `<div class="tr">${esc(tr)}</div>` : "") + `<div class="orig">${esc(l.text)}</div>`;
        return `<div class="line${old}">${inner}</div>`;
      })
      .join("");
    bar.classList.toggle("empty", hidden || show.length === 0);
    // Fade out after a quiet spell, like real subtitles.
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { lines = []; bar.classList.add("empty"); }, 9000);
  }

  function status(text) {
    if (hidden) return;
    bar.innerHTML = `<div class="status">${esc(text)}</div>`;
    bar.classList.remove("empty");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bar.classList.add("empty"), 6000);
  }

  // Let clicks through and turn see-through when the pointer is over the bar.
  document.addEventListener(
    "mousemove",
    (e) => {
      const r = bar.getBoundingClientRect();
      const over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      bar.classList.toggle("see-through", over);
    },
    { passive: true },
  );

  function onMessage(msg) {
    if (msg.target !== "overlay") return;
    if (msg.type === "settings") {
      settings = { ...settings, ...msg.settings };
      place();
      if (lines.length) render();
    } else if (msg.type === "line") {
      lines.push({ id: msg.id, text: msg.text, translation: "" });
      if (lines.length > 4) lines.shift();
      if (settings.subtitleMode !== "translation") render();
    } else if (msg.type === "translation") {
      const l = lines.find((x) => x.id === msg.id);
      if (l) { l.translation = msg.translation; render(); }
    } else if (msg.type === "toggle") {
      hidden = !hidden;
      if (hidden) bar.classList.add("empty");
      else render();
    } else if (msg.type === "status" && msg.message) {
      status(msg.message);
    } else if (msg.type === "stopped") {
      status("Subtitles stopped");
    }
  }
  chrome.runtime.onMessage.addListener(onMessage);

  (document.body || document.documentElement).appendChild(host);
  place();
  // Keep the bar visible in fullscreen video.
  document.addEventListener("fullscreenchange", () => {
    const parent = document.fullscreenElement || document.body || document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  });

  window.__cicadaOverlay = {
    show() { hidden = false; if (!host.isConnected) (document.body || document.documentElement).appendChild(host); },
  };
})();
