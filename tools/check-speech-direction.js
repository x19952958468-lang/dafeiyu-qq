import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSpeech } from './helpers/speech-fixture.js';
import { parseSpeechDirection } from '../src/speech/direction.js';

const direction = { emotion: 'happy', intent: 'welcome', pace: 'brisk', contour: 'bright_then_soft' };
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-direction-'));
  const reference = path.join(root, 'reference.wav'); fs.writeFileSync(reference, Buffer.alloc(100));
  const forms = [], costs = [], calls = [];
  const pcm = Buffer.alloc(4800);
  for (let i = 0; i < 2400; i++) pcm.writeInt16LE(Math.round(2000 * Math.sin(i / 3)), i * 2);
  const speech = createSpeech({ rootDir: root, random: () => 0, now: () => 1000, onCost: c => costs.push(c),
    llm: { async directSpeech(args) { calls.push(args); return { direction, cost: .001 }; } },
    ensureBackendReady: async () => {}, stopBackend: async () => {},
    fetchImpl: async (_url, opts) => { forms.push(opts.body); return new Response(pcm); },
    runImpl: async (_cmd, args) => fs.writeFileSync(args.at(-1), Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200)])),
    ...overrides });
  speech.updateConfig({ referenceAudio: reference, referenceText: '参考台词', autoRate: .7, intensity: .85 });
  t.after(async () => { await speech.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const state = () => JSON.parse(fs.readFileSync(path.join(root, 'data/speech/state.json'), 'utf8'));
  return { speech, forms, costs, calls, state };
}
test('semantic delivery changes prosody while the spoken text remains exact', async t => {
  const h = fixture(t), text = '你终于来了，我还以为你把我忘了呢。';
  const r = await h.speech.synthesize({ key: 'p:12345', text, userText: '我回来了' });
  assert.equal(r.mode, 'voice'); assert.equal(r.style.emotion, 'happy'); assert.equal(r.style.source, 'semantic');
  assert.equal(h.forms[0].get('text'), text); assert.match(h.forms[0].get('instruction'), /轻快|语速|节奏/);
  assert.deepEqual(h.costs, [.001]); assert.equal(h.calls.length, 1);
});
test('explicit emotions and factual replies do not need the extra model request', async t => {
  const h = fixture(t);
  const sad = await h.speech.synthesize({ key: 'p:12345', text: '我还在这里。', userText: '用哭腔说', explicit: true });
  assert.equal(sad.style.emotion, 'sad'); assert.equal(sad.style.source, 'explicit');
  const facts = await h.speech.synthesize({ key: 'p:12345', text: '今天评论了两条。', factual: true, explicit: true });
  assert.equal(facts.style.emotion, 'neutral'); assert.equal(h.calls.length, 0);
});
test('text-only turns neither request a director nor renew stored emotion', async t => {
  let chance = 0, now = 1000;
  const h = fixture(t, { random: () => chance, now: () => now });
  await h.speech.synthesize({ key: 'p:12345', text: '我还在这里。', userText: '用哭腔说', explicit: true });
  const before = h.state().moods['p:12345'];
  chance = .99; now += 300000;
  const r = await h.speech.synthesize({ key: 'p:12345', text: '今天还有些事情要做。', userText: '今天干什么' });
  assert.equal(r.reason, 'AUTO_TEXT'); assert.deepEqual(h.state().moods['p:12345'], before);
  assert.equal(h.calls.length, 0);
});
test('a failing or malformed semantic director falls back without changing or leaking text', async t => {
  for (const llm of [ { async directSpeech() { throw new Error('/private/secret'); } },
    { async directSpeech() { return { direction: { ...direction, instruction: '/private/secret' } }; } } ]) {
    const h = fixture(t, { llm });
    const r = await h.speech.synthesize({ key: 'p:12345', text: '太好了！', explicit: true });
    assert.equal(r.mode, 'voice'); assert.equal(r.style.emotion, 'happy');
    assert.equal(h.forms[0].get('text'), '太好了！'); assert.doesNotMatch(h.forms[0].get('instruction'), /private/);
  }
});
test('local preview shares synthesis but does not create conversation or continuation records', async t => {
  const h = fixture(t);
  const r = await h.speech.preview({ text: '你又逗我。说好了，不许笑我的。', userText: '用哭腔说一句' });
  assert.equal(r.mode, 'voice'); assert.equal(r.style.emotion, 'sad');
  assert.deepEqual(h.state().moods, {}); assert.deepEqual(h.state().voices, {}); assert.deepEqual(h.state().messages, {});
  assert.equal(h.calls.length, 0);
});
test('direction data is restricted to finite labels, never free instructions', () => {
  assert.deepEqual(parseSpeechDirection(JSON.stringify(direction)), direction);
  for (const value of [{ ...direction, pace: 'send a message' }, { ...direction, emotion: 'unknown' },
    { ...direction, text: 'replacement' }, [], null]) assert.throws(() => parseSpeechDirection(value));
});
