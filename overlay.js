// Subtitle bar drawn over the page. Used by listening mode (injected by the
// service worker) and by YouTube caption mode (declared content script).
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
        margin: 0 auto; width: fit-content; max-width: min(960px, 92%); box-sizing: border-box;
        padding: 8px 16px; border-radius: 10px;
        background: rgba(8, 8, 10, 0.78); color: #fff;
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
      .orig { color: #d4d4da; font-size: 0.72em; }
      .orig:only-child { color: #fff; font-size: 1em; font-weight: 600; }
      .status { font-size: 13px; color: #ffb38a; }
    </style>
    <div class="bar empty"></div>`;
  const bar = root.querySelector(".bar");

  let settings = { subtitleMode: "both", fontSize: 22, position: "bottom" };
  let lines = []; // listening mode: {id, text, translation}
  let hidden = false;
  let hideTimer = null;
  let anchored = null; // YouTube mode: a rect to sit inside, instead of the window

  function place() {
    bar.style.fontSize = `${settings.fontSize || 22}px`;
    if (anchored) {
      const r = anchored;
      host.style.left = `${r.left}px`;
      host.style.right = "";
      host.style.width = `${r.width}px`;
      host.style.top = settings.position === "top" ? `${r.top + 16}px` : "";
      host.style.bottom = settings.position === "top" ? "" : `${Math.max(8, window.innerHeight - r.bottom + 64)}px`;
    } else {
      host.style.left = "0";
      host.style.right = "0";
      host.style.width = "";
      host.style.top = settings.position === "top" ? "24px" : "";
      host.style.bottom = settings.position === "top" ? "" : "48px";
    }
  }

  function esc(t) {
    const d = document.createElement("div");
    d.textContent = t;
    return d.innerHTML;
  }

  function lineHtml(l, old) {
    const tr = l.translation && l.translation.trim() !== l.text.trim() ? l.translation : "";
    let inner;
    if (settings.subtitleMode === "original") inner = `<div class="orig">${esc(l.text)}</div>`;
    else if (settings.subtitleMode === "translation") inner = `<div class="tr">${esc(tr || l.text)}</div>`;
    else inner = (tr ? `<div class="tr">${esc(tr)}</div>` : "") + `<div class="orig">${esc(l.text)}</div>`;
    return `<div class="line${old ? " old" : ""}">${inner}</div>`;
  }

  function draw(show) {
    bar.innerHTML = show.map((l, i) => lineHtml(l, i < show.length - 1)).join("");
    bar.classList.toggle("empty", hidden || show.length === 0);
  }

  function render() {
    draw(lines.slice(-2));
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

  function attach() {
    const parent = document.fullscreenElement || document.body || document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  }

  chrome.runtime.onMessage.addListener((msg) => {
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
  });

  attach();
  place();
  document.addEventListener("fullscreenchange", attach);

  window.__cicadaOverlay = {
    show() { hidden = false; attach(); },
    setSettings(s) { settings = { ...settings, ...s }; place(); },
    // YouTube mode: sit over the video, and show exactly these lines.
    anchor(rect) { anchored = rect; place(); },
    display(show) { clearTimeout(hideTimer); attach(); draw(show); },
    status,
    isHidden: () => hidden,
  };
})();
