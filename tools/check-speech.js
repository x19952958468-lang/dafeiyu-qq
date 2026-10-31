import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReplyDelivery, validateSpeechConfig, speechTokenBudget, validateSpeechPcm } from '../src/speech/index.js';
import { createSpeech } from './helpers/speech-fixture.js';
import { selectEmotion } from '../src/speech/emotion.js';

const KEY = 'p:70102';
function pcmAudio(seconds = .1) {
  const pcm = Buffer.alloc(Math.round(seconds * 24000) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(2000 * Math.sin(i * Math.PI / 12)), i * 2);
  return pcm;
}
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-test-'));
  const ref = path.join(root, 'reference.wav'); fs.writeFileSync(ref, Buffer.alloc(100));
  const events = [], forms = [], logs = [];
  const speech = createSpeech({ rootDir: root, random: () => .1, log: s => logs.push(s),
    acquireHeavy: async () => { events.push('acquire'); return async () => { events.push('release'); }; },
    ensureBackendReady: async () => { events.push('start'); }, stopBackend: async () => { events.push('stop'); },
    fetchImpl: async (url, options) => { events.push('fetch'); forms.push({ url, ...options }); return new Response(pcmAudio()); },
    runImpl: async (_binary, args) => { events.push('encode'); fs.writeFileSync(args.at(-1), Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200)])); },
    ...overrides,
  });
  speech.updateConfig({ referenceAudio: ref, referenceText: '这是参考音频的逐字稿。' });
  t.after(async () => { await speech.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, speech, events, forms, logs, ref };
}

test('speech settings are independent, validated, and backend stays on loopback', async t => {
  const h = fixture(t);
  h.speech.updateConfig({ mode: 'voice', autoRate: 1, intensity: .8 });
  assert.equal(h.speech.config().mode, 'voice');
  assert.equal(h.speech.status().ready, true);
  assert.equal(fs.existsSync(path.join(h.root, 'config.json')), false);
  const p = path.join(h.root, 'data/speech/config.json');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  for (const patch of [{ mode: 'invalid' }, { autoRate: 2 }, { intensity: -1 }, { maxChars: 0 },
    { backendUrl: 'http://attacker.test/upload' }, { backendUrl: 'http://127.0.0.1:6197/?secret=x' }, { apiKey: 'bad' }]) {
    assert.throws(() => validateSpeechConfig(patch));
  }
});

test('explicit speech bypasses random selection; tags stay out of the final transcript', async t => {
  const h = fixture(t, { random: () => .99 });
  const text = '你回来了，今天过得怎么样？';
  const result = await h.speech.synthesize({ key: KEY, text, userText: '用哭腔语音说' });
  assert.equal(result.mode, 'voice'); assert.equal(result.text, text);
  assert.equal(result.style.emotion, 'sad');
  const form = h.forms[0].body;
  assert.equal(form.get('text'), text);
  assert.equal(form.get('ref_text'), '这是参考音频的逐字稿。');
  assert.match(form.get('instruction'), /哭腔/);
  assert.equal(form.get('ref_audio').name, 'reference.wav');
  assert.equal(form.get('max_new_tokens'), '375');
  assert.deepEqual(h.events, ['acquire', 'start', 'fetch', 'encode', 'stop', 'release']);
  assert.equal(fs.readdirSync(path.join(h.root, 'data/speech')).some(n => n.startsWith('render-')), false);
});

test('ordinary low probability replies and explicit text requests do not start the backend', async t => {
  const h = fixture(t, { random: () => .99 });
  assert.equal((await h.speech.synthesize({ key: KEY, text: '今天挺好。' })).reason, 'AUTO_TEXT');
  assert.equal((await h.speech.synthesize({ key: KEY, text: '收到。', userText: '别发语音，只发文字' })).reason, 'TEXT_REQUESTED');
  assert.deepEqual(h.events, []);
});

test('voice mode still preserves links and complete long factual records as text', async t => {
  const h = fixture(t); h.speech.updateConfig({ mode: 'voice' });
  const url = '这个视频不错。https://www.bilibili.com/video/BV17VUrBvE8L';
  assert.equal((await h.speech.synthesize({ key: KEY, text: url, userText: '语音说', source: 'bilibili' })).reason, 'TEXT_REQUIRED');
  const long = '完整评论原文。'.repeat(100);
  const r = await h.speech.synthesize({ key: KEY, text: long, userText: '读出来', factual: true });
  assert.equal(r.mode, 'text'); assert.equal(r.text, long);
  assert.deepEqual(h.events, []);
});

test('mood follows the same conversation, resets on 别哭了, and facts remain neutral', () => {
  const sad = selectEmotion({ userText: '用哭腔说', now: 1000 });
  assert.equal(selectEmotion({ previous: sad, now: 2000 }).emotion, 'sad');
  assert.equal(selectEmotion({ userText: '别哭了，正常说', previous: sad, now: 2000 }).emotion, 'neutral');
  assert.equal(selectEmotion({ factual: true, previous: sad, now: 2000 }).emotion, 'neutral');
  assert.equal(selectEmotion({ previous: sad, now: 601001 }).emotion, 'neutral');
  assert.equal(selectEmotion({ now: 2000 }).emotion, 'neutral');
});

test('two concurrent requests serialize through backend shutdown and release', async t => {
  let resolveFirst; const first = new Promise(r => { resolveFirst = r; });
  let requests = 0;
  const h = fixture(t, { fetchImpl: async () => { requests++; if (requests === 1) await first; return new Response(pcmAudio()); } });
  const a = h.speech.synthesize({ key: KEY, text: '第一句话', explicit: true });
  const b = h.speech.synthesize({ key: 'g:11111', text: '第二句话', explicit: true });
  await new Promise(r => setImmediate(r));
  assert.equal(requests, 1); assert.equal(h.speech.status().queued, 1);
  resolveFirst();
  assert.equal((await a).mode, 'voice'); assert.equal((await b).mode, 'voice');
  assert.deepEqual(h.events, ['acquire', 'start', 'encode', 'stop', 'release', 'acquire', 'start', 'encode', 'stop', 'release']);
});

test('backend failure releases compute and falls back without leaking remote error text', async t => {
  const h = fixture(t, { fetchImpl: async () => { throw new Error('private token must never be logged'); } });
  const r = await h.speech.synthesize({ key: KEY, text: '原话保留。', explicit: true });
  assert.equal(r.mode, 'text'); assert.equal(r.text, '原话保留。');
  assert.deepEqual(h.events, ['acquire', 'start', 'stop', 'release']);
  assert.equal(h.speech.status().lastError, 'SPEECH_FAILED');
  assert.ok(!h.logs.join('').includes('private token'));
});

test('a JSON error body cannot be encoded as speech even with HTTP 200', async t => {
  const h = fixture(t, { fetchImpl: async () => new Response(JSON.stringify({ error: 'bad' }), { headers: { 'content-type': 'application/json' } }) });
  const r = await h.speech.synthesize({ key: KEY, text: '保留这句话', explicit: true });
  assert.equal(r.mode, 'text'); assert.ok(!h.events.includes('encode'));
  assert.deepEqual(h.events, ['acquire', 'start', 'stop', 'release']);
});

test('stop aborts in-flight work and does not start a queued request', async t => {
  let requests = 0;
  const h = fixture(t, { fetchImpl: async (_url, { signal }) => {
    requests++;
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new Error('aborted'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  } });
  const a = h.speech.synthesize({ key: KEY, text: '第一句话', explicit: true });
  const b = h.speech.synthesize({ key: KEY, text: '第二句话', explicit: true });
  await new Promise(r => setImmediate(r)); await h.speech.stop();
  assert.equal((await a).mode, 'text'); assert.equal((await b).reason, 'DISABLED');
  assert.equal(requests, 1); assert.equal(h.speech.status().queued, 0);
  assert.deepEqual(h.events, ['acquire', 'start', 'stop', 'release']);
});

test('voice message transcript persists across restart and can be scoped by conversation', async t => {
  const h = fixture(t);
  h.speech.remember(123, '这句话是用语音说的。', KEY);
  const reopened = createSpeech({ rootDir: h.root });
  assert.equal(reopened.lookup(123, KEY).text, '这句话是用语音说的。');
  assert.equal(reopened.lookup(123, 'p:999999'), null);
  await reopened.stop();
});

test('delivery uses one standalone record and records transcript after confirmation', async () => {
  const sends = [], saved = [];
  const deliver = createReplyDelivery({ speech: { synthesize: async () => ({ mode: 'voice', audio: Buffer.from('audio') }), remember: (...v) => saved.push(v) },
    transport: { sendPrivate: async (...args) => { sends.push(args); return { ok: true, data: { message_id: 7 } }; } } });
  const text = '原始正文【不会丢】（也不会改）。';
  const r = await deliver({ key: KEY, text, userText: '逐字原样读出来', prefix: [{ type: 'reply', data: { id: 3 } }], target: { userId: '70102' } });
  assert.equal(r.mode, 'voice'); assert.equal(sends.length, 1);
  assert.deepEqual(sends[0][1].map(s => s.type), ['record']);
  assert.deepEqual(saved, [[7, text, KEY]]);
});

test('synthesis failure falls back once but ambiguous QQ voice send never triggers text retry', async () => {
  for (const mode of ['synthesis-failure', 'send-failure']) {
    const sends = [], saved = [];
    const deliver = createReplyDelivery({ speech: {
      synthesize: async () => { if (mode === 'synthesis-failure') throw new Error(); return { mode: 'voice', audio: Buffer.from('audio') }; },
      remember: (...v) => saved.push(v),
    }, transport: { sendPrivate: async (_id, msg) => { sends.push(msg); return mode === 'send-failure' ? { ok: false, error: 'timeout' } : { ok: true }; } } });
    const r = await deliver({ key: KEY, text: '原始正文', target: { userId: '70102' } });
    assert.equal(sends.length, 1); assert.equal(saved.length, 0);
    assert.equal(sends[0][0].type, mode === 'synthesis-failure' ? 'text' : 'record');
    if (mode === 'send-failure') assert.equal(r.unknown, true);
  }
});

test('forceText skips speech entirely and malformed destinations cannot send', async () => {
  let syntheses = 0, sends = 0;
  const deliver = createReplyDelivery({ speech: { synthesize: async () => { syntheses++; } }, transport: { sendGroup: async () => { sends++; return { ok: true }; } } });
  const r = await deliver({ key: 'g:12345', text: '文字', target: { groupId: '12345' }, forceText: true });
  assert.equal(r.mode, 'text'); assert.equal(syntheses, 0); assert.equal(sends, 1);
  await assert.rejects(deliver({ key: KEY, text: '错误', target: { groupId: '1', userId: '2' } }));
  assert.equal(sends, 1);
});

test('requested voice continues for three related follow-ups, then returns to automatic selection', async t => {
  const h = fixture(t, { random: () => .99 });
  assert.equal((await h.speech.synthesize({ key: KEY, text: '呜，你终于回来了。', userText: '用哭腔说' })).mode, 'voice');
  for (const userText of ['太假了，多来几句', '再来', '再听一句']) {
    const r = await h.speech.synthesize({ key: KEY, text: '我还以为你不理我了。', userText });
    assert.equal(r.mode, 'voice'); assert.equal(r.style.emotion, 'sad');
  }
  assert.equal((await h.speech.synthesize({ key: KEY, text: '好吧。', userText: '再来' })).reason, 'AUTO_TEXT');
});

test('voice continuation is scoped, expires without extending, and unrelated tasks close it', async t => {
  let time = 1000;
  const h = fixture(t, { random: () => .99, now: () => time });
  const speak = userText => h.speech.synthesize({ key: KEY, text: '这是一句话。', userText });
  await speak('哭腔语音');
  assert.equal((await h.speech.synthesize({ key: 'p:99999', text: '收到。', userText: '再来' })).mode, 'text');
  time += 4 * 60000;
  assert.equal((await speak('再来')).mode, 'voice');
  time += 60001;
  assert.equal((await speak('再来')).reason, 'AUTO_TEXT');
  await speak('哭腔语音');
  assert.equal((await speak('再来一个视频')).reason, 'AUTO_TEXT');
  assert.equal((await speak('再来')).reason, 'AUTO_TEXT');
  await speak('哭腔语音');
  const neutral = await speak('别哭了，正常说');
  assert.equal(neutral.mode, 'voice'); assert.equal(neutral.style.emotion, 'neutral');
  assert.equal((await speak('不要语音，只发文字')).reason, 'TEXT_REQUESTED');
  assert.equal((await speak('再来')).reason, 'AUTO_TEXT');
});

test('failed voice cannot establish a continuation session', async t => {
  const h = fixture(t, { random: () => .99, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await h.speech.synthesize({ key: KEY, text: '你好。', userText: '哭腔语音' })).mode, 'text');
  assert.equal((await h.speech.synthesize({ key: KEY, text: '你好。', userText: '再来' })).reason, 'AUTO_TEXT');
});

test('token budget grows for longer text and oversized prose stays complete as text', async t => {
  assert.equal(speechTokenBudget('一句话。'), 375);
  assert.ok(speechTokenBudget('话'.repeat(160)) > 375);
  assert.equal(speechTokenBudget('话'.repeat(600)), null);
  assert.equal(speechTokenBudget('一句话。', 10000), null);
  const h = fixture(t);
  const text = '话'.repeat(600);
  const r = await h.speech.synthesize({ key: KEY, text, userText: '语音读出来' });
  assert.equal(r.reason, 'SPEECH_BUDGET_EXCEEDED'); assert.equal(r.text, text);
  assert.deepEqual(h.events, []);
  await h.speech.synthesize({ key: KEY, text: '话'.repeat(160), userText: '语音读出来' });
  assert.equal(Number(h.forms[0].body.get('max_new_tokens')), speechTokenBudget('话'.repeat(160)));
});

test('normal HTTP completion at the token ceiling and silent PCM fall back before encoding', async t => {
  for (const [pcm, reason] of [[pcmAudio(375 * .08), 'TRUNCATED_AUDIO'], [pcmAudio(373 * .08), 'TRUNCATED_AUDIO'], [Buffer.alloc(48000), 'SILENT_AUDIO']]) {
    const h = fixture(t, { fetchImpl: async () => new Response(pcm) });
    const r = await h.speech.synthesize({ key: KEY, text: '保留完整原话。', explicit: true });
    assert.equal(r.mode, 'text'); assert.equal(r.reason, reason); assert.equal(r.text, '保留完整原话。');
    assert.ok(!h.events.includes('encode'));
    assert.deepEqual(h.events, ['acquire', 'start', 'stop', 'release']);
  }
  assert.doesNotThrow(() => validateSpeechPcm(pcmAudio(372 * .08), 375));
});

test('required @ stays text automatically; explicit, continuation, and configured voice send only record', async t => {
  const h = fixture(t, { random: () => 0 });
  const sent = [];
  const deliver = createReplyDelivery({ speech: h.speech, transport: { sendGroup: async (_id, segments) => {
    sent.push(segments); return { ok: true, data: { message_id: sent.length } };
  } } });
  const opts = { key: 'g:12345', text: '我在这里。', prefix: [{ type: 'reply', data: { id: 8 } }, { type: 'at', data: { qq: '70102' } }], target: { groupId: '12345' } };
  assert.equal((await deliver(opts)).mode, 'text');
  assert.deepEqual(sent[0].map(s => s.type), ['reply', 'at', 'text']);
  assert.equal(h.events.length, 0);
  assert.equal((await deliver({ ...opts, userText: '用哭腔语音说' })).mode, 'voice');
  assert.deepEqual(sent[1].map(s => s.type), ['record']);
  assert.equal((await deliver({ ...opts, userText: '再听一句' })).mode, 'voice');
  assert.deepEqual(sent[2].map(s => s.type), ['record']);
  h.speech.updateConfig({ mode: 'voice' });
  assert.equal((await deliver({ ...opts, userText: '你来了' })).mode, 'voice');
  assert.deepEqual(sent[3].map(s => s.type), ['record']);
  assert.equal(sent.length, 4);
});
