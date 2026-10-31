import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSpeechBackend } from '../src/speech-backend.js';

const exec = promisify(execFile);
const launcher = new URL('../integrations/breeze/serve.sh', import.meta.url);
const fakeServer = `
const fs = require('node:fs'), http = require('node:http');
const [port, events, marker] = process.argv.slice(1);
const emit = event => fs.appendFileSync(events, JSON.stringify({event,pid:process.pid,
  variant:process.env.BREEZE_LOCAL_VARIANT,quant:process.env.BREEZE_MLX_QUANT || null,marker})+'\\n');
const server = http.createServer((req,res) => res.end(JSON.stringify({status:'ok',sample_rate:24000})));
server.listen(Number(port),'127.0.0.1',()=>emit('ready'));
process.on('SIGTERM',()=>{ emit('term'); setTimeout(()=>{emit('exit');process.exit(0)},300); });
`;

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-variants-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-variants-test-'));
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const eventsFile = path.join(dir, 'events.jsonl');
  const backend = createSpeechBackend({ rootDir: dir, command: process.execPath,
    args: ['-e', fakeServer, String(port), eventsFile, 'original argv stays intact'],
    healthUrl: `http://127.0.0.1:${port}/health`, startupTimeoutMs: 5000 });
  t.after(async () => { await backend.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  const events = async () => {
    try { return (await fs.readFile(eventsFile, 'utf8')).trim().split('\n').map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { backend, events };
}
function exited(pid) {
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
}

test('default is 8bit; concurrent readiness reuses one owned process and preserves custom argv', async t => {
  const { backend, events } = await fixture(t);
  const inherited = process.env.BREEZE_MLX_QUANT;
  process.env.BREEZE_MLX_QUANT = '8';
  try { await Promise.all([backend.ensureReady(), backend.ensureReady()]); }
  finally {
    if (inherited === undefined) delete process.env.BREEZE_MLX_QUANT;
    else process.env.BREEZE_MLX_QUANT = inherited;
  }
  const ready = (await events()).filter(e => e.event === 'ready');
  assert.equal(ready.length, 1);
  assert.equal(ready[0].variant, '8bit');
  assert.equal(ready[0].quant, null);
  assert.equal(ready[0].marker, 'original argv stays intact');
  assert.deepEqual(backend.status(), { running: true, starting: false, variant: '8bit' });
  await backend.stop();
  exited(ready[0].pid);
  assert.deepEqual(backend.status(), { running: false, starting: false });
});

test('invalid variants have no side effects, including while an owned process is ready', async t => {
  const { backend, events } = await fixture(t);
  for (const variant of ['../mixed', '/tmp/model', 'mixed ', 'MIXED', '', 4, null, {}]) {
    await assert.rejects(backend.ensureReady({ variant }), /Unsupported speech backend variant/);
  }
  assert.equal((await events()).length, 0);
  await backend.ensureReady();
  await assert.rejects(backend.ensureReady({ variant: '--model=/tmp/model' }), /Unsupported/);
  assert.deepEqual((await events()).map(e => e.event), ['ready']);
  assert.equal(backend.status().variant, '8bit');
});

test('switch waits for the previous process to exit, then starts mixed; stop waits for exit', async t => {
  const { backend, events } = await fixture(t);
  await backend.ensureReady();
  const firstPid = (await events())[0].pid;
  const switching = backend.ensureReady({ variant: 'mixed' });
  await sleep(60);
  assert.equal((await events()).filter(e => e.event === 'ready').length, 1);
  await switching;
  exited(firstPid);
  const list = await events();
  assert.deepEqual(list.map(e => `${e.variant}:${e.event}`), ['8bit:ready', '8bit:term', '8bit:exit', 'mixed:ready']);
  assert.equal(backend.status().variant, 'mixed');
  const mixedPid = list.at(-1).pid;
  let finished = false;
  const stopping = backend.stop().then(() => { finished = true; });
  await sleep(60);
  assert.equal(finished, false);
  await stopping;
  exited(mixedPid);
  await backend.ensureReady();
  assert.equal(backend.status().variant, '8bit');
});

test('different variants requested during startup serialize and default is restored on a default request', async t => {
  const { backend, events } = await fixture(t);
  await Promise.all([backend.ensureReady(), backend.ensureReady({ variant: 'mixed' })]);
  const ready = (await events()).filter(e => e.event === 'ready');
  assert.deepEqual(ready.map(e => e.variant), ['8bit', 'mixed']);
  exited(ready[0].pid);
  assert.equal(backend.status().variant, 'mixed');
  await backend.ensureReady();
  exited(ready[1].pid);
  assert.equal(backend.status().variant, '8bit');
});

test('stop during a variant switch waits for the old process and prevents replacement startup', async t => {
  const { backend, events } = await fixture(t);
  await backend.ensureReady();
  const pid = (await events())[0].pid;
  const switching = backend.ensureReady({ variant: 'mixed' });
  const rejected = assert.rejects(switching, /stopped/);
  await sleep(60);
  await backend.stop();
  await rejected;
  exited(pid);
  assert.deepEqual((await events()).map(e => `${e.variant}:${e.event}`), ['8bit:ready', '8bit:term', '8bit:exit']);
  assert.deepEqual(backend.status(), { running: false, starting: false });
});

test('an unowned healthy service is neither attached nor stopped for either variant', async t => {
  const dir = await tempDir(t);
  const backend = createSpeechBackend({ rootDir: dir, command: '/never-execute-this', args: [],
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'ok', sample_rate: 24000 }) }) });
  for (const variant of ['8bit', 'mixed']) {
    await assert.rejects(backend.ensureReady({ variant }), /unowned process/);
    await backend.stop();
    assert.deepEqual(backend.status(), { running: false, starting: false });
  }
  await assert.rejects(fs.access(path.join(dir, 'data')), error => error.code === 'ENOENT');
});

test('stop cancels a pending readiness probe before it can start any process', async t => {
  const dir = await tempDir(t);
  let releaseProbe;
  const probe = new Promise(resolve => { releaseProbe = resolve; });
  const backend = createSpeechBackend({ rootDir: dir, command: '/never-execute-this', args: [],
    fetchImpl: async () => { await probe; return { ok: false }; } });
  const readiness = backend.ensureReady({ variant: 'mixed' });
  const rejected = assert.rejects(readiness, /stopped/);
  const stopping = backend.stop();
  releaseProbe();
  await Promise.all([rejected, stopping]);
  assert.deepEqual(backend.status(), { running: false, starting: false });
  await assert.rejects(fs.access(path.join(dir, 'data')), error => error.code === 'ENOENT');
});

test('launcher strictly chooses prepared 8bit or mixed weights with identical inference flags', async t => {
  const dir = await tempDir(t);
  const localDir = path.join(dir, 'breeze-tts', 'local');
  const pythonDir = path.join(dir, 'breeze-venv', 'bin');
  await fs.mkdir(localDir, { recursive: true });
  await fs.mkdir(pythonDir, { recursive: true });
  const script = path.join(localDir, 'serve.sh');
  await fs.copyFile(launcher, script);
  // The launcher contract only needs argv/env capture. A Node shebang here
  // needlessly cold-starts another JS runtime and has timed out under model load.
  // Shell builtins avoid that dependency; NUL framing preserves exact arguments.
  await fs.writeFile(path.join(pythonDir, 'python'), [
    '#!/bin/sh', 'set -eu',
    'printf \'%s\\000\' \'speech-launcher-fixture-v1\' "${BREEZE_MLX_QUANT-unset}" "${BREEZE_MLX_CACHE_GB-unset}" "$@"',
    '',
  ].join('\n'), { mode: 0o700 });
  const run = async variant => {
    const env = { ...process.env, DAFEIYU_WORK_DIR: dir, BREEZE_MLX_QUANT: '4' };
    delete env.BREEZE_SOURCE_DIR; delete env.BREEZE_PYTHON; delete env.BREEZE_MODELS_DIR;
    if (variant === undefined) delete env.BREEZE_LOCAL_VARIANT;
    else env.BREEZE_LOCAL_VARIANT = variant;
    return exec('/bin/sh', [script], { env, timeout: 5000 });
  };
  const capture = async variant => {
    const { stdout, stderr } = await run(variant);
    assert.equal(stderr, '');
    const fields = stdout.split('\0');
    assert.equal(fields.pop(), '', 'fixture output must be fully framed');
    assert.equal(fields.shift(), 'speech-launcher-fixture-v1');
    const [quant, cache, ...args] = fields;
    return { quant, cache, args };
  };
  const defaultRun = await capture();
  const eight = await capture('8bit');
  const mixed = await capture('mixed');
  assert.deepEqual(defaultRun, eight);
  assert.equal(eight.args[2], path.join(dir, 'breeze-models', '8bit'));
  assert.equal(mixed.args[2], path.join(dir, 'breeze-models', 'mixed'));
  assert.deepEqual(eight.args.slice(3), mixed.args.slice(3));
  assert.deepEqual(eight.args.slice(3), ['--backend', 'mlx', '--host', '127.0.0.1', '--port', '6197',
    '--ws-port', 'disabled', '--voices-dir', path.join(dir, 'breeze-models', 'voices'), '--chunk-first', '1', '--chunk-max', '25']);
  assert.equal(eight.quant, 'unset');
  assert.equal(mixed.quant, 'unset');
  assert.equal(eight.cache, '1');
  for (const variant of ['../mixed', '/tmp/model', 'mixed ', 'MIXED', '']) {
    await assert.rejects(run(variant), error => error.code === 2 && error.stdout === '' && error.stderr.trim() === 'Unsupported speech backend variant');
  }
});
