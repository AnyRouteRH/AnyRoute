// A small Markdown renderer for the SEAL specification (spec/*.md), run at build time. It covers the subset those
// documents use: ATX headings with GitHub-style anchors, pipe tables with alignment, bullet and numbered lists,
// fenced code, blockquotes, rules, paragraphs, and inline code, bold, italic, inline links, reference links and bare
// web addresses. Every piece of source text is HTML-escaped; the only markup in the output is the markup written here.

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const BULLET = /^( {0,3})([-*+])\s+(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const REF_DEF = /^ {0,3}\[([^\]]+)\]:\s*(\S+)(?:\s+"[^"]*")?\s*$/;
const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/** Escape text for HTML element content and double-quoted attributes. */
export function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Reference labels match case-insensitively with collapsed whitespace, as in CommonMark. */
const refKey = (label) => label.trim().replace(/\s+/g, " ").toLowerCase();

/** Only web, mail, relative and fragment links become links; any other scheme stays text. */
export function safeHref(href) {
  const h = String(href || "").trim();
  if (!h) return null;
  if (/^(https?:|mailto:)/i.test(h)) return h;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null;
  return h;
}

const isWordChar = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);
const isSpace = (ch) => ch === undefined || /\s/.test(ch);

/** Index just past the code span that opens with the backtick run at i, or -1 when the run is never closed. */
function codeSpanEnd(s, i) {
  let n = 1;
  while (s[i + n] === "`") n++;
  let j = i + n;
  for (;;) {
    const close = s.indexOf("`".repeat(n), j);
    if (close < 0) return -1;
    let m = n;
    while (s[close + m] === "`") m++;
    if (m === n) return close + n;
    j = close + m;
  }
}

// ---------- inline ----------

/** Split a table row into cells on pipes that are neither escaped nor inside a code span. */
export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (ch === "`") {
      const end = codeSpanEnd(s, i);
      let n = 1;
      while (s[i + n] === "`") n++;
      const stop = end < 0 ? i + n : end;
      cur += s.slice(i, stop);
      i = stop - 1;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Index of the `]` closing the `[` at open (nested brackets and code spans allowed), or -1. */
function closeBracket(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") i++;
    else if (ch === "`") {
      const end = codeSpanEnd(s, i);
      if (end > 0) i = end - 1;
    } else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return i;
  }
  return -1;
}

/** Index of the `)` closing the `(` at open (balanced parentheses allowed), or -1. */
function closeParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Link destination from the text between the parentheses: <dest> or dest, with an optional "title". */
function linkDest(raw) {
  const m = raw.trim().match(/^(?:<([^>]*)>|(\S*))(?:\s+"[^"]*")?$/);
  return m ? (m[1] ?? m[2]) : null;
}

/** Where the emphasis opened at i with marker closes, or -1. Underscores never open or close inside a word. */
function closeEmphasis(s, i, marker) {
  const ch = marker[0];
  for (let j = s.indexOf(marker, i + marker.length); j > 0; j = s.indexOf(marker, j + 1)) {
    if (s[j - 1] === "\\") continue;
    if (isSpace(s[j - 1])) continue;
    if (marker.length === 1 && (s[j + 1] === ch || s[j - 1] === ch)) continue;
    if (ch === "_" && isWordChar(s[j + marker.length])) continue;
    if (j === i + marker.length) continue;
    return j;
  }
  return -1;
}

/** Parse inline Markdown into a tree of text, code, strong, em and link nodes. refs maps labels to URLs. */
export function parseInline(src, refs = {}, { links = true } = {}) {
  const s = String(src ?? "");
  const out = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };
  const push = (node) => {
    flush();
    out.push(node);
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && PUNCT.test(s[i + 1] || "")) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const end = codeSpanEnd(s, i);
      if (end < 0) {
        text += s.slice(i, i + n);
        i += n;
        continue;
      }
      let code = s.slice(i + n, end - n).replace(/\n/g, " ");
      if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
      push({ type: "code", text: code });
      i = end;
      continue;
    }
    if (ch === "[" && links) {
      const close = closeBracket(s, i);
      if (close > i) {
        const label = s.slice(i + 1, close);
        if (s[close + 1] === "(") {
          const end = closeParen(s, close + 1);
          const dest = end > close ? linkDest(s.slice(close + 2, end)) : null;
          if (dest !== null) {
            push({ type: "link", href: dest, children: parseInline(label, refs, { links: false }) });
            i = end + 1;
            continue;
          }
        }
        const full = s.slice(close + 1).match(/^\[([^\]]*)\]/);
        const key = refKey(full && full[1] ? full[1] : label);
        if (key && refs[key] !== undefined) {
          push({ type: "link", href: refs[key], children: parseInline(label, refs, { links: false }) });
          i = close + 1 + (full ? full[0].length : 0);
          continue;
        }
      }
    }
    if (links && (ch === "h" || ch === "w") && !isWordChar(s[i - 1])) {
      const m = s.slice(i).match(/^(?:https?:\/\/|www\.)[^\s<>`]+/);
      if (m) {
        let url = m[0];
        // Trailing punctuation ends the sentence, not the address; so does an unbalanced closing parenthesis.
        for (;;) {
          if (/[.,:;!?'"*_~]$/.test(url)) url = url.slice(0, -1);
          else if (url.endsWith(")") && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
          else break;
        }
        push({ type: "link", href: url.startsWith("www.") ? "https://" + url : url, children: [{ type: "text", text: url }] });
        i += url.length;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      const marker = s[i + 1] === ch ? ch + ch : ch;
      const after = s[i + marker.length];
      const opens = !isSpace(after) && after !== ch && (ch === "*" || !isWordChar(s[i - 1]));
      const close = opens ? closeEmphasis(s, i, marker) : -1;
      if (close > 0) {
        push({ type: marker.length === 2 ? "strong" : "em", children: parseInline(s.slice(i + marker.length, close), refs, { links }) });
        i = close + marker.length;
        continue;
      }
      text += marker;
      i += marker.length;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** Plain text of inline Markdown: code without backticks, links as their text, no emphasis markers. */
export function plainText(src, refs = {}) {
  const walk = (nodes) => nodes.map((n) => (n.children ? walk(n.children) : n.text)).join("");
  return walk(parseInline(src, refs));
}

/** Links found in inline Markdown, as { text, href } with href as written. */
export function inlineLinks(src, refs = {}) {
  const found = [];
  const textOf = (nodes) => nodes.map((n) => (n.children ? textOf(n.children) : n.text)).join("");
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === "link") found.push({ text: textOf(n.children), href: n.href });
      else if (n.children) walk(n.children);
    }
  };
  walk(parseInline(src, refs));
  return found;
}

/** Render inline Markdown to HTML. resolveHref(href) may return a string, { href, external }, or null for text. */
export function renderInline(src, opts = {}) {
  const { refs = {}, resolveHref } = opts;
  const render = (nodes) =>
    nodes
      .map((n) => {
        if (n.type === "text") return escapeHtml(n.text);
        if (n.type === "code") return `<code>${escapeHtml(n.text)}</code>`;
        if (n.type === "strong") return `<strong>${render(n.children)}</strong>`;
        if (n.type === "em") return `<em>${render(n.children)}</em>`;
        if (n.type === "link") {
          const inner = render(n.children);
          const safe = safeHref(n.href);
          const resolved = safe && resolveHref ? resolveHref(safe) : safe;
          const href = typeof resolved === "string" ? resolved : resolved?.href;
          if (!href) return inner;
          const external = resolved && typeof resolved === "object" && "external" in resolved ? resolved.external : /^https?:/i.test(href);
          return `<a href="${escapeHtml(href)}"${external ? ' rel="noopener noreferrer" target="_blank"' : ""}>${inner}</a>`;
        }
        return "";
      })
      .join("");
  return render(parseInline(src, refs));
}

// ---------- anchors ----------

/** GitHub's heading anchor: lower case, punctuation removed (letters, numbers, _ and - kept), spaces to hyphens. */
export function slugify(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** A slugger that suffixes repeats with -1, -2, ... in document order, as GitHub does. */
export function slugger() {
  const seen = new Set();
  return (text) => {
    const base = slugify(text);
    let slug = base;
    for (let n = 1; seen.has(slug); n++) slug = `${base}-${n}`;
    seen.add(slug);
    return slug;
  };
}

// ---------- blocks ----------

/** Take reference definitions ([label]: url) out of the source; lines inside fenced code are left alone. */
export function extractRefs(src) {
  const refs = {};
  const kept = [];
  let fence = null;
  for (const line of String(src ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      const c = line.match(FENCE_CLOSE);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null;
      kept.push(line);
      continue;
    }
    const f = line.match(FENCE_OPEN);
    if (f) fence = f[1];
    const m = !f && line.match(REF_DEF);
    if (m) {
      const key = refKey(m[1]);
      if (refs[key] === undefined) refs[key] = m[2].replace(/^<(.*)>$/, "$1");
      continue;
    }
    kept.push(line);
  }
  return { refs, text: kept.join("\n") };
}

const isTableStart = (line, next) => line.includes("|") && next !== undefined && TABLE_SEP.test(next);
const startsBlock = (line, next) =>
  FENCE_OPEN.test(line) || HEADING.test(line) || QUOTE.test(line) || RULE.test(line) || BULLET.test(line) || ORDERED.test(line) || isTableStart(line, next);
const indentOf = (line) => line.match(/^ */)[0].length;

/** Parse Markdown into blocks: heading, code, table, list, quote, rule, paragraph. */
export function parseBlocks(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(FENCE_OPEN);
    if (fence) {
      const indent = indentOf(line);
      const body = [];
      for (i++; i < lines.length; i++) {
        const c = lines[i].match(FENCE_CLOSE);
        if (c && c[1][0] === fence[1][0] && c[1].length >= fence[1].length) break;
        body.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))));
      }
      i++;
      blocks.push({ type: "code", lang: fence[2] || "", text: body.join("\n") });
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length, text: (h[2] || "").trim() });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|") && !FENCE_OPEN.test(lines[i]) && !HEADING.test(lines[i]); i++) {
        const cells = splitRow(lines[i]);
        rows.push(head.map((_, k) => cells[k] ?? ""));
      }
      blocks.push({ type: "table", head, align: head.map((_, k) => align[k] ?? null), rows });
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      for (; i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines[i], lines[i + 1])); i++) {
        const q = lines[i].match(QUOTE);
        body.push(q ? q[1] : lines[i]);
      }
      blocks.push({ type: "quote", blocks: parseBlocks(body.join("\n")) });
      continue;
    }

    const first = line.match(BULLET) || line.match(ORDERED);
    if (first) {
      const ordered = !BULLET.test(line);
      const sameList = (l) => {
        const m = ordered ? l.match(ORDERED) : l.match(BULLET);
        return m && (ordered ? m[3] === first[3] : m[2] === first[2]) ? m : null;
      };
      const items = [];
      let loose = false;
      for (;;) {
        const m = sameList(lines[i]);
        const content = ordered ? m[4] : m[3];
        const contentIndent = m[0].length - content.length;
        const body = [content];
        // Continuation: lines indented under the item (blank lines included when more indented text follows),
        // and lazy lines that continue the item's paragraph.
        for (i++; i < lines.length; i++) {
          const next = lines[i];
          if (!next.trim()) {
            const after = lines.slice(i + 1).find((x) => x.trim());
            if (after !== undefined && indentOf(after) >= Math.min(contentIndent, 2)) {
              body.push("");
              continue;
            }
            break;
          }
          if (indentOf(next) >= Math.min(contentIndent, 2)) body.push(next.slice(Math.min(contentIndent, indentOf(next))));
          else if (!startsBlock(next, lines[i + 1]) && body[body.length - 1] !== "") body.push(next.trim());
          else break;
        }
        while (body.length && body[body.length - 1] === "") body.pop();
        items.push(body.join("\n"));
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j >= lines.length || !sameList(lines[j])) break;
        if (j > i) loose = true;
        i = j;
      }
      blocks.push({
        type: "list",
        ordered,
        start: ordered ? Number(first[2]) : 1,
        loose,
        items: items.map((text) => ({ text, blocks: /\n/.test(text) ? parseBlocks(text) : null })),
      });
      continue;
    }

    const body = [line.trim()];
    for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1]); i++) body.push(lines[i].trim());
    blocks.push({ type: "paragraph", text: body.join("\n") });
  }
  return blocks;
}

/**
 * Render a Markdown document to HTML.
 * Options: resolveHref(href) rewrites links (return null to render the text only); stripTitle leaves the first
 * level-1 heading out of the HTML (it is still returned as title).
 * Returns { html, title: { text, html, id } | null, headings: [{ level, id, text }], refs }.
 */
export function renderMarkdown(src, opts = {}) {
  const { refs, text } = extractRefs(src);
  const inline = (s) => renderInline(s, { refs, resolveHref: opts.resolveHref });
  const slug = slugger();
  const headings = [];
  let title = null;

  const renderBlocks = (blocks, tight = false) =>
    blocks
      .map((b) => {
        switch (b.type) {
          case "heading": {
            const plain = plainText(b.text, refs);
            const id = slug(plain);
            if (b.level === 1 && title === null) {
              title = { text: plain, html: inline(b.text), id };
              if (opts.stripTitle) return "";
            }
            headings.push({ level: b.level, id, text: plain });
            return `<h${b.level} id="${escapeHtml(id)}">${inline(b.text)}<a class="heading-anchor" href="#${escapeHtml(id)}" aria-label="Link to this section">#</a></h${b.level}>`;
          }
          case "code":
            return `<div class="code-panel"><div class="code-bar"><span>${escapeHtml(b.lang || "text")}</span></div><pre tabindex="0"><code>${escapeHtml(b.text)}</code></pre></div>`;
          case "table": {
            const style = (k) => (b.align[k] ? ` style="text-align:${b.align[k]}"` : "");
            // A header row with no text (key-value tables) is left out rather than drawn empty.
            const thead = b.head.some((c) => c.trim()) ? `<thead><tr>${b.head.map((c, k) => `<th scope="col"${style(k)}>${inline(c)}</th>`).join("")}</tr></thead>` : "";
            const tbody = `<tbody>${b.rows.map((r) => `<tr>${r.map((c, k) => `<td${style(k)}>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
            return `<div class="table-wrap" role="region" aria-label="Table" tabindex="0"><table>${thead}${tbody}</table></div>`;
          }
          case "list": {
            const tag = b.ordered ? "ol" : "ul";
            const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : "";
            const items = b.items.map((it) => `<li>${it.blocks ? renderBlocks(it.blocks, !b.loose) : b.loose ? `<p>${inline(it.text)}</p>` : inline(it.text)}</li>`);
            return `<${tag}${start}>${items.join("")}</${tag}>`;
          }
          case "quote":
            return `<blockquote>${renderBlocks(b.blocks)}</blockquote>`;
          case "rule":
            return "<hr>";
          case "paragraph":
            return tight ? inline(b.text) : `<p>${inline(b.text)}</p>`;
          default:
            return "";
        }
      })
      .join("\n");

  const html = renderBlocks(parseBlocks(text));
  return { html, title, headings, refs };
}
