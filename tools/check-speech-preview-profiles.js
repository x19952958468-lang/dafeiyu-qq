import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSpeechConfig } from '../src/speech/index.js';
import { createSpeech } from './helpers/speech-fixture.js';

// Only disposable files are real. No model, QQ, encoder, or network is used.
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-preview-profiles-'));
  const dir = path.join(root, 'data/speech');
  const referenceAudio = path.join(root, 'preview-reference.wav');
  fs.writeFileSync(referenceAudio, 'trusted profile reference');
  const calls = { forms: [], backend: 0, directions: 0 };
  const pcm = Buffer.alloc(4800);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(i % 4 ? 1500 : -1500, i);
  const speech = createSpeech({ rootDir: root, now: () => 1000, random: () => 0,
    ensureBackendReady: async () => { calls.backend++; },
    llm: { directSpeech: async () => { calls.directions++; return {}; } },
    fetchImpl: async (_url, { body }) => { calls.forms.push(body); return new Response(pcm); },
    runImpl: async (_binary, args) => fs.writeFileSync(args.at(-1), Buffer.concat([Buffer.from('ID3'), Buffer.alloc(160)])),
    ...overrides,
  });
  speech.updateConfig({ voiceId: 'live-saved-voice', cfgScale: 3 });
  const profile = { referenceAudio, referenceText: '这是参考语音的准确文本。', cfgScale: 0, instruction: '' };
  const file = path.join(dir, 'preview-profiles.json');
  const writeProfiles = value => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  writeProfiles({ 'early-clone': profile });
  t.after(async () => { await speech.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dir, file, referenceAudio, calls, profile, writeProfiles, speech };
}

test('trusted preview profile sends its exact reference, CFG zero and explicit empty instruction', async t => {
  const h = fixture(t);
  const config = h.speech.config();
  const result = await h.speech.preview({ text: '这是一句新的台词。', profile: 'early-clone' });
  assert.equal(result.mode, 'voice');
  const form = h.calls.forms[0];
  assert.equal(form.get('cfg_scale'), '0');
  assert.equal(form.get('instruction'), '');
  assert.equal(form.get('ref_text'), h.profile.referenceText);
  assert.equal(form.get('ref_audio').name, 'preview-reference.wav');
  assert.equal(await form.get('ref_audio').text(), 'trusted profile reference');
  assert.equal(form.has('voice_id'), false, 'The live saved voice must not override the preview reference');
  assert.equal(h.calls.directions, 0, 'A fixed audition instruction must not be replaced by the LLM');
  assert.deepEqual(h.speech.config(), config);
  assert.throws(() => validateSpeechConfig({ cfgScale: 0 }), { message: 'INVALID_CFG' });
});

test('profiles leave live config, moods and voice continuation untouched; normal and default preview keep their original settings', async t => {
  const h = fixture(t), key = 'p:70102';
  await h.speech.synthesize({ key, text: '我刚才真的有点难过。', userText: '用哭腔说', explicit: true });
  const stateFile = path.join(h.dir, 'state.json'), configFile = path.join(h.dir, 'config.json');
  const before = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const configBefore = fs.readFileSync(configFile, 'utf8');
  assert.equal(before.moods[key].emotion, 'sad');
  await h.speech.preview({ text: '现在开心地说一句。', userText: '笑着说', profile: 'early-clone' });
  const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(after.moods, before.moods);
  assert.deepEqual(after.voices, before.voices);
  assert.equal(fs.readFileSync(configFile, 'utf8'), configBefore);

  // Public synthesis cannot opt into profiles or pass its own snapshot overrides.
  const live = await h.speech.synthesize({ key, text: '接着说这件事。', userText: '再来一句', explicit: true,
    profile: 'early-clone', previewProfile: h.profile, snapshot: { ...h.profile, voiceId: '' } });
  assert.equal(live.mode, 'voice');
  const liveForm = h.calls.forms.at(-1);
  assert.equal(liveForm.get('voice_id'), 'live-saved-voice');
  assert.equal(liveForm.has('ref_audio'), false);
  assert.equal(liveForm.get('cfg_scale'), '3');
  assert.notEqual(liveForm.get('instruction'), '');

  const directionsBefore = h.calls.directions;
  await h.speech.preview({ text: '今天见到你了。' });
  const defaultForm = h.calls.forms.at(-1);
  assert.equal(defaultForm.get('voice_id'), 'live-saved-voice');
  assert.equal(defaultForm.get('cfg_scale'), '3');
  assert.notEqual(defaultForm.get('instruction'), '');
  assert.equal(h.calls.directions, directionsBefore + 1);
});

test('profile previews can audition a trusted reference even when the live voice is unconfigured', async t => {
  const h = fixture(t);
  h.speech.updateConfig({ voiceId: '', referenceAudio: '', referenceText: '' });
  assert.equal(h.speech.status().ready, false);
  assert.equal((await h.speech.preview({ text: '普通试听。' })).reason, 'VOICE_NOT_CONFIGURED');
  assert.equal((await h.speech.preview({ text: '参考试听。', profile: 'early-clone' })).mode, 'voice');
  assert.equal(h.speech.status().ready, false);
});

test('directed profiles preserve exact instruction text and accept the configured upper CFG bound', async t => {
  const h = fixture(t), instruction = '带一点忍住眼泪的感觉，自然地说，不要念稿。';
  h.writeProfiles({ 'early-directed': { ...h.profile, instruction, cfgScale: 5 } });
  assert.equal((await h.speech.preview({ text: '我听见了。', profile: 'early-directed' })).mode, 'voice');
  assert.equal(h.calls.forms[0].get('instruction'), instruction);
  assert.equal(h.calls.forms[0].get('cfg_scale'), '5');
});

test('unknown or malformed profiles and external overrides fail before backend work', async t => {
  const h = fixture(t), base = { text: '你好。' };
  for (const profile of [null, {}, [], 0, '', '../early-clone', '/tmp/ref.wav', 'Early-clone', 'early_clone', 'early-clone\n', 'a'.repeat(49), 'missing']) {
    await assert.rejects(h.speech.preview({ ...base, profile }), { message: 'INVALID_PREVIEW' });
  }
  for (const field of ['referenceAudio', 'referenceText', 'cfgScale', 'instruction', 'voiceId', 'snapshot', 'previewProfile', 'key']) {
    await assert.rejects(h.speech.preview({ ...base, profile: 'early-clone', [field]: 'untrusted' }), { message: 'INVALID_PREVIEW' });
  }
  for (const input of [null, [], 'early-clone']) await assert.rejects(h.speech.preview(input), { message: 'INVALID_PREVIEW' });
  for (const value of [null, [], {}, { ...h.profile, cfgScale: -1 }, { ...h.profile, cfgScale: 5.01 },
    { ...h.profile, cfgScale: '0' }, { ...h.profile, instruction: null }, { ...h.profile, instruction: '字'.repeat(2001) },
    { ...h.profile, instruction: 'bad\0text' }, { ...h.profile, referenceText: ' ' },
    { ...h.profile, referenceAudio: 'relative.wav' }, { ...h.profile, referenceAudio: path.join(h.root, 'missing.wav') },
    { ...h.profile, referenceAudio: h.root }, { ...h.profile, backendUrl: 'http://127.0.0.1:9999' }]) {
    h.writeProfiles({ 'early-clone': value });
    await assert.rejects(h.speech.preview({ ...base, profile: 'early-clone' }), { message: 'INVALID_PREVIEW' });
  }
  for (const document of ['{', 'null', '[]']) {
    fs.writeFileSync(h.file, document);
    await assert.rejects(h.speech.preview({ ...base, profile: 'early-clone' }), { message: 'INVALID_PREVIEW' });
  }
  fs.rmSync(h.file);
  await assert.rejects(h.speech.preview({ ...base, profile: 'early-clone' }), { message: 'INVALID_PREVIEW' });
  assert.equal(h.calls.backend, 0);
  assert.equal(h.calls.forms.length, 0);
  assert.equal(h.calls.directions, 0);
});
