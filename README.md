# Translator: live tab subtitles for Chrome

A Chrome extension that turns any tab playing sound into live bilingual subtitles. It also keeps a transcript and writes meeting notes. It works with Google Meet, Zoom and Teams in the browser, YouTube, Twitch, X Spaces, podcasts and anything else that plays audio in a tab.

It's inspired by [Cicada](https://github.com/wquguru/cicada), a desktop app that does this for whole-computer audio. This extension is a separate, browser-only version written from scratch.

## What it does

- **Live subtitles** over the page, showing the translation and the original line. The bar goes see-through when your pointer is over it, so the page stays clickable. It stays visible in fullscreen video.
- **Language detection**: whatever language is spoken gets translated into the one you pick.
- **Transcript** in the popup, with timestamps. You can copy it or download it as Markdown.
- **Meeting notes**: one click gives you a summary, key points by topic, decisions, to-dos, and names and terms.
- **History**: your last 20 sessions are saved in the browser.
- **Word list**: add names and terms that get misheard, and they'll be spelled right.
- Shortcut **Alt+Shift+S** shows or hides the subtitles.

The tab keeps playing sound normally while it's being captured. Nobody else in the meeting can see it, because no bot joins the call.

## Web version (no install)

Open **https://skyasin4221-svg.github.io/Translator/** in Chrome or Edge on a computer. It does the same job in a normal web page:

- **A tab or window**: press Start, pick the tab in the browser's dialog and tick **Share tab audio**.
- **Microphone**: for people in the same room.
- **Float subtitles over other windows** keeps the subtitles on top while you use another app (Chrome and Edge 116+).
- Transcript, notes, history (kept in your browser), Copy and Download .md work like the extension.

Your key is saved only in that browser's local storage. The code is in [`web/`](web/) and reuses the extension's modules.

## Install (developer mode)

1. Download this repo: **Code → Download ZIP**, then unzip it (or `git clone` it).
2. Open `chrome://extensions` in Chrome (Edge and Brave work too).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the unzipped folder, the one that contains `manifest.json`.
5. The settings page opens. Choose an AI service and paste your API key, then press **Check key** and **Save**.

## Use it

1. Open the tab with the meeting, video or stream.
2. Click the extension icon, pick the language to translate into, and press **Start on this tab**.
3. Subtitles appear over the page as people speak. The popup shows the full transcript.
4. When it's over, press **Stop**. Then open **Notes → Write notes from the transcript**, and **Download .md** if you want to keep it.

## AI service and cost

Audio from the tab you started on is cut at pauses and sent to the AI service you choose: the speech-to-text model writes it down and the chat model translates it. Nothing is sent anywhere else, and your key is stored only in your browser.

| Service | Speech-to-text | Translation & notes | Notes |
|---|---|---|---|
| OpenAI | `gpt-4o-mini-transcribe` | `gpt-4o-mini` | About $0.20 per hour of audio at current prices |
| Groq | `whisper-large-v3-turbo` | `llama-3.3-70b-versatile` | Very fast, and has a free tier with rate limits |
| Other | any `/audio/transcriptions` model | any `/chat/completions` model | Any OpenAI-compatible service, including a local one |

You can change the models under **Settings → Advanced**.

## Limits

- Subtitles appear 2 to 4 seconds after someone speaks, because each phrase is sent once there's a pause.
- Browser pages (`chrome://`, the Web Store) can't be captured or drawn on.
- It only hears one tab. It doesn't pick up desktop apps such as the Zoom desktop client. For those, use the [Cicada desktop app](https://cicada.indaloop.app).
- It doesn't do Cicada's "speak back" (translating your own voice into the call).
- If you navigate the captured tab to a new page, the subtitle bar disappears but the transcript keeps going. Open the popup to bring it back.

## Files

| File | What it does |
|---|---|
| `manifest.json` | Extension setup (Manifest V3) |
| `background.js` | Service worker: session state, starting and stopping, notes |
| `offscreen.html/js` | Captures the tab's audio, keeps it playing, sends speech to the AI service |
| `recorder-worklet.js` | Audio worklet that streams the raw audio |
| `segmenter.js` | Cuts audio at pauses and encodes WAV (no browser APIs, so it's tested in Node) |
| `ai.js` | Speech-to-text, translation and notes calls |
| `overlay.js` | The subtitle bar on the page |
| `popup.*`, `options.*`, `ui.css` | Popup and settings page |
| `tests/` | `node tests/run.mjs` |

## Licence

MIT. Cicada itself is Apache-2.0; no Cicada code is included here.
