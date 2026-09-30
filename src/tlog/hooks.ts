import type { EntryInput, EntryKind } from "./entries.ts";

// The one call key owners make when they publish or rotate a key: `keyPublished(db, kind)`. It never throws, never
// waits and does nothing unless a transparency log was started for that database (TLOG_ENABLED), so the code that
// creates keys behaves exactly as before when the log is off. The log reads the key tables itself; a caller passes an
// entry only for material that is not stored anywhere (a sidecar's bindings). The data inventory (kind data_inventory) needs no
// call: it is the running code's own, so the log adds it when it starts and on each run (TLOG_DATA_INVENTORY).

export type KeyListener = (kind: EntryKind, entry?: EntryInput) => void;

const listeners = new WeakMap<object, KeyListener>();

export function onKeyPublished(db: object, listener: KeyListener | null): void {
  if (listener) listeners.set(db, listener);
  else listeners.delete(db);
}

export function keyPublished(db: object, kind: EntryKind, entry?: EntryInput): void {
  try {
    listeners.get(db)?.(kind, entry);
  } catch {
    /* a log problem must never break key creation */
  }
}
