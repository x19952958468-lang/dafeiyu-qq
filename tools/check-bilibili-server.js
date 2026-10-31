import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { createLoginServer, encodeQrPng } from '../src/bilibili/server.js';

const SECRET = 'NEVER_EXPOSE_TEST_CREDENTIAL';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const QR_KEY = '0123456789abcdef0123456789abcdef';

async function fixture(t, overrides = {}) {
  const state = {
    phase: 'awaiting_login', account: { loggedIn: false, cookies: SECRET },
    config: { ownerQq: '', enabled: false, watchPerDay: 6, commentPerDay: 2, sharePerDay: 3, intervalMinutes: 90, shareGapMinutes: 120, keywords: ['音乐'], apiKey: SECRET },
    stats: { todayWatched: 1, todayComments: 0, todayShared: 0, busy: false, credential: SECRET },
    recent: [{ time: '2026-10-30T10:00:00+08:00', title: '<script>bad()</script>', action: 'preview', message: '本地测试', cookies: SECRET, url: 'javascript:alert(1)' }],
    credential: SECRET,
  };
  const calls = { configure: [], qr: 0, poll: [], run: [], encoded: [] };
  const companion = {
    status: async () => state,
    friends: async () => [{ user_id: 70103, nickname: '测试好友', remark: '主人', cookies: SECRET }, { user_id: '<bad>', nickname: '过滤' }],
    configure: async config => { calls.configure.push(config); Object.assign(state.config, config); },
    createQr: async () => { calls.qr++; return { key: QR_KEY, url: `https://passport.bilibili.com/login?key=${QR_KEY}`, expiresAt: Date.now() + 180000, cookies: SECRET }; },
    pollQr: async key => { calls.poll.push(key); return { status: 'confirmed', account: { uid: '34567', name: '测试账号', cookies: SECRET }, refreshToken: SECRET }; },
    runNow: async options => { calls.run.push(options); return { accepted: true, cookies: SECRET }; },
    ...overrides,
  };
  const logs = [];
  const server = createLoginServer({ companion, port: 0, log: message => logs.push(message), qrEncoder: async url => { calls.encoded.push(url); return PNG; } });
  assert.equal(calls.qr, 0);
  const address = await server.start();
  t.after(() => server.stop());
  assert.equal(address.host, '127.0.0.1');
  const page = await fetch(address.url);
  const html = await page.text();
  const token = html.match(/name="csrf-token" content="([^"]+)"/)[1];
  const post = (route, body = {}, extra = {}) => fetch(address.url + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Origin: address.url, ...extra }, body: JSON.stringify(body),
  });
  return { server, address, html, token, state, calls, logs, post, companion };
}

function rawRequest(address, headers, path = '/api/status') {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: address.port, path, headers }, response => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
    });
    request.on('error', reject); request.end();
  });
}

test('page is local, nonce protected, and creates no QR or activity on load', async t => {
  const f = await fixture(t);
  assert.equal(f.calls.qr, 0); assert.deepEqual(f.calls.run, []);
  assert.match(f.html, /本地试运行/);
  assert.match(f.html, /确认登录后将启用浏览、B站评论与 QQ 推荐/);
  assert.doesNotMatch(f.html, /__CSRF_NONCE__|__SCRIPT_NONCE__|style="/);
  const script = f.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  const response = await fetch(f.address.url);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'nonce-/);
});

test('status and friends expose only approved fields and safe links', async t => {
  const f = await fixture(t);
  const response = await fetch(f.address.url + '/api/status'); const text = await response.text();
  assert.equal(response.status, 200); assert.ok(!text.includes(SECRET));
  const state = JSON.parse(text); assert.equal(state.recent[0].url, undefined);
  assert.equal(state.recent[0].title, '<script>bad()</script>'); // UI uses textContent, never innerHTML.
  const friends = await (await fetch(f.address.url + '/api/friends')).json();
  assert.deepEqual(friends.friends, [{ user_id: '70103', nickname: '测试好友', remark: '主人' }]);
});

test('wrong Host, cross-origin requests and missing nonce are rejected before action', async t => {
  const f = await fixture(t);
  assert.equal((await rawRequest(f.address, { Host: `attacker.test:${f.address.port}` })).status, 403);
  assert.equal((await rawRequest(f.address, { Host: `127.0.0.1:${f.address.port}`, Origin: 'https://attacker.test' })).status, 403);
  assert.equal((await f.post('/api/run', {}, { Origin: 'https://attacker.test' })).status, 403);
  assert.equal((await f.post('/api/run', {}, { 'X-CSRF-Token': 'wrong' })).status, 403);
  const missing = await fetch(f.address.url + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(missing.status, 403); assert.deepEqual(f.calls.run, []);
});

test('large, malformed and unsupported request bodies are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/config', { keywords: ['x'.repeat(17000)] })).status, 413);
  const malformed = await fetch(f.address.url + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': f.token }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await f.post('/api/config', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.post('/api/config', { cookies: SECRET })).status, 400);
  assert.deepEqual(f.calls.configure, []);
});

test('config save and pause are forwarded without exposing credentials', async t => {
  const f = await fixture(t);
  const config = { ownerQq: '70103', enabled: false, commentPerDay: 100, intervalMinutes: 0.5, commentGapMinutes: 0 };
  const response = await f.post('/api/config', config);
  const data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.config.ownerQq, '70103');
  assert.equal(data.config.commentPerDay, 100);
  assert.equal(data.config.intervalMinutes, 0.5);
  assert.equal(data.config.commentGapMinutes, 0);
  assert.deepEqual(f.calls.configure, [config]);
  assert.ok(!JSON.stringify(data).includes(SECRET));
});

test('QR needs owner selection, is generated locally on demand, and filters login response', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/login/start')).status, 400); assert.equal(f.calls.qr, 0);
  await f.post('/api/config', { ownerQq: '70103' });
  const response = await f.post('/api/login/start'); const qr = await response.json();
  assert.equal(response.status, 200); assert.equal(qr.image, PNG); assert.equal(qr.key, QR_KEY);
  assert.ok(!JSON.stringify(qr).includes(SECRET)); assert.equal(qr.url, undefined);
  assert.equal(f.calls.encoded.length, 1); assert.match(f.calls.encoded[0], /^https:\/\/passport\.bilibili\.com\//);
  const unknown = await (await f.post('/api/login/poll', { key: 'unissued' })).json();
  assert.equal(unknown.status, 'expired'); assert.deepEqual(f.calls.poll, []);
  const confirmed = await (await f.post('/api/login/poll', { key: qr.key })).json();
  assert.deepEqual(confirmed, { status: 'confirmed', account: { loggedIn: true, uid: '34567', name: '测试账号' } });
  assert.equal(f.calls.configure.length, 1); // Explicit UI configure enables after confirmed.
  assert.equal((await (await f.post('/api/login/poll', { key: qr.key })).json()).status, 'expired');
});

test('non-Bilibili QR URL is never encoded', async t => {
  const f = await fixture(t, { createQr: async () => ({ key: QR_KEY, url: 'https://attacker.test/login', expiresAt: Date.now() + 100000 }) });
  f.state.config.ownerQq = '70103';
  assert.equal((await f.post('/api/login/start')).status, 502); assert.deepEqual(f.calls.encoded, []);
});

test('run defaults to a dry run and returns no internal data', async t => {
  const f = await fixture(t);
  const response = await f.post('/api/run');
  assert.equal(response.status, 202); assert.deepEqual(await response.json(), { accepted: true, dryRun: true });
  assert.deepEqual(f.calls.run, [{ dryRun: true }]);
  assert.equal((await f.post('/api/run', { dryRun: 'false' })).status, 400);
});

test('upstream exceptions are never returned or logged verbatim', async t => {
  const f = await fixture(t);
  f.companion.status = async () => { throw new Error(`Cookie=${SECRET}`); };
  const response = await fetch(f.address.url + '/api/status');
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes(SECRET));
  assert.ok(!f.logs.join('\n').includes(SECRET));
});

test('local Python QR renderer returns a PNG without networking', { skip: !process.env.DAFEIYU_TEST_QR_PYTHON }, async () => {
  const png = await encodeQrPng('https://passport.bilibili.com/test-local-only', process.env.DAFEIYU_TEST_QR_PYTHON);
  assert.match(png, /^data:image\/png;base64,iVBOR/);
});
