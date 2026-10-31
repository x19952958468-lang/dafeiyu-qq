import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as wait } from 'node:timers/promises';
import { createLoginServer } from '../src/bilibili/server.js';
import { createPersonaEditor } from '../src/persona-editor.js';

const BODY_SECRET = 'BODY_CONTENT_MUST_NEVER_BE_LOGGED';
const HEADER_SECRET = 'PRIVATE_HEADER_MUST_NEVER_BE_LOGGED';
const QUERY_SECRET = 'PRIVATE_QUERY_MUST_NEVER_BE_LOGGED';
const EXCEPTION_SECRET = 'PRIVATE_EXCEPTION_MUST_NEVER_BE_LOGGED';

async function fixture(t, { failSave = false, throwDiagnosticLog = false, csrfToken } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-request-diag-'));
  fs.mkdirSync(path.join(rootDir, 'persona'));
  const activeFile = path.join(rootDir, 'persona/active.md');
  fs.writeFileSync(activeFile, '原来的人设');
  const cfg = { persona: { file: 'persona/active.md' }, trigger: {}, bilibili: { enabled: false }, singing: { version: 'd' } };
  const configFile = path.join(rootDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(cfg));
  const applied = [], calls = [], logs = [];
  const editor = createPersonaEditor({ rootDir, cfg, onApply: entry => applied.push(entry.text) });
  const companion = Object.fromEntries(['status', 'friends', 'configure', 'createQr', 'pollQr', 'runNow'].map(name => [name, async () => { calls.push(name); return {}; }]));
  const personaEditor = failSave ? { ...editor, save() { throw new Error(EXCEPTION_SECRET); } } : editor;
  const server = createLoginServer({ companion, personaEditor, port: 0, csrfToken, log(line) {
    logs.push(line);
    if (throwDiagnosticLog && line.startsWith('[local-ui-request]')) throw new Error('Diagnostic logger failed');
  } });
  const address = await server.start();
  t.after(async () => { await server.stop(); fs.rmSync(rootDir, { recursive: true, force: true }); });
  const html = await (await fetch(address.url)).text();
  const csrf = html.match(/name="csrf-token" content="([^"]+)"/)[1];
  const post = (body, { headers = {}, route = `/api/persona?private=${QUERY_SECRET}`, raw = false } = {}) => fetch(address.url + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-Private': HEADER_SECRET, ...headers },
    body: raw ? body : JSON.stringify(body),
  });
  return { ...address, rootDir, activeFile, configFile, editor, cfg, applied, calls, logs, csrf, post };
}

function diagnosticLines(f, id) {
  return f.logs.filter(line => line.startsWith('[local-ui-request]') && (!id || line.includes(`id=${id} `)));
}
function checkPrivacy(f) {
  const all = f.logs.join('\n');
  for (const privateValue of [BODY_SECRET, HEADER_SECRET, QUERY_SECRET, EXCEPTION_SECRET, f.csrf, f.rootDir]) assert.ok(!all.includes(privateValue));
  for (const line of diagnosticLines(f)) assert.match(line, /^\[local-ui-request\] id=[a-f0-9]{16} path=\/api\/persona stage=(start|body-end|finish|aborted|closed) phase=(headers|csrf|body|validate|save) status=\d+ bytes=\d+ responseBytes=\d+$/);
}
async function responseTrace(f, response) {
  const id = response.headers.get('x-request-id');
  assert.match(id, /^[a-f0-9]{16}$/);
  const body = await response.text();
  const lines = diagnosticLines(f, id);
  assert.ok(lines.some(line => line.includes('stage=start ')));
  const finish = lines.find(line => line.includes('stage=finish '));
  assert.ok(finish, `No completion for ${id}`);
  assert.ok(finish.includes(`status=${response.status} `));
  assert.ok(finish.endsWith(`responseBytes=${Buffer.byteLength(body)}`));
  checkPrivacy(f);
  return { id, body: JSON.parse(body), finish, lines };
}

test('successful real HTTP save records byte counts and the response request id without text', async t => {
  const f = await fixture(t);
  const request = { text: `中英文😀\n${BODY_SECRET}`, revision: f.editor.state().revision };
  const response = await f.post(request);
  assert.equal(response.status, 200);
  const trace = await responseTrace(f, response);
  assert.match(trace.finish, /phase=save status=200 /);
  assert.ok(trace.finish.includes(`bytes=${Buffer.byteLength(JSON.stringify(request))} `));
  assert.ok(trace.lines.some(line => line.includes('stage=body-end phase=body ')));
  assert.equal(trace.body.text, request.text);
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), request.text);
  assert.deepEqual(f.applied, [request.text]);
  assert.deepEqual(f.calls, []);
});

test('JSON/shape/body/store rejections are logged with their actual phase and do not save', async t => {
  const f = await fixture(t), original = f.editor.state(), config = fs.readFileSync(f.configFile);
  const cases = [
    { body: '{', raw: true, expected: 400, phase: 'body' },
    { body: { text: BODY_SECRET, revision: 'invalid' }, expected: 400, phase: 'validate' },
    { body: { text: BODY_SECRET, revision: '0'.repeat(64) }, expected: 409, phase: 'save' },
    { body: { text: BODY_SECRET, revision: original.revision }, headers: { 'Content-Type': 'text/plain' }, expected: 415, phase: 'body' },
    { body: { text: 'x'.repeat(800000), revision: original.revision }, expected: 413, phase: 'body' },
  ];
  const ids = new Set();
  for (const item of cases) {
    const response = await f.post(item.body, item);
    assert.equal(response.status, item.expected);
    const trace = await responseTrace(f, response);
    assert.ok(trace.finish.includes(`phase=${item.phase} `));
    ids.add(trace.id);
  }
  assert.equal(ids.size, cases.length);
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), original.text);
  assert.deepEqual(fs.readFileSync(f.configFile), config);
  assert.deepEqual(f.applied, []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.editor.state().backups, []);
});

test('CSRF and Origin refusals produce traceable 403 without reading or changing persona', async t => {
  const f = await fixture(t), before = f.editor.state();
  const data = { text: BODY_SECRET, revision: before.revision };
  for (const [headers, phase] of [
    [{ 'X-CSRF-Token': 'incorrect' }, 'csrf'],
    [{ Origin: 'https://elsewhere.invalid' }, 'headers'],
  ]) {
    const response = await f.post(data, { headers });
    assert.equal(response.status, 403);
    const trace = await responseTrace(f, response);
    assert.ok(trace.finish.includes(`phase=${phase} status=403 bytes=0 `));
    assert.equal(trace.lines.some(line => line.includes('stage=body-end ')), false);
  }
  assert.equal(f.editor.state().revision, before.revision);
  assert.deepEqual(f.applied, []);
  assert.deepEqual(f.calls, []);
});

test('503 editor failure is logged at save and never reveals the underlying exception', async t => {
  const f = await fixture(t, { failSave: true }), before = f.editor.state();
  const response = await f.post({ text: BODY_SECRET, revision: before.revision });
  assert.equal(response.status, 503);
  const trace = await responseTrace(f, response);
  assert.match(trace.finish, /phase=save status=503 /);
  assert.ok(!JSON.stringify(trace.body).includes(EXCEPTION_SECRET));
  assert.equal(f.editor.state().revision, before.revision);
  assert.deepEqual(f.applied, []);
  assert.deepEqual(f.calls, []);
});

test('aborted HTTP upload records partial byte count and never invokes save or external actions', async t => {
  const f = await fixture(t), before = f.editor.state(), config = fs.readFileSync(f.configFile);
  const partial = Buffer.from(`{"text":"${BODY_SECRET}`);
  const socket = net.connect({ host: '127.0.0.1', port: f.port });
  socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`POST /api/persona?private=${QUERY_SECRET} HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nContent-Type: application/json\r\nX-CSRF-Token: ${f.csrf}\r\nX-Private: ${HEADER_SECRET}\r\nContent-Length: 10000\r\n\r\n`);
  socket.write(partial);
  await wait(30);
  socket.destroy();
  const deadline = Date.now() + 2000;
  while (!diagnosticLines(f).some(line => line.includes('stage=closed ')) && Date.now() < deadline) await wait(10);
  const lines = diagnosticLines(f);
  assert.ok(lines.some(line => line.includes('stage=start ')));
  assert.ok(lines.some(line => line.includes('stage=aborted phase=body ') && line.includes(`bytes=${partial.length} `)));
  assert.ok(lines.some(line => line.includes('stage=closed phase=body ')));
  assert.equal(lines.some(line => line.includes('stage=finish ')), false);
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), before.text);
  assert.deepEqual(fs.readFileSync(f.configFile), config);
  assert.deepEqual(f.applied, []);
  assert.deepEqual(f.calls, []);
  checkPrivacy(f);
});

test('GET requests stay uninstrumented and logger failure cannot break an authorized save', async t => {
  const f = await fixture(t, { throwDiagnosticLog: true });
  const get = await fetch(f.url + '/api/persona');
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('x-request-id'), null);
  assert.equal(diagnosticLines(f).length, 0);
  const response = await f.post({ text: BODY_SECRET, revision: f.editor.state().revision });
  assert.equal(response.status, 200);
  await responseTrace(f, response);
  assert.deepEqual(f.applied, [BODY_SECRET]);
  assert.deepEqual(f.calls, []);
});

test('an explicit CSRF token survives a new server instance without exposing it in diagnostics', async t => {
  const csrfToken = Buffer.alloc(32, 0x71).toString('base64url');
  const first = await fixture(t, { csrfToken });
  const second = await fixture(t, { csrfToken });
  assert.equal(first.csrf, csrfToken);
  assert.equal(second.csrf, csrfToken);
  const response = await second.post({ text: BODY_SECRET, revision: second.editor.state().revision }, { headers: { 'X-CSRF-Token': first.csrf } });
  assert.equal(response.status, 200);
  await responseTrace(second, response);
  assert.deepEqual(first.applied, []);
  assert.deepEqual(second.applied, [BODY_SECRET]);
  checkPrivacy(first);
  checkPrivacy(second);
});

test('invalid explicit CSRF tokens are rejected instead of replaced with a random token', () => {
  const calls = [], logs = [];
  const companion = Object.fromEntries(['status', 'friends', 'configure', 'createQr', 'pollQr', 'runNow'].map(name => [name, () => calls.push(name)]));
  const invalid = [null, false, 32, {}, '', 'a'.repeat(42), 'a'.repeat(44), '+'.repeat(43), '/'.repeat(43), 'B'.repeat(43), ' '.repeat(43)];
  for (const csrfToken of invalid) {
    assert.throws(() => createLoginServer({ companion, port: 0, csrfToken, log: line => logs.push(line) }), { message: 'Invalid local UI CSRF token' });
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, []);
});
