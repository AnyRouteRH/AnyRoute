// J185: render server-built words without interpreting approval metadata in the browser.
export default function ApprovalContext({ lines }) {
  if (!Array.isArray(lines)) return null;
  return <div style={{ overflowWrap: 'anywhere' }}>{lines.filter(line => typeof line === 'string' && line).map((line, index) => <p className="help-text" key={index}>{line}</p>)}</div>;
}
