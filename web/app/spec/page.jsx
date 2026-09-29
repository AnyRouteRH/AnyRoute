import SpecDoc from "./SpecDoc";
import { loadDoc } from "../../lib/seal-spec";

export const metadata = {
  title: "SEAL specification — Anyroute",
  description: "The SEAL privacy protocol: lanes, guarantees, who learns what, honest limits and the status of each part, with the five RFC-style documents. Apache-2.0.",
};

export default function SpecIndex() {
  return <SpecDoc doc={loadDoc("")} />;
}
