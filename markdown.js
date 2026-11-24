// Turns a session into a Markdown file, and renders simple Markdown for display.

export function sessionToMarkdown(session) {
  const date = session.startedAt ? new Date(session.startedAt).toLocaleString() : "";
  const out = [`# ${session.title || "Session"}`, "", date ? `_${date}_` : "", ""];
  if (session.notes) out.push(session.notes.trim(), "", "---", "");
  out.push("## Transcript", "");
  for (const l of session.lines) {
    out.push(`**[${l.time}]** ${l.text}`);
    if (l.translation && l.translation.trim() !== l.text.trim()) out.push(`> ${l.translation}`);
    out.push("");
  }
  return out.join("\n");
}

function esc(t) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(t) {
  return esc(t)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

// Small, safe renderer: headings, bullets, numbered lists, paragraphs.
export function renderMarkdown(md) {
  const html = [];
  let list = null;
  const close = () => { if (list) { html.push(`</${list}>`); list = null; } };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      close();
      const n = Math.min(4, m[1].length + 1);
      html.push(`<h${n}>${inline(m[2])}</h${n}>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== "ul") { close(); html.push("<ul>"); list = "ul"; }
      html.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== "ol") { close(); html.push("<ol>"); list = "ol"; }
      html.push(`<li>${inline(m[1])}</li>`);
    } else if (!line.trim()) {
      close();
    } else {
      close();
      html.push(`<p>${inline(line)}</p>`);
    }
  }
  close();
  return html.join("");
}
