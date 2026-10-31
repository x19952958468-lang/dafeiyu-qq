import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSpeechText } from '../src/speech/spoken-text.js';

test('removes the reported delivery note while preserving all dialogue, cries and punctuation', () => {
  const text = '不就是哭两声嘛，我哭就是了……（声音抖着，鼻音很浓）呜，呜……听到了没有，满意了吗？';
  assert.deepEqual(prepareSpeechText(text), {
    spokenText: '不就是哭两声嘛，我哭就是了……呜，呜……听到了没有，满意了吗？',
    stageDirections: ['声音抖着，鼻音很浓'], emotionHint: 'sad',
  });
});

test('recognizes voice and action notes across supported bracket styles', () => {
  for (const [text, spokenText, emotionHint] of [
    ['（轻笑）你好', '你好', 'playful'], ['(抹眼泪)我在', '我在', 'sad'],
    ['【语气温柔】慢慢来。', '慢慢来。', 'gentle'], ['（声音很开心）你来啦。', '你来啦。', 'happy'],
    ['（气鼓鼓）这次不行。', '这次不行。', 'annoyed'], ['（瞪大眼睛）真的吗？', '真的吗？', 'surprised'],
    ['（语气平静）我们继续。', '我们继续。', 'neutral'], ['(sigh)All right.', 'All right.', null],
    ['（声音微微颤抖着、鼻音很重）我在。', '我在。', 'sad'], ['（轻轻地笑）你好。', '你好。', 'happy'],
  ]) {
    const result = prepareSpeechText(text);
    assert.equal(result.spokenText, spokenText, text);
    assert.equal(result.emotionHint, emotionHint, text);
    assert.equal(result.stageDirections.length, 1);
  }
});

test('balanced nested and consecutive notes are removed as complete units', () => {
  assert.deepEqual(prepareSpeechText('（抹眼泪（声音发抖））【吸鼻子】我在。'), {
    spokenText: '我在。', stageDirections: ['抹眼泪（声音发抖）', '吸鼻子'], emotionHint: 'sad',
  });
  assert.deepEqual(prepareSpeechText('(轻笑)（点头）你好。（语气温柔）请坐。'), {
    spokenText: '你好。请坐。', stageDirections: ['轻笑', '点头', '语气温柔'], emotionHint: 'gentle',
  });
});

test('real compound voice receipts and compositional action notes never become spoken dialogue', () => {
  for (const note of [
    '第二下扇得头更偏，睫毛颤了颤才抬眼看你',
    '缩了一下，声音还带着哭腔又有点不服气',
    '被扇得偏过脸，眼眶立刻红了',
    '抿了抿嘴，视线落到一旁',
    '肩膀缩了缩，慢慢抬起头',
    '声音还带着笑意，尾音轻轻扬起来',
    '委屈巴巴地低下头，手指攥紧衣角',
    '先抬起头看你，又慢慢别过脸',
    '睫毛颤了颤（声音还带着哭腔）',
  ]) {
    const result = prepareSpeechText(`（${note}）我听见了，你慢慢说。`);
    assert.equal(result.spokenText, '我听见了，你慢慢说。', note);
    assert.deepEqual(result.stageDirections, [note]);
  }
});

test('compositional recognition keeps mixed clauses, explanations, facts and quoted narration', () => {
  for (const note of ['轻笑，另外一件事', '声音有点发抖，但明天来', '看了一眼文档，版本2',
    '眼睛是视觉器官', '缩小图片', '头部参数', '眼睛红了可能是过敏', '声音发抖的原因需要检查',
    '转头是一个动作', '声音轻轻变低是实验结果', '肩膀缩了缩，你听见了吗',
    '视线移开意味着拒绝', '声音设置降低了', '音轨声音压低', '笑着说，另外一件事',
    '点了两杯咖啡', '抬了价格', '抽了一个样本', '握着一个预约号',
    '镜头转场很流畅', '码头靠岸的船很多', '抬头纹比较明显', '点头之交',
    '电影用了哭腔', '哭腔测试通过', '笑意是她的网名', '尾音提高了半音']) {
    const text = `（${note}）我听见了。`;
    assert.equal(prepareSpeechText(text).spokenText, text, note);
  }
  const quoted = '她写的是“（抿了抿嘴，视线落到一旁）”。';
  assert.equal(prepareSpeechText(quoted).spokenText, quoted);
  const text = '（缩了一下，声音还带着哭腔又有点不服气）我听见了。';
  assert.equal(prepareSpeechText(text, { factual: true }).spokenText, text);
  assert.equal(prepareSpeechText(text, { userText: '逐字读出来，包括括号' }).spokenText, text);
});

test('common stage phrasing variants are recognized only when every clause is a performance note', () => {
  for (const [note, emotionHint] of [
    ['吸吸鼻子，声音带着哭腔', 'sad'],
    ['声音有点发抖，尾音都软了', 'sad'],
    ['笑着说', 'happy'],
    ['压低声音，凑近一点', null],
  ]) {
    assert.deepEqual(prepareSpeechText(`（${note}）你好，听见了吗？`), {
      spokenText: '你好，听见了吗？', stageDirections: [note], emotionHint,
    });
  }
  for (const note of ['吸吸鼻子，明天上午十点', '压低声音，距麦克风10厘米',
    '笑着说，声音发抖是一种表现', '压低声音，参数gain=0.8', '凑近一点，引用“轻笑”',
    '声音有点发抖，尾音参数见说明', '笑着说，另外一件事', '下午一点', '一点', '一点半']) {
    const text = `（${note}）你好。`;
    const result = prepareSpeechText(text);
    assert.equal(result.spokenText, text); assert.deepEqual(result.stageDirections, []); assert.equal(result.emotionHint, null);
    if (!['下午一点', '一点', '一点半'].includes(note)) assert.equal(result.unsafeForVoice, true, note);
  }
});

test('unknown or malformed brackets remain intact instead of being guessed', () => {
  for (const text of ['（未知说明）你好', '（轻笑，待补充内容）你好', '（轻笑你好', '（轻笑)你好',
    '（备注（轻笑）是例子）你好', '你好（这是我真正要说的话）', '（轻笑，亲爱的）你好']) {
    const result = prepareSpeechText(text);
    assert.equal(result.spokenText, text); assert.deepEqual(result.stageDirections, []); assert.equal(result.emotionHint, null);
    if (!text.startsWith('（备注')) assert.equal(result.unsafeForVoice, true, text);
  }
});

test('factual comments, dates, quantities, aliases, technical details and explanations are not stage notes', () => {
  for (const text of ['（明天上午十点）别删', '约在（10:30）见面', '这是哭腔（声音发抖是一种表现）',
    '哭腔（例如声音发抖）是个例子', '声音参数（gain=0.8）', '请看【接口参数】',
    '昵称（又称小鱼）', '温度（摄氏二十度）', '说明（轻笑）这个词的意思', '例如：（轻笑）',
    '括号（声音发抖是指声带变化）也要留下']) {
    assert.deepEqual(prepareSpeechText(text), { spokenText: text, stageDirections: [], emotionHint: null }, text);
  }
});

test('quoted examples stay literal, including escaped quotes and English contractions', () => {
  for (const text of ['“（轻笑）”是舞台说明。', '原文是「(抹眼泪)我在」。', '他说：【示例】“（声音抖着）”',
    '"Example: \\"(laugh)\\""', "'（轻笑）' is a note."]) {
    assert.equal(prepareSpeechText(text).spokenText, text);
  }
  assert.equal(prepareSpeechText("It's fine. (sigh) Really.").spokenText, "It's fine.  Really.");
});

test('factual responses and explicit literal reading bypass stage extraction', () => {
  const text = '（轻笑）你好（声音发抖）。';
  assert.deepEqual(prepareSpeechText(text, { factual: true }), { spokenText: text, stageDirections: [], emotionHint: null });
  for (const userText of ['括号里的也读出来', '读括号里的也要读', '连括号里面的内容都念出来',
    '不要省略括号里的内容', '请读括号里的说明', '把括号里的内容念出来', '把这段原样朗读', '逐字读给我听']) {
    assert.deepEqual(prepareSpeechText(text, { userText }), { spokenText: text, stageDirections: [], emotionHint: null }, userText);
  }
  for (const userText of ['不要读括号里的内容', '不要把括号里的也读出来', '别念括号', '不要原样读，省略动作说明',
    '为什么把括号里的也读出来了', '括号里的内容你怎么又读了']) {
    assert.equal(prepareSpeechText(text, { userText }).spokenText, '你好。', userText);
  }
});

test('notes-only input returns no invented dialogue, and external whitespace is otherwise unchanged', () => {
  assert.deepEqual(prepareSpeechText(' （抹眼泪）【声音发抖】 '), {
    spokenText: '', stageDirections: ['抹眼泪', '声音发抖'], emotionHint: 'sad',
  });
  assert.equal(prepareSpeechText(' 你好 （轻笑） 再见。 ').spokenText, ' 你好  再见。 ');
  assert.deepEqual(prepareSpeechText(''), { spokenText: '', stageDirections: [], emotionHint: null });
});

test('ordinary dialogue outside parentheses is never treated as a stage instruction', () => {
  const text = '我想哭，声音有点发抖，你听见了吗？呜……';
  assert.deepEqual(prepareSpeechText(text), { spokenText: text, stageDirections: [], emotionHint: null });
  assert.equal(prepareSpeechText('解释（这是一个示例）。（轻笑）继续。').spokenText, '解释（这是一个示例）。继续。');
});

test('the helper is deterministic, does not mutate options, and rejects non-text input', () => {
  const options = Object.freeze({ factual: false, userText: '说给我听' });
  const text = '（抹眼泪）我在。';
  assert.deepEqual(prepareSpeechText(text, options), prepareSpeechText(text, options));
  assert.deepEqual(options, { factual: false, userText: '说给我听' });
  for (const text of [null, undefined, 1, {}]) assert.throws(() => prepareSpeechText(text), { message: 'INVALID_TEXT' });
});
