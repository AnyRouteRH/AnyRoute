// What the router's transparency log says about this inventory's hash, read from GET /api/v1/tlog/proof when the page opens. Only
// what the router returns is shown: an entry that is not in the log reads that way, a router without a log says so, and the Rekor
// link appears only when the checkpoint carries an anchor the router has verified.

const HEX64 = /^[0-9a-f]{64}$/;

export const proofUrl = (base, digest) => `${String(base || "").replace(/\/$/, "")}/api/v1/tlog/proof?kind=data_inventory&sha256=${digest}`;

/** The checkpoint text, as a signed note, that the entry is included under. */
export const checkpointUrl = (base) => `${String(base || "").replace(/\/$/, "")}/tlog/checkpoint`;

/**
 * Turn the answer of the proof endpoint into what the page shows.
 *   status  the HTTP status
 *   body    the parsed JSON body, or null
 *   digest  the inventory's SHA-256 the page asked about
 */
export function logState(status, body, digest) {
  if (!HEX64.test(digest || "")) return { phase: "error", reason: "bad_digest" };
  if (status === 200) {
    const d = body?.data;
    if (!d || d.kind !== "data_inventory" || d.sha256 !== digest || !Number.isInteger(d.index)) return { phase: "error", reason: "unexpected_answer" };
    const cp = d.checkpoint && typeof d.checkpoint === "object" ? d.checkpoint : null;
    const anchor = cp?.rekor && typeof cp.rekor === "object" ? cp.rekor : null;
    const rekor =
      anchor && Number.isInteger(anchor.log_index) && anchor.verified?.inclusion === true
        ? {
            logIndex: anchor.log_index,
            // The router's own link to the entry in the log it was submitted to, and the public search page when it is the public log.
            entryUrl: typeof anchor.entry_url === "string" && /^https:\/\//.test(anchor.entry_url) ? anchor.entry_url : null,
            searchUrl: typeof anchor.search_url === "string" && /^https:\/\//.test(anchor.search_url) ? anchor.search_url : null,
            checkpointSize: Number.isInteger(anchor.size) ? anchor.size : null,
          }
        : null;
    return {
      phase: "logged",
      index: d.index,
      checkpointSize: Number.isInteger(cp?.size) ? cp.size : null,
      witnessed: cp?.witnessed === true,
      cosignedBy: Array.isArray(cp?.cosigned_by) ? cp.cosigned_by.filter((x) => typeof x === "string") : [],
      rekor,
    };
  }
  const type = body?.error?.type;
  if (status === 404 && type === "not_logged") return { phase: "not_logged" };
  if (status === 404) return { phase: "no_log" };
  return { phase: "error", reason: `status_${status}` };
}
