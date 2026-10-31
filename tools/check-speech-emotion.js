import test from 'node:test';
import assert from 'node:assert/strict';
import { selectEmotion, wantsSpeech, declinesSpeech, continuesSpeech } from '../src/speech/emotion.js';

const sad = () => selectEmotion({ userText: '用哭腔说', now: 1000 });

test('a prior neutral cannot suppress emotion in current dialogue', () => {
  const previous = selectEmotion({ text: '收到。', now: 1000 });
  for (const [text, emotion] of [['太好了！好开心！', 'happy'], ['没关系，慢慢来，我陪着你。', 'gentle']]) {
    const result = selectEmotion({ text, previous, now: 2000 });
    assert.equal(result.emotion, emotion); assert.equal(result.source, 'text');
  }
});

test('current words take precedence over an inherited performance', () => {
  const result = selectEmotion({ userText: '再说一句', text: '太好了，终于成功了！', previous: sad(), now: 2000 });
  assert.equal(result.emotion, 'happy'); assert.equal(result.time, 2000);
});

test('inheritance has a fixed deadline across many related replies', () => {
  let previous = sad();
  for (const now of [101000, 201000, 301000, 401000, 501000]) {
    previous = selectEmotion({ userText: '再来一句', text: '我在这里。', previous, now });
    assert.equal(previous.emotion, 'sad'); assert.equal(previous.source, 'continuation'); assert.equal(previous.time, 1000);
  }
  assert.equal(selectEmotion({ userText: '再来一句', previous, now: 601000 }).emotion, 'neutral');
  assert.equal(selectEmotion({ previous: sad(), now: 2000 }).time, 1000);
});

test('unrelated topics, future timestamps and neutral history do not carry emotion', () => {
  for (const userText of ['今天晚饭吃什么', '来一个视频', '不要语音，只发文字'])
    assert.equal(selectEmotion({ userText, text: '好的。', previous: sad(), now: 2000 }).emotion, 'neutral');
  assert.equal(selectEmotion({ previous: sad(), now: 500 }).emotion, 'neutral');
  assert.equal(selectEmotion({ previous: { emotion: 'neutral', time: 1000 }, now: 2000 }).source, 'neutral');
});

test('negative and discussed styles do not become affirmative performance instructions', () => {
  for (const userText of ['不要笑着说，正常一点', '我不喜欢撒娇', '不是让你生气地说', '有人说“用哭腔说”是什么意思',
    '哭腔是什么', '如果让你温柔地说会怎么样', '你总是撒娇', '再来，不要撒娇']) {
    const result = selectEmotion({ userText, text: '好的。', previous: { emotion: 'playful', time: 1000 }, now: 2000 });
    assert.equal(result.emotion, 'neutral', userText); assert.notEqual(result.source, 'explicit', userText);
  }
});

test('a later affirmative correction overrides a reset, and a later reset wins', () => {
  for (const userText of ['别哭了，笑着说', '不是哭着说而是笑着说', '别生气了，用温柔的语气说']) {
    const expected = userText.includes('温柔') ? 'gentle' : 'happy';
    const result = selectEmotion({ userText, text: '好的。', previous: sad(), now: 2000 });
    assert.equal(result.emotion, expected, userText); assert.equal(result.source, 'explicit');
  }
  const reset = selectEmotion({ userText: '笑着说，别笑了', text: '太好了！', previous: sad(), now: 2000 });
  assert.equal(reset.emotion, 'neutral'); assert.equal(reset.source, 'reset');
});

test('quoted transcript words do not override the requested performance', () => {
  const result = selectEmotion({ userText: '用开心的语气说“别哭了”', text: '别哭了', now: 2000 });
  assert.equal(result.emotion, 'happy'); assert.equal(result.source, 'explicit');
});

test('all supported direct styles remain usable', () => {
  for (const [userText, emotion] of [['来句哭腔我听听', 'sad'], ['笑着说', 'happy'], ['凶一点', 'annoyed'],
    ['温柔一点', 'gentle'], ['撒娇地说', 'playful'], ['用惊讶的语气说', 'surprised']]) {
    const result = selectEmotion({ userText, now: 2000 });
    assert.equal(result.emotion, emotion, userText); assert.equal(result.source, 'explicit');
  }
});

test('clear sadness, annoyance and surprise in the actual words have a delivery', () => {
  for (const [text, emotion] of [['我有点难过，想哭。', 'sad'], ['这也太过分了，我真的生气了。', 'annoyed'],
    ['哇，居然还有这种事！', 'surprised'], ['逗你的，开个玩笑。', 'playful']])
    assert.equal(selectEmotion({ text, now: 2000 }).emotion, emotion, text);
  assert.equal(selectEmotion({ text: '我没有生气。', now: 2000 }).emotion, 'neutral');
});

test('factual answers are neutral but cannot freeze the next ordinary reply', () => {
  const factual = selectEmotion({ factual: true, userText: '用哭腔说', previous: sad(), text: '太好了！',
    direction: { emotion: 'happy', intent: 'tease', pace: 'brisk' }, now: 2000 });
  assert.equal(factual.emotion, 'neutral'); assert.equal(factual.source, 'factual'); assert.equal(factual.intensity, 0);
  assert.match(factual.instruction, /关键信息/); assert.doesNotMatch(factual.instruction, /玩笑落点|哭腔/);
  assert.equal(selectEmotion({ previous: factual, text: '太好了！', now: 3000 }).emotion, 'happy');
});

test('finite semantic direction drives mood and prosody ahead of history and simple keywords', () => {
  const result = selectEmotion({ userText: '欢迎我一下', text: '你回来了。', previous: sad(), now: 2000,
    direction: { emotion: 'happy', intent: 'welcome', pace: 'brisk', contour: 'bright_then_soft' } });
  assert.equal(result.emotion, 'happy'); assert.equal(result.source, 'semantic'); assert.equal(result.time, 2000);
  assert.match(result.instruction, /迎接/); assert.match(result.instruction, /整体轻快利落/); assert.match(result.instruction, /后半句逐渐放软/);
  const neutral = selectEmotion({ userText: '再来', previous: sad(), direction: { emotion: 'neutral' }, now: 2000 });
  assert.equal(neutral.emotion, 'neutral'); assert.equal(neutral.source, 'semantic');
});

test('explicit mood and reset override conflicting semantic direction', () => {
  const direction = { emotion: 'happy', intent: 'tease', pace: 'brisk', contour: 'bright_then_soft' };
  const explicit = selectEmotion({ userText: '用哭腔说', direction, now: 2000 });
  assert.equal(explicit.emotion, 'sad'); assert.equal(explicit.source, 'explicit'); assert.doesNotMatch(explicit.instruction, /玩笑落点/);
  assert.equal(selectEmotion({ userText: '正常说', direction, now: 2000 }).source, 'reset');
});

test('invalid directions fail soft and arbitrary text never enters instructions', () => {
  for (const direction of [null, [], 'INJECT', { emotion: 'INJECT' }, { instruction: 'INJECT' }]) {
    const result = selectEmotion({ text: '太好了！', direction });
    assert.equal(result.emotion, 'happy'); assert.equal(result.source, 'text'); assert.ok(!result.instruction.includes('INJECT'));
  }
  const result = selectEmotion({ direction: { emotion: 'gentle', intent: 'INJECT', pace: 'INJECT', contour: 'INJECT', instruction: 'INJECT' } });
  assert.equal(result.emotion, 'gentle'); assert.equal(result.source, 'semantic'); assert.ok(!result.instruction.includes('INJECT'));
  assert.match(result.instruction, /语速稍慢/);
});

test('explicit styles have compatible default pace and contour without semantic direction', () => {
  const crying = selectEmotion({ userText: '用哭腔说', intensity: .85 });
  assert.match(crying.instruction, /哭腔/); assert.match(crying.instruction, /语速稍慢/);
  assert.match(crying.instruction, /迟疑/); assert.doesNotMatch(crying.instruction, /气息稳定/);
  const happy = selectEmotion({ userText: '笑着说' });
  assert.match(happy.instruction, /整体轻快利落/); assert.match(happy.instruction, /后半句逐渐放软/);
  const playful = selectEmotion({ userText: '俏皮一点' });
  assert.match(playful.instruction, /玩笑落点/); assert.match(playful.instruction, /开头略扬起/);
  const gentle = selectEmotion({ userText: '温柔一点' });
  assert.match(gentle.instruction, /安慰和陪伴/); assert.match(gentle.instruction, /语速稍慢/);
});

test('stronger intensity changes concrete performance and neutral stays conversational', () => {
  for (const emotion of ['happy', 'sad', 'annoyed', 'gentle', 'playful', 'surprised']) {
    const medium = selectEmotion({ direction: { emotion }, intensity: .65 });
    const strong = selectEmotion({ direction: { emotion }, intensity: .85 });
    assert.notEqual(strong.instruction, medium.instruction, emotion);
    assert.match(strong.instruction, /重音|加重/); assert.match(strong.instruction, /短停|停顿/); assert.match(strong.instruction, /保持参考音色/);
    assert.equal(strong.intensity, .85);
  }
  const neutral = selectEmotion({ intensity: .85 });
  assert.equal(neutral.intensity, 0); assert.match(neutral.instruction, /回应感|面对面/); assert.match(neutral.instruction, /自然快慢/);
  assert.equal(selectEmotion({ direction: { emotion: 'happy' }, intensity: NaN }).intensity, .65);
  assert.equal(selectEmotion({ direction: { emotion: 'happy' }, intensity: 9 }).intensity, 1);
});

test('existing speech preference and continuation helpers remain compatible', () => {
  assert.equal(wantsSpeech('来句哭腔我听听'), true);
  assert.equal(wantsSpeech('不要发语音，只要文字'), false);
  assert.equal(declinesSpeech('只发文字'), true);
  assert.equal(continuesSpeech('再来一句'), true);
  assert.equal(continuesSpeech('再来一个视频'), false);
});
