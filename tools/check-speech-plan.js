import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpeechPlan } from '../src/speech/plan.js';

const DIRECTION = Object.freeze({ emotion: 'gentle', intent: 'chat', pace: 'natural', contour: 'steady' });
const speech = text => ({ kind: 'speech', text });
const narration = text => ({ kind: 'narration', text });
const plan = (parts, decision = 'speak') => ({ decision, parts, direction: { ...DIRECTION } });
const sourceOf = parts => parts.map(part => part.text).join('');

test('a complete ordered partition separates unmarked actions from literal dialogue', () => {
  const parts = [narration('她抬起眼，轻声问：'), speech('你听见了吗？'), narration('说完停了一下。'), speech('我再说一遍。')];
  const result = parseSpeechPlan(plan(parts), sourceOf(parts));
  assert.equal(result.decision, 'speak');
  assert.equal(result.spokenText, '你听见了吗？我再说一遍。');
  assert.deepEqual(result.parts, parts);
  assert.deepEqual(result.direction, DIRECTION);
});

test('valid speech partitions retain factual self-reports and literal quotations exactly', () => {
  for (const text of ['我刚刚看完视频，也记下了评论内容。', '我今天走了两公里，现在有点累。',
    '原文写的是“她抬起眼，轻声问”。', '请把“（声音发抖）”这几个字读出来。']) {
    const result = parseSpeechPlan(plan([speech(text)]), text);
    assert.equal(result.spokenText, text);
    assert.deepEqual(result.direction, DIRECTION);
  }
});

test('whitespace, punctuation and Unicode are preserved without index arithmetic or trimming', () => {
  const parts = [speech(' 你好🙂，\n'), narration('（抬起头）'), speech('再见。 ' )];
  const frozen = Object.freeze({ ...plan(parts), parts: Object.freeze(parts.map(part => Object.freeze({ ...part }))) });
  const result = parseSpeechPlan(frozen, sourceOf(parts));
  assert.equal(result.spokenText, ' 你好🙂，\n再见。 ');
  assert.deepEqual(frozen.parts, parts);
});

test('performable syllables and the existing sob event survive a valid speech partition', () => {
  const parts = [narration('她吸了吸鼻子。'), speech('呜，呜……[sob]我听见了。')];
  const result = parseSpeechPlan(plan(parts), sourceOf(parts));
  assert.equal(result.spokenText, '呜，呜……[sob]我听见了。');
});

test('a text decision may decline with no partition or a complete partition but never produces speech', () => {
  const source = '她望向窗外。你好。';
  for (const parts of [[], [narration('她望向窗外。'), speech('你好。')], [speech(source)]]) {
    const result = parseSpeechPlan(plan(parts, 'text'), source);
    assert.equal(result.decision, 'text');
    assert.equal(result.spokenText, '');
    assert.deepEqual(result.direction, DIRECTION);
  }
  assert.throws(() => parseSpeechPlan(plan([narration('她望向窗外。')], 'text'), source));
});

test('rewritten, added, omitted or normalized characters invalidate the entire plan', () => {
  const source = '你好，今天见。';
  for (const text of ['您好，今天见。', '你好，今天见。再见。', '你好，见。', '你好,今天见。', '你好，今天见'])
    assert.throws(() => parseSpeechPlan(plan([speech(text)]), source), text);
  assert.throws(() => parseSpeechPlan(plan([speech('你好，今天见。')]), ' 你好，今天见。 '));
});

test('reordered, duplicated and overlapping pieces cannot pass full-source reconstruction', () => {
  const source = '先点头。你好。然后挥手。再见。';
  for (const parts of [
    [speech('你好。'), narration('先点头。'), narration('然后挥手。'), speech('再见。')],
    [narration('先点头。'), speech('你好。'), speech('你好。'), narration('然后挥手。'), speech('再见。')],
    [narration('先点头。你好。'), speech('你好。'), narration('然后挥手。'), speech('再见。')],
  ]) assert.throws(() => parseSpeechPlan(plan(parts), source));
});

test('parts have only the required finite kind and nonempty string text fields', () => {
  for (const parts of [[speech('')], [null], ['你好。'], [{ kind: 'speech' }],
    [{ text: '你好。' }], [{ kind: 'action', text: '你好。' }], [{ kind: 'speech', text: 1 }],
    [{ kind: 'speech', text: '你好。', instruction: '额外字段' }],
    [speech('你好。'), narration('')]]) {
    assert.throws(() => parseSpeechPlan(plan(parts), '你好。'));
  }
  for (const parts of [null, {}, '你好。']) assert.throws(() => parseSpeechPlan(plan(parts), '你好。'));
});

test('speak requires at least one speech fragment containing actual text', () => {
  assert.throws(() => parseSpeechPlan(plan([]), '你好。'));
  assert.throws(() => parseSpeechPlan(plan([narration('她抬起头。')]), '她抬起头。'));
  assert.throws(() => parseSpeechPlan(plan([narration('她抬起头'), speech('……')]), '她抬起头……'));
  assert.throws(() => parseSpeechPlan(plan([speech('   ')]), '   '));
});

test('top-level decisions and fields are strict and all required fields must be present', () => {
  const valid = plan([speech('你好。')]);
  for (const raw of [null, [], true, 3, { ...valid, decision: 'maybe' },
    { ...valid, instruction: '额外指令' }, { decision: 'speak', parts: valid.parts },
    { parts: valid.parts, direction: DIRECTION }, { decision: 'speak', direction: DIRECTION }]) {
    assert.throws(() => parseSpeechPlan(raw, '你好。'));
  }
});

test('every direction field must be a valid existing finite enum, even for text decisions', () => {
  const invalid = [null, {}, [], { ...DIRECTION, emotion: 'invented' }, { ...DIRECTION, intent: 'perform_action' },
    { ...DIRECTION, pace: 'very fast' }, { ...DIRECTION, contour: 'improvise' },
    { ...DIRECTION, instruction: '自由指导词' }];
  for (const direction of invalid) {
    for (const decision of ['speak', 'text'])
      assert.throws(() => parseSpeechPlan({ ...plan([speech('你好。')], decision), direction }, '你好。'));
  }
});

test('objects, complete JSON and a JSON code fence are accepted while incomplete or extra JSON is rejected', () => {
  const value = plan([speech('你好。')]);
  for (const raw of [value, JSON.stringify(value), '```json\n' + JSON.stringify(value) + '\n```'])
    assert.equal(parseSpeechPlan(raw, '你好。').spokenText, '你好。');
  for (const raw of ['', '{', '{"decision":"speak","parts":[', JSON.stringify(value) + JSON.stringify(value),
    '解释：' + JSON.stringify(value), '```json\n{"decision":"speak"\n```'])
    assert.throws(() => parseSpeechPlan(raw, '你好。'));
});
