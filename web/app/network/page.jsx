import PageFrame from "../../components/PageFrame";
import { checkerDigest } from "../../lib/network-check";
import { joinDigest } from "../../lib/network-join";
import NetworkAdmission from "./NetworkAdmission";
import NetworkContent from "./NetworkContent";

export const metadata = { title: "Network — Anyroute", description: "Private AI needs private hardware. Yours counts. Check your machine, join with the approved build, and inspect host policy, probation and bonds. Payouts are not switched on yet." };
export default function NetworkPage() {
  return <PageFrame><NetworkAdmission><NetworkContent sha={checkerDigest()} joinSha={joinDigest()} /></NetworkAdmission></PageFrame>;
}
