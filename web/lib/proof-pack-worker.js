// B122: keep parsing and cryptographic work away from the page's main thread.
import { verifyProofPack } from './proof-pack-verify.js';
self.onmessage = async ({ data }) => {
  try {
    let pack;
    try { pack = JSON.parse(data.text); }
    catch { self.postMessage({ error: 'This file could not be read as a proof pack. Choose the complete file downloaded from Statements.' }); return; }
    const result = await verifyProofPack(pack, { keys: data.keys, onProgress: checked => self.postMessage({ checked }) });
    const value = pack?.data ?? pack;
    self.postMessage({ result, moreParts: Boolean(value?.truncated || value?.next_cursor), unavailableStatements: value?.statements_unavailable?.length ?? 0 });
  } catch {
    self.postMessage({ error: 'A part of this proof pack could not be read. Check the file with the offline script for more detail.' });
  }
};
