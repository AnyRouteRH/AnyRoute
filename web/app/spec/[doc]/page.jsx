import { notFound } from "next/navigation";
import SpecDoc from "../SpecDoc";
import { listDocs, loadDoc } from "../../../lib/seal-spec";

// One page per document in spec/ (the README is /spec/ itself), found when the site is built.
export const dynamicParams = false;

export function generateStaticParams() {
  return listDocs()
    .filter((d) => d.slug)
    .map((d) => ({ doc: d.slug }));
}

export async function generateMetadata({ params }) {
  const doc = loadDoc((await params).doc);
  return doc ? { title: `${doc.title} — Anyroute`, description: doc.description } : {};
}

export default async function SpecDocPage({ params }) {
  const doc = loadDoc((await params).doc);
  if (!doc) notFound();
  return <SpecDoc doc={doc} />;
}
