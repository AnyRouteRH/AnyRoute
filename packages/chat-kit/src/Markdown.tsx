import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { parseBlocks, parseInline, type Block, type Span } from "./markdown-parse";

/** A button that copies text and says so for a moment (announced to screen readers). */
export function CopyButton({ text, label = "Copy code" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1500);
    } catch {
      /* clipboard refused: nothing to say */
    }
  };
  return (
    <button type="button" className="ark-copy" onClick={copy} aria-label={done ? "Copied" : label}>
      <span aria-live="polite">{done ? "Copied" : "Copy"}</span>
    </button>
  );
}

function Inline({ spans }: { spans: Span[] }): ReactNode {
  return spans.map((x, i) => {
    if (x.type === "text") return x.text;
    if (x.type === "code") return <code key={i}>{x.text}</code>;
    if (x.type === "strong")
      return (
        <strong key={i}>
          <Inline spans={x.children} />
        </strong>
      );
    if (x.type === "em")
      return (
        <em key={i}>
          <Inline spans={x.children} />
        </em>
      );
    return (
      <a key={i} href={x.href} target="_blank" rel="noopener noreferrer nofollow">
        <Inline spans={x.children} />
      </a>
    );
  });
}

const lines = (text: string) => text.split("\n").flatMap((l, i) => (i ? [<br key={i} />, <Inline key={"l" + i} spans={parseInline(l)} />] : [<Inline key={"l" + i} spans={parseInline(l)} />]));

function Blocks({ blocks }: { blocks: Block[] }): ReactNode {
  return blocks.map((b, i) => {
    switch (b.type) {
      case "code":
        return (
          <div className="ark-code" key={i}>
            <div className="ark-code-bar">
              <span>{b.lang || "text"}</span>
              <CopyButton text={b.text} />
            </div>
            <pre tabIndex={0}>
              <code>{b.text}</code>
            </pre>
          </div>
        );
      case "heading": {
        const H = `h${Math.min(6, b.level + 2)}` as "h3";
        return (
          <H key={i}>
            <Inline spans={parseInline(b.text)} />
          </H>
        );
      }
      case "rule":
        return <hr key={i} />;
      case "quote":
        return (
          <blockquote key={i}>
            <Blocks blocks={b.blocks} />
          </blockquote>
        );
      case "list": {
        const L = b.ordered ? "ol" : "ul";
        return (
          <L key={i} start={b.ordered && b.start !== 1 ? b.start : undefined}>
            {b.items.map((it, k) => (
              <li key={k}>{lines(it)}</li>
            ))}
          </L>
        );
      }
      case "table":
        return (
          <div className="ark-table" key={i} tabIndex={0} role="region" aria-label="Table">
            <table>
              <thead>
                <tr>
                  {b.head.map((c, k) => (
                    <th key={k}>
                      <Inline spans={parseInline(c)} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, k) => (
                  <tr key={k}>
                    {r.map((c, j) => (
                      <td key={j}>
                        <Inline spans={parseInline(c)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      default:
        return <p key={i}>{lines(b.text)}</p>;
    }
  });
}

/** Markdown for replies: parsed to data first, never injected as HTML. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="ark-md">
      <Blocks blocks={parseBlocks(text)} />
    </div>
  );
});
