import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { SPEECH_LAUNCHER } from './paths.js';

/** Own the foreground model process; never attach to or kill an unrelated service. */
export function createSpeechBackend({ rootDir, log = () => {},
  command = '/bin/sh', args = [SPEECH_LAUNCHER],
  healthUrl = 'http://127.0.0.1:6197/health', startupTimeoutMs = 90000, fetchImpl = fetch } = {}) {
  let child = null, starting = null, stopping = null;
  let exitPromise, childVariant = null, stopGeneration = 0;
  async function healthy() {
    try {
      const response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return false;
      const body = await response.json();
      return body.status === 'ok' && body.sample_rate === 24000;
    } catch { return false; }
  }
  async function stopOwned() {
    if (stopping) return stopping;
    if (!child) return;
    const owned = child;
    const ended = exitPromise;
    const kill = signal => {
      if (!Number.isInteger(owned.pid) || owned.pid <= 0) return;
      try { process.kill(-owned.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    stopping = (async () => {
      kill('SIGTERM');
      let timer;
      const force = new Promise(resolve => { timer = setTimeout(() => { kill('SIGKILL'); resolve(); }, 5000); });
      await Promise.race([ended, force]);
      clearTimeout(timer);
      // SIGKILL is still asynchronous; release the compute lease only after exit.
      await ended;
      if (child === owned) { child = null; childVariant = null; }
    })();
    try { await stopping; }
    finally { stopping = null; }
  }
  async function stop() {
    // Cancel a pending readiness check too, so it cannot spawn after stop returns.
    stopGeneration += 1;
    const readiness = starting;
    await stopOwned();
    if (readiness) await readiness.catch(() => {});
    await stopOwned();
  }
  async function ensureReady({ signal, variant = '8bit' } = {}) {
    if (process.platform === 'win32') throw new Error('The bundled MLX speech backend requires Apple Silicon macOS.');
    if (variant !== '8bit' && variant !== 'mixed') throw new Error('Unsupported speech backend variant');
    const generation = stopGeneration;
    const checkActive = () => {
      if (signal?.aborted) throw signal.reason || new Error('Speech backend startup aborted');
      if (generation !== stopGeneration) throw new Error('Speech backend stopped');
    };
    // Serialize starts, including callers requesting different variants.
    while (starting) { await starting; checkActive(); }
    const readiness = (async () => {
      if (stopping) await stopping;
      checkActive();
      if (child && childVariant === variant && await healthy()) { checkActive(); return; }
      checkActive();
      if (child) await stopOwned();
      checkActive();
      if (await healthy()) throw new Error('Speech port is occupied by an unowned process');
      checkActive();
      const dir = path.join(rootDir, 'data/speech');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const logFile = path.join(dir, 'backend.log');
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.previous`);
      const fd = fs.openSync(logFile, 'a', 0o600);
      const env = { ...process.env, BREEZE_LOCAL_VARIANT: variant };
      // Both variants are already quantized on disk; never quantize them again.
      delete env.BREEZE_MLX_QUANT;
      try {
        child = spawn(command, args, { detached: true, stdio: ['ignore', fd, fd], shell: false, env });
        childVariant = variant;
      }
      finally { fs.closeSync(fd); }
      const owned = child;
      let failure;
      exitPromise = new Promise(resolve => {
        owned.once('error', error => { failure = error; resolve(); });
        owned.once('close', (code, sig) => { failure ||= new Error(`Speech backend exited (${sig || code})`); resolve(); });
      });
      const start = Date.now();
      try {
        while (Date.now() - start < startupTimeoutMs) {
          checkActive();
          if (failure) throw failure;
          if (await healthy()) { checkActive(); log('[speech] 本地语音模型已就绪'); return; }
          await sleep(250, undefined, { signal });
        }
        throw new Error('Speech model startup timed out');
      } catch (error) { await stopOwned(); throw error; }
    })();
    starting = readiness;
    try { return await readiness; }
    finally { if (starting === readiness) starting = null; }
  }
  return { ensureReady, stop, status: () => ({ running: !!child, starting: !!starting,
    ...(child ? { variant: childVariant } : {}) }) };
}
