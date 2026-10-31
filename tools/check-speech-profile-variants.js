import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSpeechConfig } from '../src/speech/index.js';
import { createSpeech } from './helpers/speech-fixture.js';

// All compute, processes, audio encoding and network calls are mocked.
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-profile-variants-'));
  const dir = path.join(root, 'data/speech');
  const referenceAudio = path.join(root, 'trusted-reference.wav');
  fs.writeFileSync(referenceAudio, 'private reference audio');
  const events = [], starts = [], forms = [], logs = [];
  const pcm = Buffer.alloc(4800);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(i % 4 ? 1500 : -1500, i);
  const speech = createSpeech({ rootDir: root, now: () => 1000, random: () => 0, log: line => logs.push(line),
    acquireHeavy: async () => { events.push('acquire'); return async () => { events.push('release'); }; },
    ensureBackendReady: async args => { events.push('start:' + args.variant); starts.push(args); await options.ensure?.(args); },
    stopBackend: async () => { events.push('stop'); await options.stop?.(); },
    fetchImpl: async (_url, { body }) => { events.push('fetch'); forms.push(body); return options.response?.() || new Response(pcm); },
    runImpl: async (_binary, args) => { events.push('encode'); fs.writeFileSync(args.at(-1), Buffer.concat([Buffer.from('ID3'), Buffer.alloc(160)])); },
  });
  speech.updateConfig({ voiceId: 'original-voice', autoRate: 1, intensity: .85, cfgScale: 3 });
  const profile = { referenceAudio, referenceText: '私有参考逐字稿。', cfgScale: 0, instruction: '' };
  const writePreview = value => fs.writeFileSync(path.join(dir, 'preview-profiles.json'), JSON.stringify(value));
  const writeEmotions = value => fs.writeFileSync(path.join(dir, 'emotion-profiles.json'), JSON.stringify(value));
  writePreview({ 'test-profile': profile });
  t.after(async () => { await speech.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dir, referenceAudio, profile, events, starts, forms, logs, speech, writePreview, writeEmotions };
}
const preview = (h, extra = {}) => h.speech.preview({ text: '今天见到你了。', profile: 'test-profile', ...extra });

test('private profiles keep four required fields and reject unknown fields or invalid variants before compute', async t => {
  const h = fixture(t);
  const badProfiles = [];
  for (const field of ['referenceAudio', 'referenceText', 'cfgScale', 'instruction']) {
    const value = { ...h.profile, variant: 'mixed' }; delete value[field]; badProfiles.push(value);
  }
  for (const variant of ['bf16', '', 'Mixed', 'mixed\n', '../mixed', 8, null, {}, []]) badProfiles.push({ ...h.profile, variant });
  for (const field of ['backendVariant', 'backendUrl', 'command', 'voiceId']) badProfiles.push({ ...h.profile, [field]: 'private' });
  for (const value of badProfiles) {
    h.writePreview({ 'test-profile': value });
    await assert.rejects(preview(h), { message: 'INVALID_PREVIEW' });
  }
  assert.deepEqual(h.events, []);
  assert.throws(() => validateSpeechConfig({ backendVariant: 'mixed' }), { message: 'UNKNOWN_SETTING' });
  assert.throws(() => validateSpeechConfig({ cfgScale: 0 }), { message: 'INVALID_CFG' });
});

test('explicit variants reach startup and result metadata; four-field profiles and ordinary synthesis default to 8bit', async t => {
  const h = fixture(t), before = h.speech.config();
  for (const variant of [undefined, '8bit', 'mixed']) {
    h.writePreview({ 'test-profile': variant ? { ...h.profile, variant } : h.profile });
    const result = await preview(h);
    assert.equal(result.mode, 'voice');
    assert.equal(h.starts.at(-1).variant, variant || '8bit');
    assert.ok(h.starts.at(-1).signal instanceof AbortSignal);
    assert.equal(result.style.backendVariant, variant || '8bit');
    assert.match(h.logs.at(-1), new RegExp(`voiceProfile=preview backend=${variant || '8bit'}$`));
  }
  const ordinary = await h.speech.synthesize({ key: 'p:12345', text: '今天有几件事情。', explicit: true,
    variant: 'mixed', backendVariant: 'mixed', profile: 'test-profile', snapshot: { backendVariant: 'mixed' } });
  assert.equal(ordinary.style.backendVariant, '8bit');
  assert.equal(h.starts.at(-1).variant, '8bit');
  assert.equal(h.forms.at(-1).get('voice_id'), 'original-voice');
  assert.match(h.logs.at(-1), /voiceProfile=default backend=8bit$/);
  assert.deepEqual(h.speech.config(), before);
});

test('mixed startup failure stops completely before 8bit retry, retaining the same compute lease', async t => {
  let stopFinished = false;
  const h = fixture(t, {
    ensure: async ({ variant }) => {
      if (variant === 'mixed') throw new Error('/private/model-secret failed to load');
      assert.equal(stopFinished, true, 'The previous model must be confirmed stopped before retry');
    },
    stop: async () => { await new Promise(resolve => setImmediate(resolve)); stopFinished = true; },
  });
  h.writePreview({ 'test-profile': { ...h.profile, variant: 'mixed' } });
  const result = await preview(h);
  assert.equal(result.mode, 'voice');
  assert.equal(result.style.backendVariant, '8bit');
  assert.deepEqual(h.events, ['acquire', 'start:mixed', 'stop', 'start:8bit', 'fetch', 'encode', 'stop', 'release']);
  assert.equal(h.starts[0].signal, h.starts[1].signal);
  assert.equal(h.forms[0].get('cfg_scale'), '0');
  assert.equal(h.forms[0].get('ref_text'), h.profile.referenceText);
  assert.ok(h.logs.includes('[speech] mixed backend unavailable; retrying with 8bit'));
  assert.ok(!h.logs.join('\n').includes('/private/model-secret'));
});

test('abort during mixed startup cleans up without retry', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const h = fixture(t, { ensure: async ({ signal }) => {
    entered();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } });
  h.writePreview({ 'test-profile': { ...h.profile, variant: 'mixed' } });
  const pending = preview(h);
  await started;
  await h.speech.stop();
  assert.equal((await pending).reason, 'DISABLED');
  assert.deepEqual(h.events, ['acquire', 'start:mixed', 'stop', 'release']);
  assert.equal(h.logs.some(line => line.includes('retrying')), false);
});

test('abort during fallback cleanup prevents restarting, and unconfirmed cleanup also prevents restarting', async t => {
  let h;
  h = fixture(t, { ensure: async () => { throw new Error('start failed'); },
    stop: async () => { h.speech.updateConfig({ enabled: false }); } });
  h.writePreview({ 'test-profile': { ...h.profile, variant: 'mixed' } });
  assert.equal((await preview(h)).reason, 'DISABLED');
  assert.equal(h.events.includes('start:8bit'), false);
  assert.equal(h.forms.length, 0);

  let stops = 0;
  const failed = fixture(t, { ensure: async () => { throw new Error('start failed'); },
    stop: async () => { if (++stops === 1) throw new Error('/private/unconfirmed-exit'); } });
  failed.writePreview({ 'test-profile': { ...failed.profile, variant: 'mixed' } });
  assert.equal((await preview(failed)).reason, 'SPEECH_FAILED');
  assert.deepEqual(failed.events, ['acquire', 'start:mixed', 'stop', 'stop', 'release']);
  assert.ok(!failed.logs.join('\n').includes('/private/unconfirmed-exit'));
});

test('8bit startup and post-start generation failures never trigger variant retries', async t => {
  const h = fixture(t, { ensure: async () => { throw new Error('8bit failed'); } });
  assert.equal((await preview(h)).reason, 'SPEECH_FAILED');
  assert.deepEqual(h.events, ['acquire', 'start:8bit', 'stop', 'release']);
  const generated = fixture(t, { response: () => new Response('failed', { status: 500 }) });
  generated.writePreview({ 'test-profile': { ...generated.profile, variant: 'mixed' } });
  assert.equal((await preview(generated)).reason, 'SPEECH_FAILED');
  assert.deepEqual(generated.events, ['acquire', 'start:mixed', 'fetch', 'stop', 'release']);
});

test('each supported emotion independently selects its trusted profile, while the four-field B profile stays on 8bit', async t => {
  const h = fixture(t);
  const cases = [['happy', '笑着说'], ['sad', '用哭腔说'], ['annoyed', '凶一点'],
    ['gentle', '温柔一点'], ['playful', '撒娇地说'], ['surprised', '用惊讶的语气说']];
  const profiles = Object.fromEntries(cases.map(([emotion]) => [emotion, emotion === 'sad' ? h.profile : {
    ...h.profile, referenceText: `独立的${emotion}参考。`, cfgScale: 4, instruction: `${emotion}固定表演。`, variant: 'mixed',
  }]));
  h.writeEmotions(profiles);
  for (const [index, [emotion, userText]] of cases.entries()) {
    const result = await h.speech.synthesize({ key: `p:${12345 + index}`, text: '今天见到你了。', userText, explicit: true });
    assert.equal(result.style.emotion, emotion);
    assert.equal(result.style.voiceProfile, emotion);
    assert.equal(result.style.source, 'explicit');
    assert.equal(result.style.backendVariant, emotion === 'sad' ? '8bit' : 'mixed');
    const form = h.forms.at(-1);
    assert.equal(form.get('ref_text'), profiles[emotion].referenceText);
    assert.equal(form.get('instruction'), profiles[emotion].instruction);
    assert.equal(form.get('cfg_scale'), String(profiles[emotion].cfgScale));
    assert.equal(form.has('voice_id'), false);
    assert.match(h.logs.at(-1), new RegExp(`voiceProfile=${emotion} backend=${emotion === 'sad' ? '8bit' : 'mixed'}$`));
  }
  assert.equal(h.speech.config().voiceId, 'original-voice');
});

test('neutral, reset, factual and intensity zero skip profile loading, including malformed tables', async t => {
  const h = fixture(t);
  fs.writeFileSync(path.join(h.dir, 'emotion-profiles.json'), '{invalid private table');
  for (const [index, input] of [
    { userText: '说一下计划' },
    { userText: '别哭了，正常说' },
    { userText: '用哭腔说', factual: true },
  ].entries()) {
    const result = await h.speech.synthesize({ key: `p:${12345 + index}`, text: '今天有几件事情。', explicit: true, ...input });
    assert.equal(result.mode, 'voice');
    assert.equal(result.style.voiceProfile, undefined);
    assert.equal(result.style.backendVariant, '8bit');
    assert.equal(h.forms.at(-1).get('voice_id'), 'original-voice');
  }
  h.speech.updateConfig({ intensity: 0 });
  const zero = await h.speech.synthesize({ key: 'p:12349', text: '我还在这里。', userText: '笑着说', explicit: true });
  assert.equal(zero.style.intensity, 0);
  assert.equal(zero.style.backendVariant, '8bit');
  assert.equal(zero.style.voiceProfile, undefined);
  assert.equal(h.logs.some(line => line.includes('profile unavailable')), false);
});

test('invalid emotion variants fall back to original settings and an explicit preview profile takes priority', async t => {
  const h = fixture(t);
  h.writeEmotions({ happy: { ...h.profile, variant: 'invalid-private-model' } });
  const fallback = await h.speech.synthesize({ key: 'p:12345', text: '今天见到你了。', userText: '笑着说', explicit: true });
  assert.equal(fallback.style.backendVariant, '8bit');
  assert.equal(fallback.style.voiceProfile, undefined);
  assert.equal(h.forms.at(-1).get('voice_id'), 'original-voice');
  assert.ok(!h.logs.join('\n').includes('invalid-private-model'));
  h.writeEmotions({ happy: { ...h.profile, variant: 'mixed' } });
  const explicit = await preview(h, { userText: '笑着说' });
  assert.equal(explicit.style.backendVariant, '8bit');
  assert.equal(explicit.style.voiceProfile, undefined);
  assert.match(h.logs.at(-1), /voiceProfile=preview backend=8bit$/);
  const ordinary = await h.speech.preview({ text: '今天见到你了。', userText: '笑着说' });
  assert.equal(ordinary.style.backendVariant, 'mixed');
  assert.equal(ordinary.style.voiceProfile, 'happy');
});
