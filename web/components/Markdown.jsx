"use client";
import { memo } from "react";
import { parseBlocks, parseInline } from "../lib/markdown";
import { CopyButton, highlight } from "./UI";
import s from "./Harness.module.css";

const HIGHLIGHT = /^(js|jsx|ts|tsx|javascript|typescript|json|mjs|cjs)$/i;

function Inline({ spans }) {
  return spans.map((x, i) => {
    if (x.type === "text") return x.text;
    if (x.type === "code") return <code key={i}>{x.text}</code>;
    if (x.type === "strong") return <strong key={i}><Inline spans={x.children} /></strong>;
    if (x.type === "em") return <em key={i}><Inline spans={x.children} /></em>;
    if (x.type === "link") return <a key={i} href={x.href} target="_blank" rel="noopener noreferrer nofollow"><Inline spans={x.children} /></a>;
    return null;
  });
}

const lines = (text) => text.split("\n").flatMap((l, i) => (i ? [<br key={i} />, <Inline key={"l" + i} spans={parseInline(l)} />] : [<Inline key={"l" + i} spans={parseInline(l)} />]));

function Blocks({ blocks, renderCode }) { // V82: optional chat code controls.
  return blocks.map((b, i) => {
    switch (b.type) {
      case "code":
        if (renderCode) return <div key={i}>{renderCode(b)}</div>; // V82
        return (
          <div className={s.code} key={i}>
            <div className={s.codeBar}>
              <span>{b.lang || "text"}</span>
              <CopyButton text={b.text} />
            </div>
            <pre tabIndex={0}>
              <code>{HIGHLIGHT.test(b.lang) ? highlight(b.text) : b.text}</code>
            </pre>
          </div>
        );
      case "heading": {
        const H = "h" + Math.min(6, b.level + 2);
        return <H key={i}><Inline spans={parseInline(b.text)} /></H>;
      }
      case "rule":
        return <hr key={i} />;
      case "quote":
        return <blockquote key={i}><Blocks blocks={b.blocks} renderCode={renderCode} /></blockquote>;
      case "list": {
        const L = b.ordered ? "ol" : "ul";
        return (
          <L key={i} start={b.ordered && b.start !== 1 ? b.start : undefined}>
            {b.items.map((it, k) => <li key={k}>{lines(it)}</li>)}
          </L>
        );
      }
      case "table":
        return (
          <div className={s.tableWrap} key={i} tabIndex={0} role="region" aria-label="Table">
            <table>
              <thead><tr>{b.head.map((c, k) => <th key={k}><Inline spans={parseInline(c)} /></th>)}</tr></thead>
              <tbody>{b.rows.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}><Inline spans={parseInline(c)} /></td>)}</tr>)}</tbody>
            </table>
          </div>
        );
      default:
        return <p key={i}>{lines(b.text)}</p>;
    }
  });
}

/** Markdown for model replies: parsed to data first (lib/markdown.js), never injected as HTML. */
function Markdown({ text, renderCode }) { // V82
  return (
    <div className={s.md}>
      <Blocks blocks={parseBlocks(text)} renderCode={renderCode} />
    </div>
  );
}
export default memo(Markdown);
