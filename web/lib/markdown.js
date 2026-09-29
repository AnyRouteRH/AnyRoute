// A small, safe Markdown reader for model replies. It returns plain data (blocks and inline spans);
// components/Markdown.jsx turns that into React elements, so no HTML string is ever injected.
// Streaming-friendly: an unclosed code fence is a code block that runs to the end of the text.

const FENCE = /^\s{0,3}(```|~~~)\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

/** Text → blocks: code, heading, list, quote, rule, table, paragraph. */
export function parseBlocks(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      const closed = i < lines.length;
      i++;
      blocks.push({ type: "code", lang: fence[2] || "", text: body.join("\n"), closed });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(HEADING);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      blocks.push({ type: "table", head, rows });
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].match(QUOTE)[1]);
      blocks.push({ type: "quote", blocks: parseBlocks(body.join("\n")) });
      continue;
    }
    const b = line.match(BULLET);
    const o = line.match(ORDERED);
    if (b || o) {
      const ordered = !b;
      const start = o ? Number(o[2]) : 1;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = ordered ? l.match(ORDERED) : l.match(BULLET);
        if (m) {
          items.push(ordered ? m[3] : m[2]);
          i++;
        } else if (l.trim() && /^\s{2,}/.test(l) && items.length) {
          items[items.length - 1] += "\n" + l.trim();
          i++;
        } else if (!l.trim() && i + 1 < lines.length && (ordered ? ORDERED : BULLET).test(lines[i + 1])) {
          i++;
        } else break;
      }
      blocks.push({ type: "list", ordered, start, items });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !QUOTE.test(lines[i]) && !BULLET.test(lines[i]) && !ORDERED.test(lines[i]) && !RULE.test(lines[i])) para.push(lines[i++]);
    if (para.length) blocks.push({ type: "p", text: para.join("\n") });
    else i++;
  }
  return blocks;
}

const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*((?:[^*\n]|\*(?!\*))+?)\*\*|__([^_\n]+?)__|\*([^*\s][^*\n]*?)\*|(?<![\w])_([^_\s][^_\n]*?)_(?![\w])|\[([^\]\n]+)\]\((\S+?)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** Only http(s) and mailto links are kept; anything else renders as plain text. */
export const safeHref = (url) => (/^(https?:\/\/|mailto:)/i.test(String(url)) ? String(url) : null);

/** One line of text → inline spans: text, code, strong, em, link. */
export function parseInline(src) {
  const text = String(src ?? "");
  const out = [];
  let last = 0;
  const re = new RegExp(INLINE.source, "g"); // per call: spans recurse, so a shared lastIndex would loop forever
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    if (m[2] !== undefined) out.push({ type: "code", text: m[2].replace(/^ (.*) $/, "$1") });
    else if (m[3] !== undefined || m[4] !== undefined) out.push({ type: "strong", children: parseInline(m[3] ?? m[4]) });
    else if (m[5] !== undefined || m[6] !== undefined) out.push({ type: "em", children: parseInline(m[5] ?? m[6]) });
    else if (m[7] !== undefined) {
      const href = safeHref(m[8]);
      out.push(href ? { type: "link", href, children: parseInline(m[7]) } : { type: "text", text: m[0] });
    } else if (m[9] !== undefined) out.push({ type: "link", href: m[9], children: [{ type: "text", text: m[9] }] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}
