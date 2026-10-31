import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHeavyCompute } from '../src/heavy-compute.js';
import { createSpeechBackend } from '../src/speech-backend.js';

test('heavy model owners serialize and cancellation cannot release another owner', async () => {
  const q = createHeavyCompute();
  const first = await q.acquire({ kind: 'singing' });
  const ctrl = new AbortController();
  const cancelled = q.acquire({ kind: 'speech', signal: ctrl.signal });
  const rejected = assert.rejects(cancelled);
  ctrl.abort(); await rejected;
  const next = q.acquire({ kind: 'bilibili' });
  assert.deepEqual(q.status(), { active: 'singing', waiting: ['bilibili'] });
  await first(); const release = await next; await first();
  assert.equal(q.status().active, 'bilibili');
  await release(); assert.equal(q.status().active, null);
});
test('stop rejects queued owners without granting access to the active model', async () => {
  const q = createHeavyCompute(), release = await q.acquire();
  const waiting = q.acquire({ kind: 'speech' }), rejected = assert.rejects(waiting, /stopped/);
  q.stop(); await rejected; await release();
  await assert.rejects(q.acquire(), /stopped/);
});
test('backend spawn failure is cleaned up, with no invalid PID or stuck state', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-backend-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const backend = createSpeechBackend({ rootDir: dir, command: '/does-not-exist-breeze', args: [],
    fetchImpl: async () => { throw new Error('not listening'); }, startupTimeoutMs: 1000 });
  await assert.rejects(backend.ensureReady(), /ENOENT/);
  await backend.stop(); assert.deepEqual(backend.status(), { running: false, starting: false });
});
test('backend owns one local child and confirms exit before resolving stop', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-backend-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const script = "require('http').createServer((q,s)=>s.end(JSON.stringify({status:'ok',sample_rate:24000}))).listen(Number(process.argv[1]),'127.0.0.1')";
  const backend = createSpeechBackend({ rootDir: dir, command: process.execPath, args: ['-e', script, String(port)],
    healthUrl: `http://127.0.0.1:${port}/health`, startupTimeoutMs: 5000 });
  t.after(() => backend.stop());
  await Promise.all([backend.ensureReady(), backend.ensureReady()]);
  assert.equal(backend.status().running, true);
  await backend.stop(); assert.equal(backend.status().running, false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
});
