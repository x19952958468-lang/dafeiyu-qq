import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLoginServer } from '../src/bilibili/server.js';

const SECRET = '/private/SECRET-reference.wav';
const ERROR = '语音试听暂不可用，请稍后重试。';
const audio = () => Buffer.concat([Buffer.from('ID3'), Buffer.alloc(160)]);
async function fixture(t, { absent = false } = {}) {
  const calls = { preview: [], settings: 0, external: 0, synthesis: 0 }, logs = [];
  const speech = {
    status: () => ({ ready: true }), config: () => ({ enabled: true, mode: 'auto', autoRate: .7 }),
    updateConfig: () => { calls.settings++; }, synthesize: () => { calls.synthesis++; throw new Error(SECRET); },
    preview: async input => { calls.preview.push(input); return { mode: 'voice', audio: audio(), text: input.text,
      style: { emotion: 'happy', intensity: .8, source: 'explicit', instruction: SECRET }, config: { referenceAudio: SECRET }, backend: SECRET }; },
  };
  const noExternal = () => { calls.external++; throw new Error('No QQ or Bilibili action allowed'); };
  const companion = { status: () => ({}), friends: () => [], configure: noExternal,
    createQr: noExternal, pollQr: noExternal, runNow: noExternal };
  const server = createLoginServer({ companion, speech: absent ? undefined : speech, port: 0, log: line => logs.push(line) });
  const address = await server.start(); t.after(() => server.stop());
  const html = await (await fetch(address.url)).text();
  const token = html.match(/name="csrf-token" content="([^"]+)"/)[1];
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Origin: address.url };
  const post = (body, extraHeaders = {}) => fetch(address.url + '/api/speech/preview', {
    method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body),
  });
  return { speech, calls, logs, address, headers, post };
}
test('authorized preview returns only public audio and labels without any external action', async t => {
  const f = await fixture(t), input = { text: '你终于来了。', userText: '开心地说' };
  const response = await f.post(input);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const body = await response.text(); assert.ok(!body.includes(SECRET));
  assert.deepEqual(JSON.parse(body), { mode: 'voice', audioBase64: audio().toString('base64'), mimeType: 'audio/mpeg',
    text: input.text, emotion: 'happy', intensity: .8, source: 'explicit' });
  assert.deepEqual(f.calls, { preview: [input], settings: 0, external: 0, synthesis: 0 });
  await f.post({ text: '晚安。' });
  assert.deepEqual(f.calls.preview.at(-1), { text: '晚安。', userText: '' });
});
test('stage directions keep their original display text while verified spokenText is returned separately', async t => {
  const f = await fixture(t);
  for (const [text, spokenText] of [
    ['（轻轻叹气）别急，我们慢慢来。', '别急，我们慢慢来。'],
    ['（轻笑）你终于来了。（抬头）', '你终于来了。'],
  ]) {
    f.speech.preview = async input => {
      f.calls.preview.push(input);
      return { mode: 'voice', audio: audio(), text: input.text, spokenText,
        stageDirections: [SECRET], instruction: SECRET,
        style: { emotion: 'gentle', intensity: .5, source: 'text', instruction: SECRET } };
    };
    const response = await f.post({ text, userText: '温柔地说' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { mode: 'voice', audioBase64: audio().toString('base64'), mimeType: 'audio/mpeg',
      text, spokenText, emotion: 'gentle', intensity: .5, source: 'text' });
    assert.deepEqual(f.calls.preview.at(-1), { text, userText: '温柔地说' });
    assert.ok(!JSON.stringify(body).includes(SECRET));
  }
  assert.equal(f.calls.settings + f.calls.external + f.calls.synthesis, 0);
});
test('ordinary parentheses and explicit literal reading retain the old response contract', async t => {
  const f = await fixture(t);
  for (const input of [
    { text: '这份资料（第二版）已经更新。' },
    { text: '结果是（2 + 3）乘以4。' },
    { text: '“（轻笑）”是一个动作说明。' },
    { text: '（轻笑）你终于来了。', userText: '把括号里的内容也原样读出来。' },
    { text: '（轻笑）你终于来了。', userText: '括号里的内容也一起读出来。' },
  ]) {
    const response = await f.post(input);
    assert.equal(response.status, 200, JSON.stringify(input));
    const body = await response.json();
    assert.equal(body.text, input.text);
    assert.equal(Object.hasOwn(body, 'spokenText'), false);
    assert.deepEqual(f.calls.preview.at(-1), { text: input.text, userText: input.userText || '' });
  }
  f.speech.preview = async input => ({ mode: 'voice', audio: audio(), text: input.text, spokenText: input.text });
  const supplied = await f.post({ text: '完整正文（第二版）。' });
  assert.equal(supplied.status, 200);
  assert.equal(Object.hasOwn(await supplied.json(), 'spokenText'), false);
});
test('an unclassified or truncated parenthesis cannot be approved as playable audio by renderer metadata', async t => {
  const f = await fixture(t);
  for (const text of ['（全新的动作措辞）你好。', '（轻笑，明天上午十点）你好。', '（状态未闭合', '状态末尾）你好。']) {
    f.speech.preview = async () => ({ mode: 'voice', audio: audio(), text, spokenText: text });
    const response = await f.post({ text });
    assert.equal(response.status, 503, text);
    assert.ok(!(await response.text()).includes('audioBase64'));
  }
});
test('changed spoken text must be attested correctly and action-only audio cannot be accepted', async t => {
  const f = await fixture(t), text = '（轻笑）你终于来了。';
  for (const extra of [{}, { spokenText: undefined }, { spokenText: null }, { spokenText: text },
    { spokenText: '不同的正文' }, { spokenText: SECRET }, { spokenText: { text: SECRET } }]) {
    f.speech.preview = async () => ({ mode: 'voice', audio: audio(), text, ...extra });
    const response = await f.post({ text });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: ERROR });
  }
  f.speech.preview = async () => ({ mode: 'voice', audio: audio(), text: '（轻笑）', spokenText: '' });
  const empty = await f.post({ text: '（轻笑）' });
  assert.equal(empty.status, 503);
  assert.deepEqual(await empty.json(), { error: ERROR });
  assert.ok(!f.logs.join('\n').includes(SECRET));
});
test('even unchanged text cannot be replaced by a renderer-supplied spokenText field', async t => {
  const f = await fixture(t), text = '你好。';
  for (const spokenText of [undefined, null, '', '替换的正文', SECRET, { text: SECRET }]) {
    f.speech.preview = async () => ({ mode: 'voice', audio: audio(), text, spokenText });
    const response = await f.post({ text });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: ERROR });
  }
  f.speech.preview = async () => Object.assign(Object.create({ spokenText: SECRET }), { mode: 'voice', audio: audio(), text });
  const inherited = await f.post({ text });
  assert.equal(inherited.status, 503);
  assert.deepEqual(await inherited.json(), { error: ERROR });
  assert.ok(!f.logs.join('\n').includes(SECRET));
});
test('optional profile is an opaque local ID and is forwarded without exposing its configuration', async t => {
  const f = await fixture(t);
  for (const profile of ['a', 'sad-demo-v2', 'a'.repeat(48)]) {
    const response = await f.post({ text: '你好。', profile });
    assert.equal(response.status, 200);
    assert.deepEqual(f.calls.preview.at(-1), { text: '你好。', userText: '', profile });
    const body = await response.text();
    assert.ok(!body.includes(SECRET));
    assert.equal(Object.hasOwn(JSON.parse(body), 'profile'), false);
    assert.equal(Object.hasOwn(JSON.parse(body), 'config'), false);
  }
  assert.equal(f.calls.settings + f.calls.external + f.calls.synthesis, 0);
});
test('profile rejects paths, URLs, control characters, invalid types and arbitrary overrides before preview', async t => {
  const f = await fixture(t);
  for (const profile of ['', 'A', '0demo', 'demo_name', 'a'.repeat(49), '../reference', '/private/reference.wav',
    'https://example.test/profile', 'a\n', 'a\r', 'a\u0000', ' a', 'a ', null, 1, [], {}, { backendUrl: SECRET }]) {
    assert.equal((await f.post({ text: '你好。', profile })).status, 400, JSON.stringify(profile));
  }
  for (const field of ['cfg', 'cfgScale', 'path', 'instruction', 'referenceAudio', 'backendUrl']) {
    assert.equal((await f.post({ text: '你好。', profile: 'valid-id', [field]: SECRET })).status, 400, field);
  }
  assert.deepEqual(f.calls.preview, []);
  f.speech.preview = async () => { throw Object.assign(new Error(SECRET), { publicMessage: SECRET, httpStatus: 400 }); };
  const unknown = await f.post({ text: '你好。', profile: 'not-registered' });
  assert.equal(unknown.status, 503); assert.deepEqual(await unknown.json(), { error: ERROR });
  assert.ok(!f.logs.join('\n').includes(SECRET));
});
test('GET preview is read-only 404 and unsupported methods cannot synthesize', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.address.url + '/api/speech/preview')).status, 404);
  assert.equal((await fetch(f.address.url + '/api/speech/preview', { method: 'PUT', headers: f.headers, body: '{"text":"晚安"}' })).status, 405);
  assert.deepEqual(f.calls.preview, []);
});
test('Host, Origin and CSRF protections apply before preview', async t => {
  const f = await fixture(t), body = { text: '你好。' };
  assert.equal((await f.post(body, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.post(body, { Origin: 'https://attacker.test' })).status, 403);
  assert.equal((await f.post(body, { Origin: 'null' })).status, 403);
  assert.equal((await fetch(f.address.url + '/api/speech/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.address.port, path: '/api/speech/preview', method: 'POST',
      headers: { ...f.headers, Host: `attacker.test:${f.address.port}` } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  assert.equal(status, 403); assert.deepEqual(f.calls.preview, []);
});
test('preview validates text and hint limits, message codes, controls, and every unknown field', async t => {
  const f = await fixture(t);
  for (const input of [{}, { text: '' }, { text: '   ' }, { text: 1 }, { text: null }, { text: '字'.repeat(161) },
    { text: '你好', userText: null }, { text: '你好', userText: '字'.repeat(201) },
    { text: '[CQ:at,qq=all]' }, { text: '你好', userText: '[ cq :file]' },
    { text: '你\n好' }, { text: '你好', userText: '语音\u0085' }]) {
    assert.equal((await f.post(input)).status, 400, JSON.stringify(input));
  }
  for (const field of ['qq', 'userId', 'groupId', 'target', 'path', 'backendUrl', 'referenceAudio', 'referenceText', 'voiceId', 'instruction', 'cfgScale', 'seed', 'intensity', 'mode', 'spokenText']) {
    assert.equal((await f.post({ text: '你好', [field]: SECRET })).status, 400, field);
  }
  const proto = await fetch(f.address.url + '/api/speech/preview', { method: 'POST', headers: f.headers, body: '{"text":"你好","__proto__":{"target":"secret"}}' });
  assert.equal(proto.status, 400); assert.deepEqual(f.calls.preview, []);
  assert.equal((await f.post({ text: '字'.repeat(160), userText: '字'.repeat(200) })).status, 200);
});
test('shared JSON parsing and body-size limits run before preview', async t => {
  const f = await fixture(t);
  assert.equal((await f.post({ text: 'x'.repeat(17000) })).status, 413);
  assert.equal((await f.post({ text: '你好' }, { 'Content-Type': 'text/plain' })).status, 415);
  for (const body of ['{', '[]', 'null']) assert.equal((await fetch(f.address.url + '/api/speech/preview', { method: 'POST', headers: f.headers, body })).status, 400);
  assert.deepEqual(f.calls.preview, []);
});
test('missing preview, text fallbacks and raw errors return the same fixed Chinese failure', async t => {
  const f = await fixture(t);
  for (const implementation of [undefined, async () => ({ mode: 'text', reason: SECRET }),
    async () => { throw Object.assign(new Error(SECRET), { httpStatus: 400, publicMessage: SECRET }); }]) {
    f.speech.preview = implementation;
    const response = await f.post({ text: '你好' });
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: ERROR });
  }
  const missing = await fixture(t, { absent: true });
  assert.equal((await missing.post({ text: '你好' })).status, 503);
  assert.ok(!f.logs.join('\n').includes(SECRET));
});
test('malformed backend outputs cannot expose non-audio buffers or unexpected text', async t => {
  const f = await fixture(t);
  for (const result of [
    { mode: 'voice', text: '你好', audio: SECRET },
    { mode: 'voice', text: '你好', audio: Buffer.from(SECRET.repeat(20)) },
    { mode: 'voice', text: '你好', audio: Buffer.from('ID3') },
    { mode: 'voice', text: SECRET, audio: audio() },
  ]) {
    f.speech.preview = async () => result;
    const response = await f.post({ text: '你好' });
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: ERROR });
  }
  f.speech.preview = async () => ({ mode: 'voice', text: '你好', audio: audio(),
    style: { emotion: SECRET, intensity: SECRET, source: SECRET, instruction: SECRET } });
  const normalized = await (await f.post({ text: '你好' })).json();
  assert.equal(normalized.emotion, 'neutral'); assert.equal(normalized.intensity, 0); assert.equal(normalized.source, 'unknown');
  assert.ok(!JSON.stringify(normalized).includes(SECRET));
});
