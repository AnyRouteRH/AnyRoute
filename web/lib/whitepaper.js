// Server-side only: the root document is the single source for the static page.
import fs from "node:fs";
import path from "node:path";
import { renderMarkdown } from "./spec-markdown.js";
import { listDocs, REPO_URL, specDir } from "./seal-spec.js";

export function resolveWhitepaperHref(href, docs) {
  if (href.startsWith("#")) return { href, external: false };
  if (/^https:\/\/anyroute\.tech\//.test(href)) {
    const url = new URL(href);
    return { href: url.pathname + url.search + url.hash, external: false };
  }
  if (/^(https?:|mailto:)/i.test(href)) return { href, external: true };
  const [file, fragment] = href.split("#");
  const suffix = fragment ? `#${fragment}` : "";
  const target = path.posix.normalize(file);
  if (target.startsWith("..") || path.posix.isAbsolute(target)) return null;
  const spec = docs.find((doc) => `spec/${doc.file}` === target);
  if (spec) return { href: spec.url + suffix, external: false };
  const page = /^web\/app\/(.+)\/page\.jsx$/.exec(target);
  if (page) return { href: `/${page[1]}/` + suffix, external: false };
  return { href: `${REPO_URL}/blob/main/${target}${suffix}`, external: true };
}

export function loadWhitepaper(root = path.dirname(specDir())) {
  const src = fs.readFileSync(path.join(root, "WHITEPAPER.md"), "utf8");
  const docs = listDocs(path.join(root, "spec"));
  return {
    src,
    ...renderMarkdown(src, {
      stripTitle: true,
      resolveHref: (href) => resolveWhitepaperHref(href, docs),
    }),
  };
}
