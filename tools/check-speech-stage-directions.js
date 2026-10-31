import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReplyDelivery } from '../src/speech/index.js';
import { createSpeech } from './helpers/speech-fixture.js';

const ORIGINAL = '不就是哭两声嘛，我哭就是了……（声音抖着，鼻音很浓）呜，呜……听到了没有，满意了吗？';
const SPOKEN = '不就是哭两声嘛，我哭就是了……呜，呜……听到了没有，满意了吗？';
const KEY = 'p:12345';
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-stage-'));
  const ref = path.join(root, 'reference.wav'); fs.writeFileSync(ref, 'reference');
  const forms = [], directions = [], lifecycle = [];
  const pcm = Buffer.alloc(4800); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(i % 4 ? 1500 : -1500, i);
  const speech = createSpeech({ rootDir: root, random: () => 0,
    llm: { directSpeech: async input => { directions.push(input); return {}; } },
    acquireHeavy: async () => { lifecycle.push('acquire'); return async () => lifecycle.push('release'); },
    ensureBackendReady: async () => { lifecycle.push('start'); }, stopBackend: async () => { lifecycle.push('stop'); },
    fetchImpl: async (_url, { body }) => { forms.push(body); return new Response(pcm); },
    runImpl: async (_command, args) => fs.writeFileSync(args.at(-1), Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200)])),
    ...overrides });
  speech.updateConfig({ referenceAudio: ref, referenceText: '参考台词。', intensity: .85, autoRate: 1 });
  fs.writeFileSync(path.join(root, 'data/speech/emotion-profiles.json'), JSON.stringify({ sad: {
    referenceAudio: ref, referenceText: '哭腔参考。', cfgScale: 0, instruction: '',
  } }));
  t.after(async () => { await speech.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, speech, forms, directions, lifecycle };
}

test('the reported sentence sends only dialogue to TTS and uses the stage cue for crying B', async t => {
  const h = fixture(t);
  const result = await h.speech.synthesize({ key: KEY, text: ORIGINAL, explicit: true });
  assert.equal(result.mode, 'voice'); assert.equal(result.text, ORIGINAL); assert.equal(result.spokenText, SPOKEN);
  assert.equal(h.forms[0].get('text'), SPOKEN); assert.equal(h.forms[0].get('cfg_scale'), '0');
  assert.equal(result.style.emotion, 'sad'); assert.equal(result.style.voiceProfile, 'sad');
  assert.equal(h.directions.length, 0);
});
test('compound stage narration is absent from backend input, response and sent voice receipt', async t => {
  const h = fixture(t), text = '（第二下扇得头更偏，睫毛颤了颤才抬眼看你）我听见了，你慢慢说。';
  const spoken = '我听见了，你慢慢说。';
  const result = await h.speech.synthesize({ key: KEY, text, userText: '说给我听', explicit: true });
  assert.equal(result.mode, 'voice'); assert.equal(h.forms[0].get('text'), spoken);
  assert.equal(result.spokenText, spoken); assert.equal(result.text, text);
  const saved = [];
  const deliver = createReplyDelivery({ speech: { ...h.speech, remember: (...args) => saved.push(args) },
    transport: { sendPrivate: async () => ({ ok: true, data: { message_id: 7 } }) } });
  const receipt = await deliver({ key: KEY, text, userText: '说给我听', explicit: true, target: { userId: '12345' } });
  assert.equal(receipt.spokenText, spoken); assert.deepEqual(saved, [[7, spoken, KEY]]);
  assert.equal(h.forms.at(-1).get('text'), spoken);
});
test('latest actual middle-of-sentence note is omitted as a whole, including previously unknown clauses', async t => {
  const h = fixture(t);
  const text = '我听见了。（小声地吸气，偷偷抬眼看他，声音有点抖）你慢慢说。';
  const result = await h.speech.synthesize({ key: KEY, text, explicit: true });
  assert.equal(result.mode, 'voice'); assert.equal(result.text, text);
  assert.equal(result.spokenText, '我听见了。你慢慢说。');
  assert.equal(h.forms[0].get('text'), result.spokenText); assert.equal(result.style.emotion, 'sad');
});
test('unclassified, mixed and truncated parentheses cannot reach the model, even with explicit voice requests', async t => {
  const h = fixture(t);
  for (const note of ['全新的动作措辞', '踮起脚尖躲在门后', '停了3秒，声音发抖', '像在解释一样低声说',
    '轻笑，明天上午十点', '声音轻轻，参数gain=0.8', '轻笑，另外一件事',
    '参考刚才的语气，悄悄说', '版本2，偷偷抬眼看他', '备注：声音小得像蚊子']) {
    const text = `（${note}）我听见了。`;
    const result = await h.speech.synthesize({ key: KEY, text, explicit: true });
    assert.equal(result.mode, 'text', note); assert.equal(result.text, text);
    assert.equal(result.reason, 'UNCERTAIN_SPOKEN_TEXT');
  }
  for (const text of ['（轻笑，我听见了', '轻笑）我听见了', '（声音抖着)我听见了',
    '[全新的动作措辞]我听见了', '[状态未闭合', '状态末尾]你好。']) {
    const result = await h.speech.synthesize({ key: KEY, text, explicit: true });
    assert.equal(result.mode, 'text'); assert.equal(result.text, text);
  }
  assert.deepEqual(h.forms, []); assert.deepEqual(h.lifecycle, []); assert.deepEqual(h.directions, []);
});
test('square-bracket narration cannot be read and the selected sob event remains available', async t => {
  const h = fixture(t);
  const text = '[小声地吸气，偷偷抬眼看他]我听见了。';
  const result = await h.speech.synthesize({ key: KEY, text, explicit: true });
  assert.equal(result.mode, 'voice'); assert.equal(h.forms.at(-1).get('text'), '我听见了。');
  await h.speech.synthesize({ key: KEY, text: '我听见了。[sob]你慢慢说。', explicit: true });
  assert.equal(h.forms.at(-1).get('text'), '我听见了。[sob]你慢慢说。');
});
test('delivery refuses uncertain audio before synthesis and preserves the original message', async () => {
  const sent = [], saved = []; let calls = 0;
  const text = '你好。（全新的动作措辞）继续聊吧。';
  const deliver = createReplyDelivery({ speech: {
    synthesize: async () => { calls++; return { mode: 'voice', audio: Buffer.from('fake') }; },
    remember: (...args) => saved.push(args),
  }, transport: { sendPrivate: async (_id, message) => { sent.push(message); return { ok: true, data: { message_id: 8 } }; } } });
  const result = await deliver({ key: KEY, text, explicit: true, target: { userId: '12345' } });
  assert.equal(calls, 0); assert.equal(result.mode, 'text'); assert.equal(result.text, text);
  assert.deepEqual(sent, [[{ type: 'text', data: { text } }]]); assert.deepEqual(saved, []);
});
test('confirmed literal supplements still speak and explicit original reading can read unknown parentheses', async t => {
  const h = fixture(t);
  for (const [text, userText] of [['明天（周六）上午十点见。', ''], ['结果是（2 + 3）乘以4。', ''],
    ['设置（gain=0.8）已经更新。', ''], ['正文（第二版）已更新。', ''],
    ['她写的是“（陌生动作）”。', ''], ['（陌生动作）你好。', '逐字原样读出来']]) {
    const result = await h.speech.synthesize({ key: KEY, text, userText, explicit: true });
    assert.equal(result.mode, 'voice', text); assert.equal(h.forms.at(-1).get('text'), text);
  }
});
test('explicit reset and factual/literal-reading requests still take precedence over stage cues', async t => {
  const h = fixture(t);
  const reset = await h.speech.synthesize({ key: KEY, text: ORIGINAL, userText: '恢复正常，正常说', explicit: true });
  assert.equal(reset.style.emotion, 'neutral'); assert.equal(h.forms.at(-1).get('text'), SPOKEN);
  const facts = await h.speech.synthesize({ key: KEY, text: ORIGINAL, factual: true, explicit: true });
  assert.equal(facts.style.emotion, 'neutral'); assert.equal(h.forms.at(-1).get('text'), ORIGINAL);
  await h.speech.synthesize({ key: KEY, text: ORIGINAL, userText: '把括号里的内容也读出来', explicit: true });
  assert.equal(h.forms.at(-1).get('text'), ORIGINAL);
});
test('text mode, synthesis failures and stage-only utterances retain original text', async t => {
  const h = fixture(t), text = '（声音抖着，鼻音很浓）';
  assert.equal((await h.speech.synthesize({ key: KEY, text, explicit: true })).reason, 'NO_SPOKEN_TEXT');
  assert.deepEqual(h.lifecycle, []);
  h.speech.updateConfig({ mode: 'text' });
  assert.deepEqual(await h.speech.synthesize({ key: KEY, text: ORIGINAL }), { mode: 'text', text: ORIGINAL, reason: 'DISABLED' });
  const broken = fixture(t, { fetchImpl: async () => { throw new Error('backend failed'); } });
  const result = await broken.speech.synthesize({ key: KEY, text: ORIGINAL, explicit: true });
  assert.equal(result.mode, 'text'); assert.equal(result.text, ORIGINAL);
});
test('ordinary parentheses survive and original links still block audio before cleaning', async t => {
  const h = fixture(t), text = '明天（周六）上午十点见。';
  await h.speech.synthesize({ key: KEY, text, explicit: true });
  assert.equal(h.forms[0].get('text'), text);
  const count = h.forms.length;
  assert.equal((await h.speech.synthesize({ key: KEY, text: '（轻笑，https://example.test）你好。', explicit: true })).reason, 'TEXT_REQUIRED');
  assert.equal(h.forms.length, count);
});
test('voice receipts derive clean transcripts from caller text and never trust rendered text fields', async () => {
  const saved = [], sends = [];
  const deliver = createReplyDelivery({ speech: {
    synthesize: async () => ({ mode: 'voice', audio: Buffer.from('fake'), text: '伪造原文', spokenText: '伪造台词' }),
    remember: (...args) => saved.push(args),
  }, transport: { sendPrivate: async (_id, message) => { sends.push(message); return { ok: true, data: { message_id: 1 } }; } } });
  const result = await deliver({ key: KEY, text: ORIGINAL, target: { userId: '12345' } });
  assert.equal(result.text, ORIGINAL); assert.equal(result.spokenText, SPOKEN);
  assert.deepEqual(saved, [[1, SPOKEN, KEY]]); assert.equal(sends[0][0].type, 'record');
});
test('text fallback and failed voice sends never store a cleaned transcript as a successful send', async () => {
  for (const voice of [false, true]) {
    const sends = [], saved = [];
    const deliver = createReplyDelivery({ speech: {
      synthesize: async () => voice ? { mode: 'voice', audio: Buffer.from('fake') } : { mode: 'text', text: 'bad' },
      remember: (...args) => saved.push(args),
    }, transport: { sendPrivate: async (_id, message) => { sends.push(message); return { ok: !voice }; } } });
    const result = await deliver({ key: KEY, text: ORIGINAL, target: { userId: '12345' } });
    assert.equal(result.text, ORIGINAL); assert.equal(sends.length, 1);
    if (!voice) assert.equal(sends[0][0].data.text, ORIGINAL);
    assert.deepEqual(saved, []);
  }
});
