import { EMPTY_ROOT, verifyConsistency } from "./merkle.ts";
import { cosign, parseCheckpoint, parseNote, verifyNoteSignature, type NoteSigner, type NoteVerifier } from "./note.ts";

// A minimal witness (C2SP tlog-witness semantics, pull mode). It remembers the newest checkpoint it cosigned for a log
// and cosigns a new one only when
//   - the log's own signature on it verifies against the log key the witness was configured with,
//   - it is not smaller than the remembered one,
//   - at the same size it has the same root (a different root is a fork: two views of one log), and
//   - at a larger size a consistency proof from the remembered checkpoint verifies.
// The new state is stored before the cosignature is returned, so a witness never cosigns two forks.

export type WitnessState = { size: number; root: string };
export type WitnessStore = {
  load(origin: string): Promise<WitnessState | null> | WitnessState | null;
  save(origin: string, state: WitnessState): Promise<void> | void;
};
export type ConsistencyFetcher = (from: number, to: number) => Promise<Uint8Array[]>;

export type WitnessResult =
  | { ok: true; size: number; cosignature: string; note: string }
  | { ok: false; code: "malformed" | "wrong_log" | "bad_signature" | "stale" | "fork" | "inconsistent"; reason: string; size?: number };

export class Witness {
  /** Seconds since the Unix epoch, for cosignature timestamps. */
  now: () => number = () => Math.floor(Date.now() / 1000);

  constructor(
    readonly log: NoteVerifier,
    readonly signer: NoteSigner,
    private readonly store: WitnessStore,
  ) {}

  async process(noteText: string, consistency: ConsistencyFetcher): Promise<WitnessResult> {
    let note;
    let cp;
    try {
      note = parseNote(noteText);
      cp = parseCheckpoint(note.text);
    } catch (e) {
      return { ok: false, code: "malformed", reason: (e as Error).message };
    }
    if (cp.origin !== this.log.name) return { ok: false, code: "wrong_log", reason: `the checkpoint is for ${cp.origin}, not ${this.log.name}` };
    if (!verifyNoteSignature(note, this.log)) return { ok: false, code: "bad_signature", reason: "the log's signature on the checkpoint does not verify" };

    const prev = (await this.store.load(cp.origin)) ?? { size: 0, root: EMPTY_ROOT.toString("hex") };
    const prevRoot = Buffer.from(prev.root, "hex");
    if (cp.size < prev.size) return { ok: false, code: "stale", reason: `already cosigned size ${prev.size}; this checkpoint has size ${cp.size}`, size: cp.size };
    if (cp.size === prev.size) {
      if (!cp.root.equals(prevRoot)) return { ok: false, code: "fork", reason: `two different roots for size ${cp.size}: the log shows more than one view`, size: cp.size };
    } else {
      let proof: Uint8Array[];
      try {
        proof = await consistency(prev.size, cp.size);
      } catch (e) {
        return { ok: false, code: "inconsistent", reason: `no consistency proof from ${prev.size} to ${cp.size}: ${(e as Error).message}`, size: cp.size };
      }
      if (!verifyConsistency(prev.size, cp.size, proof, prevRoot, cp.root))
        return { ok: false, code: "inconsistent", reason: `the tree of size ${cp.size} does not extend the one of size ${prev.size} this witness cosigned`, size: cp.size };
    }
    await this.store.save(cp.origin, { size: cp.size, root: cp.root.toString("hex") });
    const line = cosign(this.signer, note.text, this.now());
    return { ok: true, size: cp.size, cosignature: line, note: noteText + line };
  }
}
