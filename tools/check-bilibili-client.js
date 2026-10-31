import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBilibiliClient } from '../src/bilibili/client.js';

const BVID = 'BV1xx411c7mD';
const KEY = '0123456789abcdef0123456789abcdef';
const OTHER_KEY = 'fedcba9876543210fedcba9876543210';
const COOKIE = { SESSDATA: 'private-session', bili_jct: 'private-csrf', DedeUserID: '123' };
const NAV = { code: 0, data: { isLogin: true, mid: 123, uname: '测试账号' } };
const VIDEO = { code: 0, data: { bvid: BVID, aid: 7, cid: 77, title: '公开测试', duration: 24, owner: { name: '作者' } } };
const response = (data, extra = {}) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', ...extra } });
const qrResponse = (key = KEY) => response({ code: 0, data: { url: `https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=${key}`, qrcode_key: key } });

async function fixture(t, fetchImpl, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-client-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const credentialFile = path.join(dir, 'credentials.json');
  const client = createBilibiliClient({ credentialFile, fetchImpl, ...options });
  return { client, credentialFile, dir, login: () => fs.writeFile(credentialFile, JSON.stringify({ cookies: COOKIE }), { mode: 0o600 }) };
}

test('no credentials means no network status or comment write', async t => {
  let calls = 0;
  const { client } = await fixture(t, () => { calls++; throw Error('must not fetch'); });
  assert.deepEqual(await client.status(), { loggedIn: false });
  assert.deepEqual(await client.postComment({ bvid: BVID, text: '测试' }), { ok: false, unknown: false, error: 'AUTH_REQUIRED' });
  assert.equal(calls, 0);
});

test('invalid BV and CID inputs fail before network requests', async t => {
  let calls = 0;
  const { client } = await fixture(t, () => { calls++; });
  for (const bad of ['https://evil.example/a', '../config.json', 'BV123', `${BVID}?csrf=secret`]) {
    await assert.rejects(client.video(bad), { code: 'INVALID_INPUT' });
    await assert.rejects(client.postComment({ bvid: bad, text: '测试' }), { code: 'INVALID_INPUT' });
  }
  await assert.rejects(client.subtitles(BVID, -1), { code: 'INVALID_INPUT' });
  await assert.rejects(client.playUrl(BVID, 'not-cid'), { code: 'INVALID_INPUT' });
  assert.equal(calls, 0);
});

test('QR polling accepts only latest issued key and expires locally', async t => {
  let timestamp = 1000;
  let issued = 0;
  let polls = 0;
  const { client } = await fixture(t, async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Cookie, undefined);
    if (url.includes('/generate')) return qrResponse(issued++ ? OTHER_KEY : KEY);
    polls++;
    return response({ code: 0, data: { code: polls === 1 ? 86101 : 86090 } });
  }, { now: () => timestamp });
  assert.deepEqual(await client.pollQr('unknown'), { status: 'expired' });
  const first = await client.createQr();
  assert.equal(first.expiresAt, 181000);
  assert.deepEqual(await client.pollQr(first.key), { status: 'waiting' });
  assert.deepEqual(await client.pollQr(first.key), { status: 'scanned' });
  const second = await client.createQr();
  assert.deepEqual(await client.pollQr(first.key), { status: 'expired' });
  timestamp = second.expiresAt;
  assert.deepEqual(await client.pollQr(second.key), { status: 'expired' });
  assert.equal(polls, 2);
});

test('confirmed QR uses filtered Set-Cookie, persists 0600, returns no secrets', async t => {
  const { client, credentialFile } = await fixture(t, async (url, options) => {
    if (url.includes('/generate')) return qrResponse();
    if (url.includes('/poll')) {
      const headers = new Headers();
      headers.append('set-cookie', 'SESSDATA=private-session; Path=/; Secure; HttpOnly');
      headers.append('set-cookie', 'bili_jct=private-csrf; Path=/');
      headers.append('set-cookie', 'DedeUserID=123; Path=/');
      headers.append('set-cookie', 'tracking=do-not-save; Path=/');
      return new Response(JSON.stringify({ code: 0, data: { code: 0, refresh_token: 'private-refresh' } }), { headers });
    }
    assert.equal(new URL(url).hostname, 'api.bilibili.com');
    assert.match(options.headers.Cookie, /SESSDATA=private-session/);
    assert.doesNotMatch(options.headers.Cookie, /tracking/);
    return response(NAV);
  });
  await client.createQr();
  const result = await client.pollQr(KEY);
  assert.deepEqual(result, { status: 'confirmed', account: { uid: '123', name: '测试账号' } });
  assert.doesNotMatch(JSON.stringify(result), /private-/);
  const stored = JSON.parse(await fs.readFile(credentialFile, 'utf8'));
  assert.deepEqual(stored.cookies, COOKIE);
  assert.equal(stored.refreshToken, 'private-refresh');
  assert.equal((await fs.stat(credentialFile)).mode & 0o777, 0o600);
  assert.deepEqual(await client.pollQr(KEY), { status: 'expired' });
  assert.deepEqual(await client.status(), { loggedIn: true, uid: '123', name: '测试账号' });
});

test('fallback Set-Cookie parser handles Expires commas and callback-only cookies', async t => {
  const { client, credentialFile } = await fixture(t, async url => {
    if (url.includes('/generate')) return qrResponse();
    if (url.includes('/poll')) {
      const data = { code: 0, data: { code: 0, url: 'https://passport.bilibili.com/callback?DedeUserID=123&bili_jct=private-csrf' } };
      return { ok: true, status: 200, headers: { get: key => key === 'set-cookie' ? 'SESSDATA=private-session; Expires=Wed, 21 Oct 2030 07:28:00 GMT; HttpOnly, ignore=tracking; Path=/' : null }, text: async () => JSON.stringify(data) };
    }
    return response(NAV);
  });
  await client.createQr();
  assert.equal((await client.pollQr(KEY)).status, 'confirmed');
  assert.deepEqual(JSON.parse(await fs.readFile(credentialFile, 'utf8')).cookies, COOKIE);
});

test('an old QR response cannot install credentials after a newer QR is issued', async t => {
  let completePoll;
  let issued = 0;
  const { client, credentialFile } = await fixture(t, async url => {
    if (url.includes('/generate')) return qrResponse(issued++ ? OTHER_KEY : KEY);
    if (url.includes('/poll')) return new Promise(resolve => { completePoll = resolve; });
    assert.fail('old QR must not attempt account validation');
  });
  await client.createQr();
  const oldPoll = client.pollQr(KEY);
  while (!completePoll) await new Promise(resolve => setImmediate(resolve));
  await client.createQr();
  completePoll(response({ code: 0, data: { code: 0, url: 'https://passport.bilibili.com/callback?SESSDATA=private-session&bili_jct=private-csrf&DedeUserID=123' } }));
  assert.deepEqual(await oldPoll, { status: 'expired' });
  await assert.rejects(fs.stat(credentialFile), { code: 'ENOENT' });
});

test('foreign QR links, callback cookies and subtitle URLs are rejected', async t => {
  const badQr = await fixture(t, async () => response({ code: 0, data: { url: 'https://bilibili.com.evil.example/login', qrcode_key: KEY } }));
  await assert.rejects(badQr.client.createQr(), { code: 'INVALID_RESPONSE' });
  let calls = 0;
  const badSub = await fixture(t, async () => {
    calls++;
    return response({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: 'https://evil.example/subtitle.json' }] } } });
  });
  await assert.rejects(badSub.client.subtitles(BVID, 77), { code: 'INVALID_RESPONSE' });
  assert.equal(calls, 1);
  const badCallback = await fixture(t, async url => url.includes('/generate') ? qrResponse() : response({ code: 0, data: { code: 0, url: 'https://evil.example/?SESSDATA=secret&bili_jct=csrf&DedeUserID=123' } }));
  await badCallback.client.createQr();
  await assert.rejects(badCallback.client.pollQr(KEY), { code: 'INVALID_RESPONSE' });
});

test('subtitle fetch never includes session cookies and follows no redirects', async t => {
  const { client, login } = await fixture(t, async (url, options) => {
    if (new URL(url).hostname === 'api.bilibili.com') return response({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: '//aisubtitle.hdslb.com/subtitle.json' }] } } });
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.redirect, 'error');
    return response({ body: [{ content: '真正的字幕内容' }] });
  });
  await login();
  assert.deepEqual(await client.subtitles(BVID, 77), { text: '真正的字幕内容', available: true, language: 'zh-CN' });
});

test('unknown comment write results are not retried and do not leak credentials', async t => {
  for (const failure of ['network', 'timeout', 'invalid-json', 'http500', 'missing-rpid']) {
    let writes = 0;
    const { client, login } = await fixture(t, async (url, options) => {
      if (url.includes('/nav')) return response(NAV);
      if (url.includes('/view')) return response(VIDEO);
      assert.equal(options.method, 'POST');
      writes++;
      if (failure === 'network') throw Error('private-session private-csrf');
      if (failure === 'timeout') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('private-session'))));
      if (failure === 'invalid-json') return new Response('invalid private-session');
      if (failure === 'http500') return new Response('private-session', { status: 500 });
      return response({ code: 0, data: {} });
    }, { timeoutMs: 15 });
    await login();
    const result = await client.postComment({ bvid: BVID, text: '仅本地模拟，不会发送' });
    assert.equal(result.ok, false, failure);
    assert.equal(result.unknown, true, failure);
    assert.equal(writes, 1, failure);
    assert.doesNotMatch(JSON.stringify(result), /private-/);
  }
});

test('risk-control rejection is explicit, known, and never retried', async t => {
  let writes = 0;
  const { client, login } = await fixture(t, async url => {
    if (url.includes('/nav')) return response(NAV);
    if (url.includes('/view')) return response(VIDEO);
    writes++;
    return response({ code: -352, message: 'private-session must not appear in error' });
  });
  await login();
  assert.deepEqual(await client.postComment({ bvid: BVID, text: '模拟' }), { ok: false, unknown: false, error: 'RISK_CONTROL' });
  assert.equal(writes, 1);
});

test('comment success returns only confirmed rpid and correct video identity', async t => {
  const { client, login } = await fixture(t, async (url, options) => {
    if (url.includes('/nav')) return response(NAV);
    if (url.includes('/view')) return response(VIDEO);
    assert.equal(new URL(url).pathname, '/x/v2/reply/add');
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('oid'), '7');
    assert.equal(body.get('csrf'), COOKIE.bili_jct);
    assert.equal(body.get('message'), '模拟');
    return response({ code: 0, data: { rpid: 1234 } });
  });
  await login();
  assert.deepEqual(await client.postComment({ bvid: BVID, text: '模拟' }), { ok: true, rpid: '1234' });
});

test('public metadata is normalized and playUrl selects low resolution trusted media', async t => {
  const { client } = await fixture(t, async url => {
    if (url.includes('/popular')) return response({ code: 0, data: { list: [{ ...VIDEO.data, title: '<em>标题</em>', duration: '01:23' }, { bvid: 'bad' }] } });
    if (url.includes('/view')) return response(VIDEO);
    return response({ code: 0, data: { timelength: 24000, dash: { video: [
      { height: 1080, baseUrl: 'https://cdn.bilivideo.com/high.mp4' },
      { height: 360, base_url: 'https://cdn.bilivideo.com/low.mp4' },
      { height: 100, base_url: 'https://evil.example/steal' },
    ], audio: [{ bandwidth: 30000, baseUrl: 'https://cdn.bilivideo.com/audio.m4a' }] } } });
  });
  const list = await client.popular();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, '标题');
  assert.equal(list[0].duration, 83);
  assert.equal((await client.video(BVID)).cid, 77);
  assert.deepEqual(await client.playUrl(BVID, 77), { videoUrl: 'https://cdn.bilivideo.com/low.mp4', audioUrl: 'https://cdn.bilivideo.com/audio.m4a', duration: 24 });
});

test('responses are bounded before parsing and unavailable subtitles are explicit', async t => {
  const big = await fixture(t, async () => new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } }));
  await assert.rejects(big.client.video(BVID), { code: 'INVALID_RESPONSE' });
  const empty = await fixture(t, async () => response({ code: 0, data: { subtitle: { subtitles: [] } } }));
  assert.deepEqual(await empty.client.subtitles(BVID, 77), { text: '', available: false });
});

test('QR account mismatch and missing credentials never save a login', async t => {
  for (const mismatch of [false, true]) {
    const { client, credentialFile } = await fixture(t, async url => {
      if (url.includes('/generate')) return qrResponse();
      if (url.includes('/poll')) return response({ code: 0, data: { code: 0, url: `https://passport.bilibili.com/callback?SESSDATA=private-session&DedeUserID=123${mismatch ? '&bili_jct=private-csrf' : ''}` } });
      return response({ code: 0, data: { isLogin: true, mid: 999, uname: 'another-account' } });
    });
    await client.createQr();
    await assert.rejects(client.pollQr(KEY), { code: mismatch ? 'AUTH_REQUIRED' : 'INVALID_RESPONSE' });
    await assert.rejects(fs.stat(credentialFile), { code: 'ENOENT' });
  }
});

test('invalid credentials are reported without writing, and paid previews are refused', async t => {
  let calls = 0;
  const loggedOut = await fixture(t, async () => { calls++; return response({ code: -101 }); });
  await loggedOut.login();
  assert.deepEqual(await loggedOut.client.status(), { loggedIn: false, error: 'AUTH_REQUIRED' });
  assert.deepEqual(await loggedOut.client.postComment({ bvid: BVID, text: '模拟' }), { ok: false, unknown: false, error: 'AUTH_REQUIRED' });
  assert.equal(calls, 2);
  const preview = await fixture(t, async () => response({ code: 0, data: { is_preview: true, durl: [{ url: 'https://cdn.bilivideo.com/preview.mp4' }] } }));
  await assert.rejects(preview.client.playUrl(BVID, 77), { code: 'UNAVAILABLE_MEDIA' });
});

test('WBI search and recommendations use normalized data and fixed API hosts', async t => {
  const requested = [];
  const { client, login } = await fixture(t, async (url, options) => {
    const u = new URL(url);
    requested.push(u.pathname);
    assert.equal(u.origin, 'https://api.bilibili.com');
    if (u.pathname.endsWith('/spi')) return response({ code: 0, data: { b_3: 'guest-device-id', b_4: 'another-device' } });
    if (u.pathname.endsWith('/nav')) return response({ code: -101, data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${'b'.repeat(32)}.png` } } });
    assert.match(u.searchParams.get('w_rid'), /^[0-9a-f]{32}$/);
    assert.ok(Number(u.searchParams.get('wts')) > 0);
    if (u.pathname.endsWith('/search/type')) {
      assert.equal(u.searchParams.get('keyword'), '音乐与科学');
      assert.match(options.headers.Cookie, /buvid3=guest-device-id/);
      return response({ code: 0, data: { result: [VIDEO.data] } });
    }
    assert.match(options.headers.Cookie, /SESSDATA=private-session/);
    return response({ code: 0, data: { item: [VIDEO.data] } });
  });
  assert.equal((await client.search('音乐与科学', { limit: 2 }))[0].bvid, BVID);
  await login();
  assert.equal((await client.recommendations({ limit: 2 }))[0].bvid, BVID);
  assert.equal(requested.filter(x => x.endsWith('/nav')).length, 1);
});
