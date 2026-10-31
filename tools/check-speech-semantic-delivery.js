import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSpeech, createReplyDelivery } from '../src/speech/index.js';
import { createLoginServer } from '../src/bilibili/server.js';

const ORIGINAL = '低头攥了攥衣角，回头小声问你……今天还一起吃饭吗？';
const NARRATION = '低头攥了攥衣角，回头小声问你……';
const SPOKEN = '今天还一起吃饭吗？';
const KEY = 'p:12345';
const HINT = '请发语音';
const DIRECTION = { emotion: 'gentle', intent: 'ask', pace: 'natural', contour: 'steady' };
const mp3 = () => Buffer.concat([Buffer.from('ID3'), Buffer.alloc(256, 32)]);
function validPlan(text) {
  return { decision: 'speak', direction: { ...DIRECTION }, parts: text === ORIGINAL
    ? [{ kind: 'narration', text: NARRATION }, { kind: 'speech', text: SPOKEN }]
    : [{ kind: 'speech', text }] };
}

// The production constructor is exercised directly. Every model, encoder and QQ
// action below is a local stub; there is no default planner from another fixture.
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-semantic-delivery-'));
  const reference = path.join(root, 'reference.wav'); fs.writeFileSync(reference, 'reference');
  const forms = [], planCalls = [], lifecycle = [], costs = [], logs = [];
  const pcm = Buffer.alloc(4800);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(i % 4 ? 1500 : -1500, i);
  const speech = createSpeech({ rootDir: root, now: () => 1000, random: () => 0,
    llm: { planSpeech: async input => { planCalls.push(input); return { plan: validPlan(input.text), cost: .002 }; } },
    acquireHeavy: async () => { lifecycle.push('acquire'); return async () => lifecycle.push('release'); },
    ensureBackendReady: async ({ variant }) => { lifecycle.push(`start:${variant}`); },
    stopBackend: async () => { lifecycle.push('stop'); },
    fetchImpl: async (_url, { body }) => { forms.push(body); return new Response(pcm); },
    runImpl: async (_command, args) => fs.writeFileSync(args.at(-1), mp3()),
    onCost: cost => costs.push(cost), log: line => logs.push(line),
    ...overrides });
  speech.updateConfig({ enabled: true, referenceAudio: reference, referenceText: '参考台词。', autoRate: 1, intensity: .85 });
  t.after(async () => { await speech.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, speech, forms, planCalls, lifecycle, costs, logs };
}

test('unmarked narration is absent from the actual backend form while the full original remains available', async t => {
  const h = fixture(t);
  const result = await h.speech.synthesize({ key: KEY, text: ORIGINAL, userText: HINT, explicit: true });
  assert.equal(result.mode, 'voice');
  assert.equal(result.text, ORIGINAL); assert.equal(result.spokenText, SPOKEN);
  assert.equal(h.forms.length, 1); assert.equal(h.forms[0].get('text'), SPOKEN);
  assert.deepEqual(h.planCalls, [{ text: ORIGINAL, userText: HINT }]);
  assert.deepEqual(h.costs, [.002]);
  assert.equal(h.speech.verifyResult(result, { key: KEY, text: ORIGINAL, userText: HINT }), SPOKEN);
  assert.deepEqual(h.lifecycle, ['acquire', 'start:8bit', 'stop', 'release']);
});

test('automatic, explicitly requested and preview voices all require a speech plan', async t => {
  const h = fixture(t);
  const automatic = await h.speech.synthesize({ key: KEY, text: ORIGINAL, userText: '一起吃饭吗' });
  const explicit = await h.speech.synthesize({ key: 'p:12346', text: ORIGINAL, userText: HINT, explicit: true });
  const preview = await h.speech.preview({ text: ORIGINAL, userText: '温柔地说' });
  for (const result of [automatic, explicit, preview]) {
    assert.equal(result.mode, 'voice'); assert.equal(result.text, ORIGINAL); assert.equal(result.spokenText, SPOKEN);
  }
  assert.equal(h.planCalls.length, 3); assert.equal(h.forms.length, 3);
  assert.ok(h.forms.every(form => form.get('text') === SPOKEN));
  assert.equal(h.speech.verifyResult(preview, { key: 'p:0', text: ORIGINAL, userText: '温柔地说', preview: true }), SPOKEN);
  assert.equal(h.speech.verifyResult(preview, { key: 'p:0', text: ORIGINAL, userText: '温柔地说' }), null);
});

test('missing, failing, declined and rewritten plans all preserve original text without starting the backend', async t => {
  for (const llm of [undefined, {}, { planSpeech: async () => { throw new Error('planner unavailable'); } },
    { planSpeech: async () => ({ plan: { decision: 'text', parts: [], direction: DIRECTION } }) },
    { planSpeech: async () => ({ plan: { decision: 'speak', parts: [{ kind: 'speech', text: '今天一起吃饭吧。' }], direction: DIRECTION } }) },
    { planSpeech: async () => ({ plan: '{"decision":"speak","parts":[' }) }]) {
    const h = fixture(t, { llm });
    const result = await h.speech.synthesize({ key: KEY, text: ORIGINAL, userText: HINT, explicit: true });
    assert.equal(result.mode, 'text'); assert.equal(result.text, ORIGINAL);
    assert.ok(['SPEECH_PLAN_UNAVAILABLE', 'UNCERTAIN_SPOKEN_TEXT'].includes(result.reason));
    assert.deepEqual(h.forms, []); assert.deepEqual(h.lifecycle, []);
    assert.equal(h.speech.verifyResult(result, { key: KEY, text: ORIGINAL, userText: HINT }), null);
  }
});

test('factual replies and explicit verbatim reading retain the complete text without planning', async t => {
  let calls = 0;
  const h = fixture(t, { llm: { planSpeech: async () => { calls++; throw new Error('must not be used'); } } });
  const facts = '我刚才低头找了钥匙，现在找到了。';
  const factual = await h.speech.synthesize({ key: KEY, text: facts, factual: true, explicit: true });
  const literal = await h.speech.synthesize({ key: 'p:12346', text: ORIGINAL, userText: '请逐字原样朗读', explicit: true });
  assert.equal(factual.mode, 'voice'); assert.equal(factual.spokenText, facts);
  assert.equal(literal.mode, 'voice'); assert.equal(literal.spokenText, ORIGINAL);
  assert.deepEqual(h.forms.map(form => form.get('text')), [facts, ORIGINAL]);
  assert.equal(calls, 0);
  assert.equal(h.speech.verifyResult(factual, { key: KEY, text: facts, factual: true }), facts);
  assert.equal(h.speech.verifyResult(factual, { key: KEY, text: facts }), null);
});

test('ordinary text gates still run before planning or loading any model', async t => {
  const h = fixture(t, { random: () => .5 });
  h.speech.updateConfig({ autoRate: 0 });
  const skipped = await h.speech.synthesize({ key: KEY, text: ORIGINAL });
  assert.equal(skipped.reason, 'AUTO_TEXT');
  h.speech.updateConfig({ autoRate: 1 });
  const disallowed = await h.speech.synthesize({ key: KEY, text: ORIGINAL, allowAuto: false });
  assert.equal(disallowed.reason, 'TEXT_REQUIRED');
  h.speech.updateConfig({ mode: 'text' });
  const disabled = await h.speech.synthesize({ key: KEY, text: ORIGINAL, explicit: true });
  assert.equal(disabled.reason, 'DISABLED');
  assert.deepEqual(h.planCalls, []); assert.deepEqual(h.forms, []); assert.deepEqual(h.lifecycle, []);
});

test('verification binds result identity, full input context, public transcript and exact audio bytes', async t => {
  const h = fixture(t), other = fixture(t);
  const context = { key: KEY, text: ORIGINAL, userText: HINT, factual: false, preview: false };
  const result = await h.speech.synthesize({ ...context, explicit: true });
  assert.equal(h.speech.verifyResult(result, context), SPOKEN);
  assert.equal(h.speech.verifyResult({ ...result }, context), null);
  assert.equal(other.speech.verifyResult(result, context), null);
  for (const changed of [{ key: 'p:99999' }, { text: '不同的正文' }, { userText: '另一条指令' },
    { factual: true }, { preview: true }])
    assert.equal(h.speech.verifyResult(result, { ...context, ...changed }), null);
  for (const [key, replacement] of [['mode', 'text'], ['text', '篡改原文'], ['spokenText', ORIGINAL],
    ['audio', Buffer.from(result.audio)]]) {
    const saved = result[key]; result[key] = replacement;
    assert.equal(h.speech.verifyResult(result, context), null, key);
    result[key] = saved;
  }
  const byte = result.audio[10]; result.audio[10] ^= 1;
  assert.equal(h.speech.verifyResult(result, context), null);
  result.audio[10] = byte;
  assert.equal(h.speech.verifyResult(result, context), SPOKEN);
});

test('the real delivery remembers the verified dialogue, not the original narration or a fresh heuristic', async t => {
  const h = fixture(t), sent = [];
  const deliver = createReplyDelivery({ speech: h.speech, transport: {
    sendPrivate: async (id, message) => { sent.push({ id, message }); return { ok: true, data: { message_id: 501 } }; },
  } });
  const result = await deliver({ key: KEY, text: ORIGINAL, userText: HINT, explicit: true, target: { userId: '12345' } });
  assert.equal(result.mode, 'voice'); assert.equal(result.text, ORIGINAL); assert.equal(result.spokenText, SPOKEN);
  assert.equal(sent.length, 1); assert.equal(sent[0].message[0].type, 'record');
  assert.equal(h.speech.lookup(501, KEY).text, SPOKEN);
  assert.equal(h.speech.lookup(501, 'p:99999'), null);
  const state = JSON.parse(fs.readFileSync(path.join(h.root, 'data/speech/state.json'), 'utf8'));
  assert.equal(state.messages['501'].text, SPOKEN);
  assert.equal(h.forms[0].get('text'), SPOKEN);
});

test('failed verification cannot silently fall back to legacy transcript derivation', async t => {
  const h = fixture(t), sent = [];
  const adapter = { ...h.speech,
    synthesize: async args => ({ ...await h.speech.synthesize(args) }),
  };
  const deliver = createReplyDelivery({ speech: adapter, transport: {
    sendPrivate: async (_id, message) => { sent.push(message); return { ok: true, data: { message_id: 502 } }; },
  } });
  const result = await deliver({ key: KEY, text: ORIGINAL, userText: HINT, explicit: true, target: { userId: '12345' } });
  assert.equal(result.mode, 'text'); assert.equal(result.text, ORIGINAL);
  assert.deepEqual(sent, [[{ type: 'text', data: { text: ORIGINAL } }]]);
  assert.equal(h.speech.lookup(502, KEY), null);
});

test('the actual local preview API publishes verified semantic shortening and rejects a cloned result', async t => {
  const h = fixture(t); let externalCalls = 0;
  const noExternal = () => { externalCalls++; throw new Error('external action forbidden'); };
  const companion = { status: () => ({}), friends: () => [], configure: noExternal,
    createQr: noExternal, pollQr: noExternal, runNow: noExternal };
  const adapter = { ...h.speech };
  const token = crypto.randomBytes(32).toString('base64url');
  const server = createLoginServer({ companion, speech: adapter, port: 0, csrfToken: token });
  const address = await server.start(); t.after(() => server.stop());
  const post = () => fetch(address.url + '/api/speech/preview', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Origin: address.url },
    body: JSON.stringify({ text: ORIGINAL, userText: HINT }) });
  const response = await post(); assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, 'voice'); assert.equal(body.text, ORIGINAL); assert.equal(body.spokenText, SPOKEN);
  assert.equal(body.audioBase64, mp3().toString('base64'));
  assert.ok(!JSON.stringify(body).includes(h.root));
  for (const key of ['plan', 'parts', 'proof', 'instruction', 'referenceAudio']) assert.equal(Object.hasOwn(body, key), false);
  adapter.preview = async args => ({ ...await h.speech.preview(args) });
  const rejected = await post(); assert.equal(rejected.status, 503);
  assert.ok(!(await rejected.text()).includes('audioBase64'));
  assert.equal(externalCalls, 0); assert.equal(h.planCalls.length, 2);
  assert.ok(h.forms.every(form => form.get('text') === SPOKEN));
});
