import PageFrame from "../../components/PageFrame";
import { checkerDigest } from "../../lib/network-check";
import { joinDigest } from "../../lib/network-join";
import NetworkAdmission from "./NetworkAdmission";
import NetworkContent from "./NetworkContent";

export const metadata = { title: "AnyRoute Network — Anyroute", description: "Private AI needs private hardware. Yours counts. Check your machine, see whether hosting is open and join the waitlist." };
export default function NetworkPage() {
  return <PageFrame><NetworkAdmission><NetworkContent sha={checkerDigest()} joinSha={joinDigest()} /></NetworkAdmission></PageFrame>;
}
