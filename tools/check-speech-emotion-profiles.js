import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSpeechConfig } from '../src/speech/index.js';
import { createSpeech } from './helpers/speech-fixture.js';

// Local disposable files only: model, network, encoder and QQ are never used.
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-emotion-profiles-'));
  const dir = path.join(root, 'data/speech'), file = path.join(dir, 'emotion-profiles.json');
  const referenceAudio = path.join(root, 'sad-private-reference.wav');
  fs.writeFileSync(referenceAudio, 'trusted emotional reference');
  const forms = [], logs = [];
  const pcm = Buffer.alloc(4800);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(i % 4 ? 1500 : -1500, i);
  const speech = createSpeech({ rootDir: root, now: () => 1000, random: () => 0, log: value => logs.push(value),
    fetchImpl: async (_url, { body }) => { forms.push(body); return new Response(pcm); },
    runImpl: async (_binary, args) => fs.writeFileSync(args.at(-1), Buffer.concat([Buffer.from('ID3'), Buffer.alloc(160)])),
    ...overrides,
  });
  speech.updateConfig({ voiceId: 'original-live-voice', cfgScale: 3, autoRate: 1, intensity: .85 });
  const profile = { referenceAudio, referenceText: '这是一段私有参考的准确文本。', cfgScale: 0, instruction: '' };
  const writeProfiles = value => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  writeProfiles({ sad: profile });
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  t.after(async () => { await speech.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dir, file, referenceAudio, profile, writeProfiles, state, forms, logs, speech };
}
function assertSadReference(h, result, source) {
  assert.equal(result.mode, 'voice');
  assert.equal(result.style.emotion, 'sad');
  assert.equal(result.style.source, source);
  assert.equal(result.style.voiceProfile, 'sad');
  const form = h.forms.at(-1);
  assert.equal(form.get('cfg_scale'), '0');
  assert.equal(form.get('instruction'), '');
  assert.equal(form.get('ref_text'), h.profile.referenceText);
  assert.equal(form.get('ref_audio').name, 'sad-private-reference.wav');
  assert.equal(form.has('voice_id'), false);
}
function assertOriginalReference(h, result) {
  assert.equal(result.mode, 'voice');
  assert.equal(result.style.voiceProfile, undefined);
  const form = h.forms.at(-1);
  assert.equal(form.get('voice_id'), 'original-live-voice');
  assert.equal(form.get('cfg_scale'), '3');
  assert.equal(form.has('ref_audio'), false);
  assert.notEqual(form.get('instruction'), '');
}

test('explicit crying and related continuations use the selected reference without changing transcript or source', async t => {
  const h = fixture(t), key = 'p:12345', text = '你又逗我。说好了，不许笑我的。';
  const first = await h.speech.synthesize({ key, text, userText: '用哭腔说' });
  assertSadReference(h, first, 'explicit');
  assert.equal(first.text, text);
  assert.equal(h.forms.at(-1).get('text'), text);
  assert.equal(await h.forms.at(-1).get('ref_audio').text(), 'trusted emotional reference');
  const continued = await h.speech.synthesize({ key, text: '我还在这里。', userText: '再来一句' });
  assertSadReference(h, continued, 'continuation');
  assert.equal(continued.style.time, first.style.time);
});

test('the final semantic direction can select sadness even without a sadness keyword', async t => {
  let calls = 0;
  const h = fixture(t, { llm: { directSpeech: async () => { calls++; return {
    direction: { emotion: 'sad', intent: 'chat', pace: 'slow', contour: 'hesitant_then_open' },
  }; } } });
  const result = await h.speech.synthesize({ key: 'p:12345', text: '你总算来了。', userText: '接着说吧', explicit: true });
  assertSadReference(h, result, 'semantic');
  assert.equal(calls, 1);
});

test('reset, neutral, other emotions, factual responses and zero intensity keep the original voice', async t => {
  const h = fixture(t);
  await h.speech.synthesize({ key: 'p:12345', text: '我还在这里。', userText: '用哭腔说' });
  const cases = [
    { key: 'p:12345', text: '好的，听你的。', userText: '别哭了，正常说', expected: 'reset' },
    { key: 'p:12346', text: '今天有几件事要做。', userText: '说一下计划', expected: 'neutral' },
    { key: 'p:12347', text: '你终于来了。', userText: '笑着说', expected: 'explicit' },
    { key: 'p:12348', text: '今天有两条评论。', userText: '用哭腔说', factual: true, expected: 'factual' },
  ];
  for (const { expected, ...input } of cases) {
    const result = await h.speech.synthesize({ ...input, explicit: true });
    assertOriginalReference(h, result);
    assert.equal(result.style.source, expected);
  }
  h.speech.updateConfig({ intensity: 0 });
  const zero = await h.speech.synthesize({ key: 'p:12349', text: '我还在这里。', userText: '用哭腔说' });
  assertOriginalReference(h, zero);
  assert.equal(zero.style.emotion, 'sad');
  assert.equal(zero.style.intensity, 0);
});

test('default preview follows production routing, while an explicit preview profile has priority', async t => {
  const h = fixture(t), text = '你又逗我。', userText = '用哭腔说';
  assertSadReference(h, await h.speech.preview({ text, userText }), 'explicit');
  const alternate = path.join(h.root, 'preview-only.wav');
  fs.writeFileSync(alternate, 'separate audition reference');
  fs.writeFileSync(path.join(h.dir, 'preview-profiles.json'), JSON.stringify({ 'alternate-preview': {
    referenceAudio: alternate, referenceText: '另一份试听稿。', cfgScale: 2, instruction: '按试听设定说。',
  } }));
  const explicit = await h.speech.preview({ text, userText, profile: 'alternate-preview' });
  assert.equal(explicit.mode, 'voice');
  assert.equal(explicit.style.source, 'explicit');
  assert.equal(explicit.style.voiceProfile, undefined);
  const form = h.forms.at(-1);
  assert.equal(form.get('ref_audio').name, 'preview-only.wav');
  assert.equal(form.get('ref_text'), '另一份试听稿。');
  assert.equal(form.get('cfg_scale'), '2');
  assert.equal(form.get('instruction'), '按试听设定说。');
  assert.deepEqual(h.state().moods, {});
  assert.deepEqual(h.state().voices, {});
});

test('missing file or missing sadness entry leaves old behavior unchanged without warnings', async t => {
  const h = fixture(t);
  for (const document of [null, {}]) {
    if (document === null) fs.rmSync(h.file);
    else h.writeProfiles(document);
    const result = await h.speech.synthesize({ key: 'p:12345', text: '我还在这里。', userText: '用哭腔说' });
    assertOriginalReference(h, result);
  }
  assert.equal(h.logs.some(line => line.includes('profile unavailable')), false);
});

test('malformed entries, unreadable tables and missing reference files fall back without leaking private data', async t => {
  const h = fixture(t);
  const invalidDocuments = ['{', 'null', '[]', JSON.stringify({ sad: { ...h.profile, cfgScale: -1 } }),
    JSON.stringify({ sad: { ...h.profile, instruction: 'x'.repeat(2001) } }),
    JSON.stringify({ sad: { ...h.profile, referenceAudio: path.join(h.root, 'missing-private.wav') } }),
    JSON.stringify({ sad: { ...h.profile, backendUrl: 'http://private.invalid' } }),
    JSON.stringify({ sad: null })];
  for (const document of invalidDocuments) {
    fs.writeFileSync(h.file, document);
    assertOriginalReference(h, await h.speech.synthesize({ key: 'p:12345', text: '我还在这里。', userText: '用哭腔说' }));
  }
  h.writeProfiles({ sad: h.profile });
  fs.rmSync(h.referenceAudio);
  assertOriginalReference(h, await h.speech.synthesize({ key: 'p:12345', text: '我还在这里。', userText: '用哭腔说' }));
  fs.rmSync(h.file); fs.mkdirSync(h.file);
  assertOriginalReference(h, await h.speech.synthesize({ key: 'p:12345', text: '我还在这里。', userText: '用哭腔说' }));
  const warnings = h.logs.filter(line => line.includes('profile unavailable'));
  assert.equal(warnings.length, invalidDocuments.length + 2);
  assert.ok(warnings.every(line => line === '[speech] emotion voice profile unavailable; using default voice'));
  assert.ok(!h.logs.join('\n').includes(h.root));
  assert.ok(!h.logs.join('\n').includes(h.profile.referenceText));
});

test('profile routing is private and per request; configuration and persisted state contain no profile data', async t => {
  const h = fixture(t), key = 'p:12345';
  const configBefore = h.speech.config();
  const configFileBefore = fs.readFileSync(path.join(h.dir, 'config.json'), 'utf8');
  await h.speech.synthesize({ key, text: '我还在这里。', userText: '用哭腔说' });
  assert.deepEqual(h.state().moods[key], { emotion: 'sad', intensity: .85, time: 1000 });
  const beforePreview = h.state();
  await h.speech.preview({ text: '你又逗我。', userText: '用哭腔说' });
  assert.deepEqual(h.state(), beforePreview);
  assert.deepEqual(h.speech.config(), configBefore);
  assert.equal(fs.readFileSync(path.join(h.dir, 'config.json'), 'utf8'), configFileBefore);
  const stateText = JSON.stringify(h.state());
  for (const privateValue of [h.profile.referenceAudio, h.profile.referenceText, 'voiceProfile', 'cfgScale'])
    assert.ok(!stateText.includes(privateValue));
  const neutral = await h.speech.synthesize({ key: 'p:12346', text: '这是一条普通回复。', userText: '聊聊今天', explicit: true,
    profile: 'sad', emotionProfile: h.profile, previewProfile: h.profile, snapshot: { ...h.profile, voiceId: '' },
    style: { emotion: 'sad', intensity: 1 } });
  assertOriginalReference(h, neutral);
  assert.throws(() => validateSpeechConfig({ cfgScale: 0 }), { message: 'INVALID_CFG' });
});
