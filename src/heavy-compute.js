/** One local model at a time on the 16 GB Mac. All model owners release on exit. */
export function createHeavyCompute() {
  let current = null;
  let closed = false;
  const waiting = [];
  function pump() {
    if (closed || current || !waiting.length) return;
    const ticket = waiting.shift();
    ticket.cleanup();
    current = ticket;
    let released = false;
    ticket.resolve(async () => {
      if (released) return;
      released = true;
      if (current === ticket) current = null;
      pump();
    });
  }
  function acquire({ kind = 'model', signal, timeoutMs = 120000 } = {}) {
    if (closed) return Promise.reject(new Error('Local compute queue stopped'));
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('Aborted'));
    return new Promise((resolve, reject) => {
      let timer;
      const ticket = { kind, resolve, reject, cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); } };
      const cancel = () => {
        const at = waiting.indexOf(ticket);
        if (at < 0) return;
        waiting.splice(at, 1); ticket.cleanup();
        reject(signal?.reason || new Error('Waiting for local model timed out'));
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (timeoutMs > 0) timer = setTimeout(cancel, timeoutMs);
      waiting.push(ticket);
      pump();
    });
  }
  return {
    acquire,
    status: () => ({ active: current?.kind || null, waiting: waiting.map(t => t.kind) }),
    stop() {
      closed = true;
      // Abort pending owners through their normal timeout/error path.
      for (const ticket of waiting.splice(0)) { ticket.cleanup(); ticket.reject(new Error('Local compute queue stopped')); }
    },
  };
}
