import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReplyDelivery } from '../src/speech/index.js';
import { createSpeech } from './helpers/speech-fixture.js';
import { prepareVocalizedText } from '../src/speech/spoken-text.js';

const ORIGINAL = '不就是哭两声嘛，我哭就是了……（声音抖着，鼻音很浓）呜，呜……听到了没有，满意了吗？';
const SPOKEN = '不就是哭两声嘛，我哭就是了……呜，呜……听到了没有，满意了吗？';
const MODEL = '不就是哭两声嘛，我哭就是了……[sob]听到了没有，满意了吗？';
const KEY = 'p:12345';
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cry-a-'));
  const dir = path.join(root, 'data/speech'); fs.mkdirSync(dir, { recursive: true });
  const referenceAudio = path.join(root, 'reference.wav'); fs.writeFileSync(referenceAudio, 'reference');
  const profile = { referenceAudio, referenceText: '本来不想哭的。', cfgScale: 2,
    instruction: '测试抽泣指导', variant: 'mixed', vocalization: 'sob' };
  fs.writeFileSync(path.join(dir, 'emotion-profiles.json'), JSON.stringify({ sad: profile }));
  const forms = [], variants = [];
  const pcm = Buffer.alloc(4800); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(i % 4 ? 1500 : -1500, i);
  const speech = createSpeech({ rootDir: root, random: () => 0,
    ensureBackendReady: async ({ variant }) => variants.push(variant),
    fetchImpl: async (_url, { body }) => { forms.push(body); return new Response(pcm); },
    runImpl: async (_cmd, args) => fs.writeFileSync(args.at(-1), Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200)])),
    ...overrides });
  speech.updateConfig({ referenceAudio, referenceText: '普通参考。', autoRate: 1, intensity: .85 });
  t.after(async () => { await speech.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dir, profile, forms, variants, speech };
}

test('only standalone crying syllables become one internal event per run', () => {
  for (const [before, after] of [
    [SPOKEN, MODEL], ['呜呜呜……别笑我。', '[sob]别笑我。'],
    ['我还在。呜，呜……别走。呜呜！', '我还在。[sob]别走。[sob]！'],
    ['呜，呜……', '[sob]'], ['你又逗我。说好了，不许笑我的。', '你又逗我。说好了，不许笑我的。'],
    ["I'm sad. 呜呜……别笑我。", "I'm sad. [sob]别笑我。"],
  ]) assert.equal(prepareVocalizedText(before, { crying: true }), after);
});
test('quoted, annotated, technical, explanatory and word-internal syllables remain literal', () => {
  for (const text of ['他说“呜，呜……”的时候，我不知道怎么办。', '她说「呜呜」。',
    '例如：呜呜。', '呜呜是一个示例。', '呜呼！这也太难了。', '我在呜咽。', '呜呜声很轻。',
    '(呜，呜……)', '[呜呜]', '【呜呜】', '`呜呜`', '{呜呜}', '“呜呜', '[呜呜',
    '“她说“呜呜”，呜呜。”', '[说明 [嵌套] 呜呜]', '{内容 {内部} 呜呜}',
    '她说“呜呜”，但我没说话。', 'word呜呜。', '呜呜word。'])
    assert.equal(prepareVocalizedText(text, { crying: true }), text);
});
test('factual and all existing literal-reading requests bypass vocalization', () => {
  assert.equal(prepareVocalizedText(SPOKEN), SPOKEN);
  assert.equal(prepareVocalizedText(SPOKEN, { crying: true, factual: true }), SPOKEN);
  for (const userText of ['逐字朗读', '按原样念', '把括号里的内容也读出来'])
    assert.equal(prepareVocalizedText(SPOKEN, { crying: true, userText }), SPOKEN);
  assert.equal(prepareVocalizedText('呜。', { crying: true, userText: '用哭腔把“呜”这个字读出来' }), '呜。');
});
test('reported sentence reaches TTS exactly like selected A, with separate public transcripts', async t => {
  const h = fixture(t);
  const result = await h.speech.synthesize({ key: KEY, text: ORIGINAL, userText: '用哭腔说一句', explicit: true });
  assert.equal(result.mode, 'voice'); assert.equal(result.text, ORIGINAL); assert.equal(result.spokenText, SPOKEN);
  assert.equal(h.forms[0].get('text'), MODEL); assert.equal(h.forms[0].get('cfg_scale'), '2');
  assert.equal(h.forms[0].get('instruction'), h.profile.instruction);
  assert.deepEqual(h.variants, ['mixed']); assert.equal(result.style.voiceProfile, 'sad');
  assert.equal(Object.hasOwn(result, 'modelText'), false);
  assert.equal(JSON.stringify(result).includes('[sob]'), false);
  assert.equal(fs.readFileSync(path.join(h.dir, 'state.json'), 'utf8').includes('[sob]'), false);
});
test('reset, other emotions, zero intensity, factual and original reading never add events', async t => {
  const h = fixture(t);
  for (const input of [
    { userText: '恢复正常，正常说' }, { userText: '笑着说' },
    { userText: '用哭腔说一句', factual: true }, { userText: '用哭腔逐字朗读' },
  ]) {
    const result = await h.speech.synthesize({ key: KEY, text: SPOKEN, explicit: true, ...input });
    assert.equal(result.mode, 'voice'); assert.equal(h.forms.at(-1).get('text'), SPOKEN);
  }
  h.speech.updateConfig({ intensity: 0 });
  await h.speech.synthesize({ key: KEY, text: SPOKEN, userText: '用哭腔说一句', explicit: true });
  assert.equal(h.forms.at(-1).get('text'), SPOKEN);
});
test('default preview follows A while named preview without event opt-in remains unchanged', async t => {
  const h = fixture(t);
  const first = await h.speech.preview({ text: ORIGINAL, userText: '用哭腔说一句' });
  assert.equal(h.forms.at(-1).get('text'), MODEL); assert.equal(first.spokenText, SPOKEN);
  const { vocalization, ...clone } = h.profile;
  fs.writeFileSync(path.join(h.dir, 'preview-profiles.json'), JSON.stringify({ clone: { ...clone, cfgScale: 0, instruction: '' } }));
  await h.speech.preview({ text: ORIGINAL, userText: '用哭腔说一句', profile: 'clone' });
  assert.equal(h.forms.at(-1).get('text'), SPOKEN);
  // Already supplied event tags are not expanded or duplicated.
  await h.speech.preview({ text: MODEL, userText: '用哭腔说一句', profile: 'clone' });
  assert.equal(h.forms.at(-1).get('text'), MODEL);
});
test('invalid event settings fail closed and public inputs cannot enable events', async t => {
  const h = fixture(t);
  for (const vocalization of [true, 'cry', '[sob]', { type: 'sob' }]) {
    fs.writeFileSync(path.join(h.dir, 'emotion-profiles.json'), JSON.stringify({ sad: { ...h.profile, vocalization } }));
    const result = await h.speech.synthesize({ key: KEY, text: SPOKEN, userText: '用哭腔说一句', explicit: true,
      vocalization: 'sob', modelText: MODEL });
    assert.equal(result.mode, 'voice'); assert.equal(h.forms.at(-1).get('text'), SPOKEN);
  }
  await assert.rejects(h.speech.preview({ text: SPOKEN, vocalization: 'sob' }), /INVALID_PREVIEW/);
});
test('successful voice receipts store readable dialogue and errors fall back to original text', async t => {
  const h = fixture(t), saved = [], sent = [];
  const delivery = createReplyDelivery({ speech: { ...h.speech, remember: (...args) => saved.push(args) },
    transport: { sendPrivate: async (_id, message) => { sent.push(message); return { ok: true, data: { message_id: 9 } }; } } });
  const result = await delivery({ key: KEY, text: ORIGINAL, userText: '用哭腔说一句', target: { userId: '12345' } });
  assert.equal(h.forms[0].get('text'), MODEL); assert.equal(result.spokenText, SPOKEN);
  assert.deepEqual(saved, [[9, SPOKEN, KEY]]); assert.equal(sent[0][0].type, 'record');
  const broken = fixture(t, { fetchImpl: async () => { throw new Error('failed'); } });
  const fallback = await broken.speech.synthesize({ key: KEY, text: ORIGINAL, userText: '用哭腔说一句' });
  assert.equal(fallback.mode, 'text'); assert.equal(fallback.text, ORIGINAL);
});
