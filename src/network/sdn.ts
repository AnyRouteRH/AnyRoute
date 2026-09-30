/** Narrow reader for OFAC's classic SDN XML. No entities, DTDs or identity fields are retained. */
export function normalizeEvmAddress(value: string): string | null {
  const trimmed = value.trim();
  return /^0x[0-9a-f]{40}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

function decode(value: string): string {
  return value.replace(/&([^;]+);/g, (_, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (entity in named) return named[entity];
    if (/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity)) {
      const n = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)) return String.fromCodePoint(n);
    }
    throw new Error("Invalid SDN XML entity");
  });
}

export function parseSdnXml(xml: string) {
  const addresses = new Set<string>();
  const stack: string[] = [];
  let listDate: Date | null = null, expected = -1, entries = 0, ignoredCount = 0, digitalCount = 0, roots = 0;
  let idType = "", idNumber = "", capture = "";
  // Validate the entire element structure, including the end of the feed, before replacing anything.
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g;
  let end = 0;
  for (const m of xml.matchAll(tokens)) {
    if (m.index !== end) throw new Error("Malformed SDN XML");
    const token = m[0]; end = m.index + token.length;
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (!token.startsWith("<") || token.startsWith("<![CDATA[")) {
      if (!stack.length && token.trim()) throw new Error("Unexpected SDN XML text");
      if (["idType", "idNumber", "Publish_Date", "Record_Count"].includes(stack.at(-1) ?? "")) capture += token.startsWith("<![CDATA[") ? token.slice(9, -3) : decode(token);
      continue;
    }
    const close = /^<\/([\w:.-]+)\s*>$/.exec(token);
    if (close) {
      const name = close[1].split(":").at(-1)!;
      if (stack.pop() !== name) throw new Error("Unbalanced SDN XML");
      const path = stack.join("/");
      if (name === "idType" && path === "sdnList/sdnEntry/idList/id") idType = capture.trim();
      if (name === "idNumber" && path === "sdnList/sdnEntry/idList/id") idNumber = capture.trim();
      if (name === "id" && path === "sdnList/sdnEntry/idList" && /^Digital Currency Address\s*-\s*\S+/i.test(idType)) {
        digitalCount++;
        // Shape is decisive across EVM chains and token tickers; e.g. BNB's bech32 addresses are ignored.
        const addr = normalizeEvmAddress(idNumber);
        if (addr) addresses.add(addr); else ignoredCount++;
      }
      if (name === "Publish_Date" && path === "sdnList/publshInformation") {
        const date = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(capture.trim());
        if (!date || listDate) throw new Error("Invalid SDN publication date");
        const iso = `${date[3]}-${date[1]}-${date[2]}`;
        listDate = new Date(`${iso}T00:00:00.000Z`);
        if (!Number.isFinite(listDate.getTime()) || listDate.toISOString().slice(0, 10) !== iso) throw new Error("Invalid SDN publication date");
      }
      if (name === "Record_Count" && path === "sdnList/publshInformation") {
        if (expected !== -1 || !/^\d+$/.test(capture.trim())) throw new Error("Invalid SDN record count");
        expected = Number(capture.trim());
      }
      capture = "";
      continue;
    }
    const open = /^<([\w:.-]+)(?:\s+[^<>]*)?\s*\/?>$/.exec(token);
    if (!open) throw new Error("Unsupported SDN XML declaration"); // includes DTDs/entity declarations
    const name = open[1].split(":").at(-1)!;
    if (!stack.length && (name !== "sdnList" || ++roots !== 1)) throw new Error("Expected one SDN list");
    if (["idType", "idNumber", "Publish_Date", "Record_Count"].includes(stack.at(-1) ?? "")) throw new Error("Nested SDN value");
    if (name === "sdnEntry" && stack.join("/") === "sdnList") entries++;
    if (name === "id" && stack.join("/") === "sdnList/sdnEntry/idList") { idType = ""; idNumber = ""; }
    capture = "";
    if (!token.endsWith("/>")) stack.push(name);
  }
  if (end !== xml.length || stack.length || roots !== 1 || !listDate || !entries || expected !== entries || !addresses.size) throw new Error("Incomplete SDN list or no EVM addresses");
  return { addresses: [...addresses].sort(), listDate, ignoredCount, digitalCount };
}
