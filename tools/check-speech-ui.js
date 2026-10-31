import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { createLoginServer } from '../src/bilibili/server.js';

const SECRET = '/private/reference-SECRET.wav';
const DEFAULT_CONFIG = { enabled: true, mode: 'auto', autoRate: 0.3, intensity: 0.65, maxChars: 160 };

async function fixture(t, { missing = false } = {}) {
  const config = { ...DEFAULT_CONFIG, referenceAudio: SECRET, referenceText: SECRET, apiKey: SECRET };
  const status = { enabled: true, available: true, ready: true, busy: false, queued: 0,
    lastError: SECRET, lastGeneratedAt: '2026-10-30T10:00:00.000Z', referenceAudio: SECRET, worker: { path: SECRET } };
  const calls = { updates: [], bilibili: 0, synthesis: 0 };
  const speech = {
    config: () => ({ ...config }), status: () => ({ ...status }),
    async updateConfig(patch) { calls.updates.push({ ...patch }); Object.assign(config, patch); return { path: SECRET }; },
    async synthesize() { calls.synthesis++; throw new Error('Synthesis must not be called by settings UI'); },
  };
  const companion = {
    async status() { return { phase: 'awaiting_login', account: { loggedIn: false }, config: {}, stats: {}, recent: [] }; },
    async friends() { return []; },
    async configure() { calls.bilibili++; }, async createQr() { calls.bilibili++; },
    async pollQr() { calls.bilibili++; }, async runNow() { calls.bilibili++; },
  };
  const logs = [];
  const server = createLoginServer({ companion, speech: missing ? undefined : speech, port: 0, log: line => logs.push(line) });
  assert.deepEqual(calls, { updates: [], bilibili: 0, synthesis: 0 });
  const address = await server.start();
  t.after(() => server.stop());
  const page = await fetch(address.url);
  const html = await page.text();
  const csrf = html.match(/name="csrf-token" content="([^"]+)"/)[1];
  const post = (body, headers = {}) => fetch(address.url + '/api/speech', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Origin: address.url, ...headers }, body: JSON.stringify(body),
  });
  const get = () => fetch(address.url + '/api/speech');
  return { config, status, calls, speech, server, address, logs, html, csrf, post, get };
}

test('speech card uses the existing local page and creates no activity on load', async t => {
  const f = await fixture(t);
  for (const text of ['情绪语音', '自然穿插', '每条语音', '仅文字', '情绪强度', '自动语音比例', '共用现有人设与记忆', '唱歌不受影响']) assert.ok(f.html.includes(text));
  assert.doesNotMatch(f.html, /style="|referenceAudio|referenceText|__CSRF_NONCE__|__SCRIPT_NONCE__/);
  const script = f.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.deepEqual(f.calls, { updates: [], bilibili: 0, synthesis: 0 });
  const page = await fetch(f.address.url);
  assert.match(page.headers.get('content-security-policy'), /style-src 'nonce-/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
});

test('GET speech exposes only safe settings and normalized status', async t => {
  const f = await fixture(t);
  const response = await f.get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.text();
  assert.ok(!body.includes(SECRET));
  assert.deepEqual(JSON.parse(body), { available: true, ready: true, busy: false, queued: 0, hasError: true,
    lastGeneratedAt: '2026-10-30T10:00:00.000Z', config: DEFAULT_CONFIG });
  f.status.lastGeneratedAt = SECRET;
  f.status.queued = SECRET;
  const malformed = await (await f.get()).json();
  assert.equal(malformed.lastGeneratedAt, null);
  assert.equal(malformed.queued, 0);
});

test('POST speech saves only voice settings and never alters Bilibili or synthesizes', async t => {
  const f = await fixture(t);
  const patch = { enabled: true, mode: 'voice', autoRate: 0.5, intensity: 0.8, maxChars: 200 };
  const response = await f.post(patch);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(!body.includes(SECRET));
  assert.deepEqual(JSON.parse(body).config, patch);
  assert.deepEqual(f.calls.updates, [patch]);
  assert.equal(f.calls.bilibili, 0);
  assert.equal(f.calls.synthesis, 0);
  const paused = await (await f.post({ enabled: false, mode: 'text' })).json();
  assert.equal(paused.config.enabled, false);
  assert.equal(paused.config.mode, 'text');
  assert.equal(paused.config.intensity, 0.8);
});

test('speech rejects a missing/wrong CSRF token and cross-origin requests before update', async t => {
  const f = await fixture(t);
  assert.equal((await f.post({ enabled: false }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.post({ enabled: false }, { Origin: 'https://attacker.test' })).status, 403);
  const noToken = await fetch(f.address.url + '/api/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false}' });
  assert.equal(noToken.status, 403);
  const foreignGet = await fetch(f.address.url + '/api/speech', { headers: { Origin: 'https://attacker.test' } });
  assert.equal(foreignGet.status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.address.port, path: '/api/speech', headers: { Host: `attacker.test:${f.address.port}` } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(wrongHost, 403);
  assert.deepEqual(f.calls.updates, []);
});

test('speech validates the complete patch before forwarding it', async t => {
  const f = await fixture(t);
  for (const patch of [
    { referenceAudio: SECRET }, { referenceText: SECRET }, { enabled: 'true' }, { mode: 'other' },
    { autoRate: -0.1 }, { autoRate: 1.01 }, { autoRate: '0.3' }, { intensity: null }, { intensity: 2 },
    { maxChars: 19 }, { maxChars: 501 }, { maxChars: 20.5 }, { maxChars: '160' },
    { enabled: false, maxChars: 0 },
  ]) assert.equal((await f.post(patch)).status, 400, JSON.stringify(patch));
  assert.deepEqual(f.calls.updates, []);
  assert.equal((await f.post({ autoRate: 0, intensity: 1, maxChars: 20 })).status, 200);
  assert.equal((await f.post({ autoRate: 1, intensity: 0, maxChars: 500 })).status, 200);
});

test('speech retains the shared JSON and 16 KB body protection', async t => {
  const f = await fixture(t);
  assert.equal((await f.post({ referenceText: 'x'.repeat(17000) })).status, 413);
  assert.equal((await f.post({}, { 'Content-Type': 'text/plain' })).status, 415);
  const invalid = await fetch(f.address.url + '/api/speech', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': f.csrf }, body: '{' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(f.calls.updates, []);
});

test('missing speech remains compatible with the Bilibili-only server', async t => {
  const f = await fixture(t, { missing: true });
  const response = await f.get();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { available: false, ready: false, busy: false, queued: 0, hasError: false, lastGeneratedAt: null, config: null });
  assert.equal((await f.post({ enabled: true })).status, 503);
  assert.equal((await fetch(f.address.url + '/api/status')).status, 200);
  assert.deepEqual(f.calls, { updates: [], bilibili: 0, synthesis: 0 });
});

test('speech exceptions cannot expose paths even through publicMessage properties', async t => {
  const f = await fixture(t);
  const error = Object.assign(new Error(SECRET), { httpStatus: 400, publicMessage: SECRET });
  f.speech.updateConfig = async () => { throw error; };
  const update = await f.post({ enabled: false });
  assert.equal(update.status, 503);
  assert.ok(!(await update.text()).includes(SECRET));
  f.speech.status = () => { throw error; };
  const status = await f.get();
  assert.equal(status.status, 503);
  assert.ok(!(await status.text()).includes(SECRET));
  assert.ok(!f.logs.join('\n').includes(SECRET));
});

test('page script saves speech independently and preserves unsaved slider changes on refresh', async t => {
  const f = await fixture(t);
  const elements = new Map(), requests = [], intervals = [];
  function element() {
    return { value: '', textContent: '', disabled: false, hidden: false, className: '', listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }, append() {}, replaceChildren() {}, add() {},
      checkValidity: () => true, reportValidity() {},
    };
  }
  for (const [, id] of f.html.matchAll(/\bid="([^"]+)"/g)) elements.set(id, element());
  const get = id => elements.get(id);
  const speech = { available: true, ready: true, busy: false, queued: 0, hasError: false, config: { ...DEFAULT_CONFIG } };
  const script = f.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const context = vm.createContext({
    document: { getElementById: get, querySelector: () => ({ content: f.csrf }), createElement: element, addEventListener() {}, hidden: false },
    window: { addEventListener() {} }, Option: function() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval(fn) { intervals.push(fn); },
    async fetch(route, options) {
      requests.push({ route, options });
      let body;
      if (route === '/api/speech') {
        if (options.method === 'POST') Object.assign(speech.config, JSON.parse(options.body));
        body = structuredClone(speech);
      } else if (route === '/api/status') body = { phase: 'awaiting_login', account: { loggedIn: false }, config: {}, stats: {}, recent: [] };
      else if (route === '/api/friends') body = { friends: [] };
      else throw new Error('Unexpected request: ' + route);
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    },
  });
  new vm.Script(script).runInContext(context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('speechMode').value, 'auto');
  assert.equal(get('speechIntensity').value, 65);
  assert.equal(get('saveSpeech').disabled, false);
  get('speechIntensity').value = '80';
  get('speechIntensity').listeners.input();
  for (const interval of intervals) interval();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('speechIntensity').value, '80', 'Polling must not overwrite an edited setting');
  get('speechMode').value = 'voice';
  get('speechMode').listeners.input();
  assert.equal(get('speechAutoRate').disabled, true);
  await get('saveSpeech').listeners.click();
  const posted = requests.filter(request => request.options.method === 'POST');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].route, '/api/speech');
  assert.equal(posted[0].options.headers['X-CSRF-Token'], f.csrf);
  assert.deepEqual(JSON.parse(posted[0].options.body), { enabled: true, mode: 'voice', maxChars: 160, intensity: 0.8, autoRate: 0.3 });
  get('speechMode').value = 'text';
  get('speechMode').listeners.input();
  assert.equal(get('speechIntensity').disabled, true);
  await get('saveSpeech').listeners.click();
  assert.equal(speech.config.enabled, false);
  assert.equal(speech.config.mode, 'text');
  assert.equal(get('speechStatus').textContent, '仅文字');
});
