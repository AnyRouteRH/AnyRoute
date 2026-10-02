// A same-origin module worker; no blob, eval, or remote executable JavaScript.
export function createProver() {
  const worker = new Worker('/zkapi/prover-worker.js', { type: 'module', name: 'zkapi-prover' });
  let next = 0;
  const pending = new Map();
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    pending.delete(data.id);
    data.error ? job.reject(new Error(data.error)) : job.resolve(data.result);
  };
  worker.onerror = () => {
    for (const job of pending.values()) job.reject(new Error('The proof worker could not start. Check the WASM hosting policy.'));
    pending.clear();
  };
  return {
    call(operation, args = {}) {
      const id = ++next;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ id, operation, args }); });
    },
    dispose() { worker.terminate(); for (const job of pending.values()) job.reject(new Error('Proof worker stopped.')); pending.clear(); },
  };
}
