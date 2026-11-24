// Runs in YouTube's own page context (world: MAIN). It watches the caption
// files the YouTube player downloads, and can switch the player's captions on.
// Everything it finds is passed to youtube.js with window.postMessage.
(() => {
  if (window.__translatorYtMain) return;
  window.__translatorYtMain = true;

  const post = (data) => window.postMessage({ source: "translator-yt", ...data }, location.origin);
  const isCaptionUrl = (u) => typeof u === "string" && u.includes("/api/timedtext");

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : input?.url;
      if (isCaptionUrl(url)) {
        p.then((res) => res.clone().text())
          .then((text) => post({ type: "timedtext", url: new URL(url, location.href).href, text }))
          .catch(() => {});
      }
    } catch { /* never break the page */ }
    return p;
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__translatorTT = isCaptionUrl(String(url)) ? String(url) : null; } catch { this.__translatorTT = null; }
    return xhrOpen.apply(this, arguments);
  };
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (this.__translatorTT) {
      const url = this.__translatorTT;
      this.addEventListener("load", () => {
        try {
          const text = typeof this.response === "string" ? this.response : this.responseText;
          post({ type: "timedtext", url: new URL(url, location.href).href, text });
        } catch { /* ignore */ }
      });
    }
    return xhrSend.apply(this, arguments);
  };

  function player() {
    return document.getElementById("movie_player");
  }

  function trackName(t) {
    return t.name?.simpleText || (t.name?.runs || []).map((r) => r.text).join("") || t.languageCode;
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.source !== "translator-yt-cmd") return;
    const p = player();
    if (e.data.type === "tracks") {
      let pr = null;
      try { pr = p?.getPlayerResponse?.(); } catch { /* ignore */ }
      pr = pr || window.ytInitialPlayerResponse;
      const list = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      post({
        type: "tracks",
        videoId: pr?.videoDetails?.videoId || "",
        title: pr?.videoDetails?.title || document.title,
        tracks: list.map((t) => ({
          languageCode: t.languageCode,
          kind: t.kind || "",
          name: trackName(t),
          baseUrl: t.baseUrl,
        })),
      });
    } else if (e.data.type === "enable" && p) {
      // Turn on the player's captions in this language so it downloads them.
      try {
        p.loadModule?.("captions");
        const pick = () => {
          const list = p.getOption?.("captions", "tracklist") || [];
          const want = list.find((t) => t.languageCode === e.data.languageCode && (t.kind || "") === (e.data.kind || ""))
            || list.find((t) => t.languageCode === e.data.languageCode);
          p.setOption?.("captions", "track", want || { languageCode: e.data.languageCode });
        };
        pick();
        setTimeout(pick, 400);
      } catch { /* fall back to the CC button below */ }
      setTimeout(() => {
        const btn = document.querySelector(".ytp-subtitles-button");
        if (btn && btn.getAttribute("aria-pressed") === "false") btn.click();
      }, 900);
    }
  });

  post({ type: "ready" });
})();
