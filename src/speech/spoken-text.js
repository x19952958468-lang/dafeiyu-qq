const BRACKETS = new Map([['（', '）'], ['(', ')'], ['【', '】'], ['[', ']']]);
const CLOSERS = new Set(BRACKETS.values());
const QUOTES = new Map([['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['"', '"'], ["'", "'"]]);
const EXPLANATION = /例如|比如|示例|举例|例子|是指|是一种|是个|意味着|意思是|也叫|又称|别名|简称|即为|也就是|定义|术语|注释|备注|注[：:]|参考|见第|参见|版本|参数|函数|接口|变量|单位|公式|代码|表现形式/;
const TIME_OR_NUMBER = /[0-9]|今天|明天|后天|昨天|上午|下午|晚上|星期|周[一二三四五六日天]|[一二三四五六七八九十百千万两〇零]+(?:年|月|日|号|点|分|秒|时|岁|克|米)/;

// Each complete clause must describe a recognizable performance. A matching word
// inside a definition or mixed dialogue is not enough to delete the parentheses.
const STAGE_CLAUSES = [
  /^(?:(?:轻轻|轻声|微微|偷偷|忍不住|低声|小声|开心|带笑)地?)?(?:轻笑|偷笑|浅笑|苦笑|傻笑|大笑|咯咯笑|笑|哽咽|啜泣|抽泣|抽噎|哭泣|哭|叹气|吸气|深呼吸|清嗓子|咳嗽)(?:了一下|出声|起来|着|两声|一声|一下|一会儿|着说)?$/,
  /^(?:声音|声线|嗓音|语气|语调|声调|尾音|鼻音|哭腔|笑意|气息|呼吸|音量|声量)(?:里|中)?(?:带着|带|变得|变|有些|有点|微微|略微|稍微|很|更|都|十分|明显|突然|渐渐|慢慢|显得|透着|充满|压得|转为)?(?:发抖|颤抖|抖着|微颤|哽咽|沙哑|低哑|嘶哑|浓重|浓|重|轻|软|轻柔|柔和|温柔|柔软|委屈|哭腔|哀伤|伤心|颤音|笑意|开心|欢快|兴奋|不满|恼怒|生气|愤怒|急促|惊讶|吃惊|惊喜|平静|低沉|低落|发颤|放轻|放软|压低|提高|抬高|变轻|变软|变小|变大)(?:着|了|起来|下来|一些|一点)?$/,
  /^(?:带着|带|含着|含|透着|压着|忍着|强忍着)(?:一点|些许|明显|轻微|浓重)?的?(?:哭腔|鼻音|笑意|泪意|眼泪|哽咽|委屈|怒气|笑)(?:说|说着|开口)?$/,
  /^(?:用|以)(?:温柔|轻柔|开心|委屈|伤心|生气|俏皮|调皮|撒娇|惊讶|平静)(?:的语气|语气|的声音)(?:说|说话|开口)?$/,
  /^(?:轻轻|慢慢|缓缓|悄悄|偷偷|微微|用力|伸手|抬手)?(?:抹(?:去|掉)?眼泪|擦(?:去|掉)?眼泪|擦泪|揉眼睛|吸(?:吸)?鼻子|抿嘴|咬唇|咬牙|垂眸|低头|抬头|侧头|歪头|点头|摇头|眨眼|眨眨眼|皱眉|叹气|深呼吸|清嗓子|握拳|鼓起腮帮|鼓腮|撇嘴|噘嘴|攥紧拳头|低下头|抬起头|别过脸|抬起眼|看着你|瞪大眼睛)(?:着|了一下|一下)?$/,
  /^(?:轻轻|慢慢|稍微)?(?:压低|放低|放轻|放软|提高|抬高)(?:声音|嗓音|音量|声调|语调)(?:一点|一些)?$/,
  /^(?:轻轻|慢慢|悄悄|稍微)?(?:凑近|靠近)(?:一点|一些)?$/,
  /^(?:眼眶|眼角|眼睛)(?:有些|微微|渐渐|略微)?(?:泛红|湿润|含泪|发红|红了)$/,
  /^(?:有些|微微|一脸|满脸|神情|显得|表情)?(?:委屈|伤心|难过|无奈|害羞|开心|惊讶|吃惊|生气|气鼓鼓|愤怒|紧张)$/,
  /^(?:laughs?|chuckles?|giggles?|sighs?|sobs?|crying|clears? throat|whispers?)$/i,
];

// Natural narration composes movements and delivery cues instead of repeating
// fixed phrases. Keep the outer factual/literal guards and require evidence in
// every clause; a single known action cannot erase unrelated parenthetical text.
const NARRATION_NON_STAGE = /[？?：:=]|是什么意思|怎么(?:读|念|写|解释)|(?:是|属于)(?:一种|一个|一类|视觉|听觉|她的|他的|我的|你的)|因为|所以|原因|导致|可能|假如|如果|是否|表示|意味着|用于|需要|应该|必须|能够|可以|诊断|症状|过敏|病因|治疗|声带|器官|肌肉|医学|报告|数据|结果|实验|测试|网名|文档|文件|图片|视频|系统|设备|设置|频率|分贝|赫兹|半音|音轨|声道/;
const VOICE_SUBJECT = /声音|声线|嗓音|语气|语调|声调|尾音|鼻音|哭腔|笑意|气息|呼吸|音量|声量/;
const VOICE_DELIVERY = /哭腔|笑意|哽咽|浓|重|发抖|颤|沙哑|嘶哑|低哑|委屈|不服气|伤心|难过|哀伤|低落|生气|恼怒|愤怒|不满|开心|欢快|兴奋|温柔|轻柔|柔软|放软|放轻|压低|提高|抬高|急促|惊讶|吃惊|平静|低沉|扬起|软下来|撒娇|调皮|俏皮|害羞|迟疑|犹豫|拉长|拖长|放慢|加快|柔和/;
const BODY_PART = /睫毛|眼眶|眼角|眼睛|眼神|视线|目光|眼皮|眉毛|眉头|肩膀|肩头|嘴角|嘴唇|唇角|下唇|手指|指尖|掌心|脸颊|脸色|脑袋|额头|下巴|身子|身体|膝盖|脚尖|衣角|头|脸/;
const BODY_MOVEMENT = /颤|抖|泛红|红了|发红|湿润|含泪|眨|抬|垂|低下|偏|转|别过|歪|摇|点|揉|擦|抹|攥|握|缩|蜷|捂|挡|靠|凑|抿|撇|咬|扬|勾|落到|移开|挪开|躲开|避开|闭上|睁开|瞪|皱/;
const PHYSICAL_ACTION = /(?:抿|撇|咬)(?:了|着|住|紧|一|两|下|抿|撇|咬)*(?:嘴|唇)|吸(?:了|着|吸|一|两|下)*(?:鼻子|气)|哽咽|抽泣|抽噎|叹(?:了)?(?:口|一口|一声)?气|低下头|垂下眼|抬起头|抬眼看|看着你|看向你|别过脸|偏过脸|扭过头|忍(?:着|住)(?:眼泪|哭|笑)/;
const REACTION = /^(?:(?:轻轻|微微|慢慢|稍微|突然|不由|不自觉|下意识|忍不住|怯怯|小心)(?:地)?)*(?:(?:缩|颤|抖|躲|愣|僵)(?:了[缩颤抖躲愣僵]|了[一两]?下|着|住了|了一下)|一(?:缩|颤|抖|愣|僵))$/;
const NARRATIVE_PREFIX = '(?:(?:先|又|再|才|还|然后|随即|接着|不由|不自觉|下意识|忍不住|轻轻|微微|慢慢|缓缓|稍微|突然|怯怯|小心|委屈巴巴)(?:地)?)*';
const NARRATIVE_MODIFIER = '(?:(?:里|中|还|又|仍然|带着|带上|带|有点|有些|些许|都|更|很|越发|开始|缓缓|轻轻|微微|慢慢|渐渐|明显|立刻|突然|已经|不由|下意识)(?:地)?)*';
const NARRATIVE_VOICE = new RegExp(`^${NARRATIVE_PREFIX}(?:${VOICE_SUBJECT.source})${NARRATIVE_MODIFIER}(?:${VOICE_DELIVERY.source})`);
const BODY_CHANGE = `(?:${BODY_PART.source})${NARRATIVE_MODIFIER}(?:${BODY_MOVEMENT.source})`;
const NARRATIVE_BODY = new RegExp(`^${NARRATIVE_PREFIX}${BODY_CHANGE}`);
const NARRATIVE_ACTION = new RegExp(`^${NARRATIVE_PREFIX}(?:${PHYSICAL_ACTION.source})`);
const NARRATIVE_REACTION = new RegExp(`^${NARRATIVE_PREFIX}(?:第[一二三四五六七八九十]+下)?(?:被)?(?:扇|拍|推|撞|敲|打|碰|晃|拉|拽)(?:得|到)(?:${BODY_CHANGE}|${PHYSICAL_ACTION.source})`);
function isStageClause(clause) {
  if (STAGE_CLAUSES.some(pattern => pattern.test(clause))) return true;
  if (NARRATION_NON_STAGE.test(clause)) return false;
  return NARRATIVE_VOICE.test(clause) || NARRATIVE_BODY.test(clause) ||
    NARRATIVE_ACTION.test(clause) || NARRATIVE_REACTION.test(clause) || REACTION.test(clause);
}

export function readParenthesesLiterally(userText) {
  const value = String(userText);
  if (/(?:逐字|一字不差|原样).{0,8}(?:读|念|朗读)|(?:读|念|朗读).{0,8}(?:逐字|一字不差|原样)/.test(value) &&
      !/(?:不要|别|不用).{0,3}(?:逐字|一字不差|原样)/.test(value)) return true;
  return value.split(/[，。！？；\n,.!?;]/).some(clause => {
    if (!/括号|圆括号|方括号|舞台说明|动作描写/.test(clause)) return false;
    if (/为什么|为啥|为何|怎么(?:又|还|会)|(?:读|念)(?:了|出来了)/.test(clause)) return false;
    if (/(?:别|不要|不用|不必).{0,20}(?:读|念|朗读)/.test(clause)) return false;
    return /(?:也|都|一并|连同|包括|包含|保留).*(?:读|念|朗读)|(?:读|念|朗读).*(?:也|都|一并|包括|包含)|(?:不要|别|不能|不许).*(?:省略|跳过|漏掉)|(?:读|念|朗读).{0,8}(?:括号|舞台说明|动作描写)|(?:括号|舞台说明|动作描写).{0,12}(?:读|念|朗读)/.test(clause);
  });
}

function bracketEnd(text, start) {
  const stack = [];
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (BRACKETS.has(char)) stack.push(BRACKETS.get(char));
    else if (CLOSERS.has(char)) {
      if (stack.pop() !== char) return -1;
      if (!stack.length) return index;
    }
  }
  return -1;
}

function quotedEnd(text, start) {
  const quote = text[start], closer = QUOTES.get(quote);
  if (quote === "'" && /[\p{Letter}\p{Number}]/u.test(text[start - 1] || '')) return -1;
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === closer) return index;
  }
  return -1;
}

function stageClauses(content, before, after) {
  // “凑近一点/声音放轻一点” uses 一点 as degree, not a clock time.
  // The full-clause allowlist below still rejects a bare “一点” or other time note.
  if (!content.trim() || content.length > 240 || EXPLANATION.test(content) || TIME_OR_NUMBER.test(content.replace(/一点/g, '')) ||
      /[“”‘’「」『』"']/.test(content)) return null;
  if (/(?:例如|比如|示例|例子|术语|写法|说明|解释|称作|叫作|词语|引用|原文)[是为：:\s]*$/.test(before.slice(-24)) ||
      /^\s*(?:这个词|一词|这个写法|这几个字|这个例子)/.test(after)) return null;
  const flat = content.replace(/[（(【\[]/g, '，').replace(/[）)】\]]/g, '，');
  const clauses = flat.split(/[，,、；;。.!！…\n]+/).map(value => value.trim()).filter(Boolean);
  return clauses.length && clauses.every(isStageClause) ? clauses : null;
}

function literalContext(before, after) {
  return /(?:例如|比如|示例|例子|术语|写法|称作|叫作|词语|引用|原文)[是为：:\s]*$/.test(before.slice(-24)) ||
    /^\s*(?:这个词|一词|这个写法|这几个字|这个例子|是个例子|是一个例子)/.test(after);
}
// A number/technical word anywhere in a note is not permission to read it.
// Only complete literal supplements are allowed through without a stage decision.
const LITERAL_TIME_OR_MATH = /^(?:(?:今天|明天|后天|昨天|早上|上午|中午|下午|晚上|凌晨|星期[一二三四五六日天]|周[一二三四五六日天]|摄氏|华氏)|[0-9零〇一二三四五六七八九十百千万两年月日号点分秒时岁克千米厘公度]|[\s+\-*/×÷=＝.:：/%％℃°±])+$/;
const LITERAL_SUPPLEMENT = /^(?:第[0-9一二三四五六七八九十百]+版|(?:版本|参数|变量|函数|接口|单位|公式|代码)[：:]?[A-Za-z_0-9.+*/=\-]+|接口参数|(?:又称|别名|简称)[^，,；;。！？!?：:（()）【】\[\]]{1,40}|[A-Za-z_][A-Za-z_0-9.]*\s*=\s*[-+\w.]+)$/;
const LITERAL_DEFINITION = /^[^，,；;。！？!?]{1,80}(?:是指|是一种|是个|意味着|意思是|也叫|又称|即为|也就是)[^，,；;。！？!?]+$/;
const PERFORMANCE_CUE = /声音|声线|嗓音|语气|语调|尾音|鼻音|哭腔|笑意|气息|呼吸|眼眶|眼角|睫毛|嘴角|唇角|(?:抬|垂|低|偏|转|别|摇|歪|点|揉|擦|抹)(?:起|下|过|着|了)?(?:眼|头|脸|鼻)(?:看|望|瞧|向|朝|了|着|来|去|$)|吸气|抽泣|哽咽|哭泣|清嗓|叹气/;
function parentheticalDecision(content, before, after) {
  if (literalContext(before, after)) return { kind: 'read' };
  const trimmed = content.trim();
  if (!trimmed || content.length > 240) return { kind: 'uncertain' };
  const exact = stageClauses(content, before, after);
  if (exact) return { kind: 'omit', clauses: exact };
  const flat = content.replace(/[（(【\[）)】\]]/g, '，');
  const clauses = flat.split(/[，,、；;。.!！…\n]+/).map(value => value.trim()).filter(Boolean);
  // Broader evidence can identify compound narration; an unknown clause still
  // cannot pass into audio, and mixed factual/performance text is not erased.
  if (!/[“”‘’「」『』"']/.test(content) && clauses.some(isStageClause) &&
      clauses.every(clause => isStageClause(clause) ||
        (!NARRATION_NON_STAGE.test(clause) && !EXPLANATION.test(clause) && PERFORMANCE_CUE.test(clause))))
    return { kind: 'omit', clauses };
  if (LITERAL_TIME_OR_MATH.test(trimmed) ||
      (LITERAL_SUPPLEMENT.test(trimmed) && !PERFORMANCE_CUE.test(trimmed)) || LITERAL_DEFINITION.test(trimmed))
    return { kind: 'read' };
  return { kind: 'uncertain' };
}

function hintFor(clause) {
  if (/哭|泣|抽噎|哽咽|眼泪|擦泪|泪意|含泪|委屈|伤心|难过|低落|鼻音.*(?:浓|重)|(?:声音|声线|嗓音|尾音).*(?:抖|颤)|眼(?:眶|角|睛).*(?:红|湿润)|sobs?|crying/i.test(clause)) return 'sad';
  if (/生气|愤怒|恼怒|不满|怒气|气鼓鼓|咬牙|握拳|攥紧拳头/.test(clause)) return 'annoyed';
  if (/惊讶|惊喜|吃惊|瞪大眼睛/.test(clause)) return 'surprised';
  if (/俏皮|调皮|撒娇|害羞|轻笑|偷笑|浅笑|chuckle|giggle/i.test(clause)) return 'playful';
  if (/开心|兴奋|欢快|笑|laugh/i.test(clause)) return 'happy';
  if (/温柔|轻柔|柔和|柔软/.test(clause)) return 'gentle';
  if (/平静/.test(clause)) return 'neutral';
  return null;
}

/** Unknown parentheses must never silently become speech; preserve them for text fallback. */
export function prepareSpeechText(text, { factual = false, userText = '' } = {}) {
  if (typeof text !== 'string') throw new TypeError('INVALID_TEXT');
  if (factual || readParenthesesLiterally(userText)) return { spokenText: text, stageDirections: [], emotionHint: null };
  let spokenText = '', emotionHint = null, unsafeForVoice = false;
  const stageDirections = [];
  for (let index = 0; index < text.length;) {
    if (QUOTES.has(text[index])) {
      const end = quotedEnd(text, index);
      if (end >= 0) { spokenText += text.slice(index, end + 1); index = end + 1; continue; }
    }
    if (!BRACKETS.has(text[index])) {
      if (CLOSERS.has(text[index])) unsafeForVoice = true;
      spokenText += text[index++]; continue;
    }
    const end = bracketEnd(text, index);
    if (end < 0) { unsafeForVoice = true; spokenText += text.slice(index); break; }
    const content = text.slice(index + 1, end);
    // This single documented event is used by the selected A audition. It is
    // a model event, not a free-form description. Production inserts it later.
    if (text[index] === '[' && content === 'sob') {
      spokenText += text.slice(index, end + 1); index = end + 1; continue;
    }
    const decision = parentheticalDecision(content, text.slice(0, index), text.slice(end + 1));
    if (decision.kind === 'omit') {
      stageDirections.push(content);
      for (const clause of decision.clauses) emotionHint = hintFor(clause) || emotionHint;
    } else {
      if (decision.kind === 'uncertain') unsafeForVoice = true;
      spokenText += text.slice(index, end + 1);
    }
    index = end + 1;
  }
  return { spokenText: spokenText.trim() ? spokenText : '', stageDirections, emotionHint,
    ...(unsafeForVoice ? { unsafeForVoice: true } : {}) };
}

const VOCALIZATION_DELIMITERS = new Map([...BRACKETS, ...QUOTES, ['[', ']'], ['{', '}'], ['`', '`']]);
function startsProtectedSpan(text, index) {
  return VOCALIZATION_DELIMITERS.has(text[index]) &&
    !(text[index] === "'" && /[\p{Letter}\p{Number}]/u.test(text[index - 1] || ''));
}
function protectedSpanEnd(text, start) {
  const stack = [VOCALIZATION_DELIMITERS.get(text[start])];
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === stack.at(-1)) {
      stack.pop(); if (!stack.length) return index;
    } else if (startsProtectedSpan(text, index)) stack.push(VOCALIZATION_DELIMITERS.get(text[index]));
  }
  return -1;
}

/** Model-only events: the displayed/remembered dialogue must use spokenText. */
export function prepareVocalizedText(text, { crying = false, factual = false, userText = '' } = {}) {
  if (typeof text !== 'string') throw new TypeError('INVALID_TEXT');
  const readWord = /(?:这个字|这个词|这几个字|这些字|这些词|拟声词).{0,8}(?:读|念|朗读)|(?:读|念|朗读).{0,16}(?:这个字|这个词|这几个字|这些字|这些词|拟声词)/.test(userText);
  if (!crying || factual || readParenthesesLiterally(userText) || readWord || EXPLANATION.test(text)) return text;
  const sobs = /(?<![\p{L}\p{N}_])呜+(?:[\s，,、…⋯.～~〜—-]*呜+)*(?![\p{L}\p{N}_])[ \t，,、…⋯.～~〜—-]*/gu;
  let result = '', plain = '';
  const flush = () => { result += plain.replace(sobs, '[sob]'); plain = ''; };
  for (let index = 0; index < text.length;) {
    if (startsProtectedSpan(text, index)) {
      const end = protectedSpanEnd(text, index);
      flush();
      // An unfinished quotation or annotation is not a performance cue.
      if (end < 0) { result += text.slice(index); break; }
      result += text.slice(index, end + 1); index = end + 1;
    } else plain += text[index++];
  }
  flush();
  return result;
}
