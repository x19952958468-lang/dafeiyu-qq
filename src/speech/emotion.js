const MOOD_TTL = 10 * 60000;
const EMOTIONS = new Set(['neutral', 'happy', 'sad', 'annoyed', 'gentle', 'playful', 'surprised']);
const INTENTS = new Set(['chat', 'welcome', 'comfort', 'tease', 'protest', 'apologize', 'ask', 'explain']);
const PACES = new Set(['slow', 'natural', 'brisk']);
const CONTOURS = new Set(['steady', 'rise_then_settle', 'soft_then_firm', 'bright_then_soft', 'hesitant_then_open']);
const defaultDirections = {
  neutral: { intent: 'chat', pace: 'natural', contour: 'steady' },
  happy: { intent: 'chat', pace: 'brisk', contour: 'bright_then_soft' },
  sad: { intent: 'chat', pace: 'slow', contour: 'hesitant_then_open' },
  annoyed: { intent: 'protest', pace: 'natural', contour: 'soft_then_firm' },
  gentle: { intent: 'comfort', pace: 'slow', contour: 'steady' },
  playful: { intent: 'tease', pace: 'natural', contour: 'rise_then_settle' },
  surprised: { intent: 'chat', pace: 'natural', contour: 'rise_then_settle' },
};

const styles = {
  neutral: ['像面对面接话一样自然，语气有回应感，重音落在句子的意思上，句尾自然收住。'],
  happy: ['带可听见的笑意，起句轻快，重点词稍微扬起，句尾放松。',
    '开心和笑意清楚可辨，关键好消息抬高语调并加重；前半句轻快，后半句带笑收稳。'],
  sad: ['带委屈和伤心的哭腔，起声稍软，情感词前短停，句尾缓慢落下。',
    '带明显委屈的哭腔，像忍着眼泪还努力把话说清楚。字头和字尾完整，相邻音节分明；情感词带轻微颤动并加重，停顿放在词组之间，句尾压低、缓缓放软。'],
  annoyed: ['带气呼呼和不服气的语气，重点词稍重，短句之间有利落停顿。',
    '不满和不服气清楚可辨，起句有力度，关键否定或反驳词加重；中间短停，后半句坚定收住。'],
  gentle: ['温柔亲近，重点安慰词说得柔和，语速稍缓，留出自然呼吸。',
    '关心和亲近感清楚可辨，起声柔软，安慰词稍放慢并加重；句中留短暂停顿，末尾温暖地落下。'],
  playful: ['带俏皮的笑意，调侃词轻轻扬起，留一点有意味的短停。',
    '俏皮和逗趣感清楚可辨，开头轻快，玩笑的关键处扬起并短停；结尾带笑放软，像熟人间自然打趣。'],
  surprised: ['起句略微扬起，惊讶词稍重，然后自然回落。',
    '惊讶清楚可辨，起声明显扬起，惊讶词前后留短停；随后展开声音，把后半句自然收稳。'],
};
const intentInstructions = {
  chat: '先接住对方的话，再顺着意思说下去。',
  welcome: '起句带迎接对方的亲近感，称呼与问候自然连贯。',
  comfort: '把安慰和陪伴的重点说清楚，给对方一点能接话的余地。',
  tease: '让玩笑落点可听见，停顿轻巧，结尾留一点笑意。',
  protest: '把反对的重点说清楚，重音坚定，句尾收稳。',
  apologize: '起句认真放软，承担和解释的部分清楚，结尾诚恳。',
  ask: '疑问重点稍加重，问句结尾随含义轻扬，给对方接话空间。',
  explain: '按意思分组，关键信息加重，解释连贯而有自然停顿。',
};
const paceInstructions = {
  slow: '语速稍慢，语义分组之间留短停，词内保持连贯。',
  natural: '语速随意思自然快慢，重点略放慢，其余部分顺畅连起来。',
  brisk: '整体轻快利落，重点仍留短停，句尾完整收住。',
};
const contourInstructions = {
  steady: '气息稳定，重音与语义停顿清楚，句尾自然回落。',
  rise_then_settle: '开头略扬起引出意思，中段突出重点，结尾平稳落下。',
  soft_then_firm: '开头柔和，后半句重点逐渐坚定，句尾收稳。',
  bright_then_soft: '开头明亮轻快，后半句逐渐放软，末尾亲近自然。',
  hesitant_then_open: '开头有一瞬自然迟疑，短停后声音展开，后半句说得连贯。',
};

export function wantsSpeech(text = '') {
  return /语音|(?:用|发|来点)声音|说给我听|读出来|念出来|哭腔|笑着说|哭着说|生气地说|撒娇地说|来句/.test(text) && !declinesSpeech(text);
}
export function declinesSpeech(text = '') {
  return /不要.{0,5}语音|别.{0,5}语音|不用.{0,5}语音|只(?:发|用|要)?文字|文字(?:说|回复)/.test(text);
}

/** Only an immediate request to hear the preceding performance again, not a new task. */
export function continuesSpeech(text = '') {
  if (text.length > 80 || declinesSpeech(text) || /视频|[Bb]站|bilibili|链接|推荐|评论|唱|歌曲|歌词|电影|新闻|天气|几点|多少钱|代码|算一下/.test(text)) return false;
  return /再(?:听|说|念|读)(?:一|几|两)?(?:句|遍|次)|多(?:来|说|念|读)(?:一|几|两)?句|(?:^|[，。！？、\s])再来(?:一(?:句|遍|次|段)|几句|两句)?(?:[，。！？、\s]|$)|继续(?:说|念|读|哭|笑)|别哭了|正常说|恢复正常/.test(text);
}

function validatedDirection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !EMOTIONS.has(value.emotion)) return null;
  const defaults = defaultDirections[value.emotion];
  return { emotion: value.emotion, intent: INTENTS.has(value.intent) ? value.intent : defaults.intent,
    pace: PACES.has(value.pace) ? value.pace : defaults.pace, contour: CONTOURS.has(value.contour) ? value.contour : defaults.contour };
}

// Quoted words are transcript data, not instructions about their own performance.
function instructionText(text) {
  return String(text).replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'/g, s => ' '.repeat(s.length));
}
const discussion = /听说|有人说|他(?:刚才)?说|她(?:刚才)?说|你说的|之前说|例如|比如|假如|假设|如果|为什么|什么意思|是什么|什么叫|喜欢|讨厌|反感|你(?:在|刚才|之前|总是)/;
function negated(clause, at, length) {
  const before = clause.slice(0, at).slice(-16);
  const after = clause.slice(at + length);
  return /(?:不要|不用|别|不必|不能|不许|禁止|不想|不喜欢|讨厌|不是|不需要|并不|没有|不太|不).{0,10}$/.test(before) ||
    /^(?:的?(?:语气|声音)|地说|说)?(?:就)?(?:不要了|算了|先别|先不)/.test(after);
}
function isRequest(clause, match) {
  const before = clause.slice(0, match.index).trim();
  const after = clause.slice(match.index + match[0].length).trim();
  return /(?:请|麻烦|用|以|带着|换成|改成|来点|来句|来一句|来一段|给我|帮我|让我听|我想听你?|想听你?|能不能|可不可以|你能|你可以|再|更|稍微)\s*$/.test(before) ||
    /^(?:地|的语气|的声音|一点|点|些|着)?(?:说|讲|读|念|给我听|语音)/.test(after) ||
    (!before && /^(?:一点|点|些|的语气|的声音|语音)?(?:吧|呀|嘛|呗)?$/.test(after));
}
function requestedEmotion(userText) {
  const input = instructionText(userText);
  const events = [];
  const cues = [
    ['sad', /哭腔|哭着|委屈|伤心/g], ['happy', /笑着|带笑|开心|高兴|欢快/g],
    ['annoyed', /气呼呼|生气|愤怒|凶/g], ['gentle', /温柔|安慰|轻声/g],
    ['playful', /撒娇|俏皮|调皮/g], ['surprised', /惊讶|吃惊|惊喜/g],
  ];
  for (const clauseMatch of input.matchAll(/[^，。！？；\n,.!?;]+/g)) {
    // Keep correction clauses independent: “不是哭着说而是笑着说”.
    const clause = clauseMatch[0].replace(/(?:而是|但是|不过)/g, s => '|'.repeat(s.length));
    for (const fragment of clause.matchAll(/[^|]+/g)) {
      const part = fragment[0];
      if (discussion.test(part)) continue;
      const offset = clauseMatch.index + fragment.index;
      const reset = /别哭(?:了)?|不要哭(?:了)?|不哭了|别生气(?:了)?|不要生气(?:了)?|别笑(?:了)?|不要笑(?:了)?|恢复正常|正常(?:一点|点|说|语气)|认真(?:点|一点|说|回答)|平静(?:一点|点|地说|说)|别装(?:了)?/g;
      for (const match of part.matchAll(reset)) events.push({ emotion: 'neutral', source: 'reset', at: offset + match.index });
      for (const [emotion, cue] of cues) {
        for (const match of part.matchAll(cue)) {
          const denied = negated(part, match.index, match[0].length);
          if (denied && /(?:不要|不用|别|不必|不是让你|不是叫你|不是要你|不需要).{0,10}$/.test(part.slice(0, match.index)) &&
            (isRequest(part, match) || /^(?:了|一点|点|的语气|的声音)?\s*$/.test(part.slice(match.index + match[0].length))))
            events.push({ emotion: 'neutral', source: 'reset', at: offset + match.index });
          if (!denied && isRequest(part, match))
            events.push({ emotion, source: 'explicit', at: offset + match.index });
        }
      }
    }
  }
  return events.sort((a, b) => a.at - b.at).at(-1) || null;
}

function textEmotion(text) {
  const value = String(text);
  if (/没关系|别难过|陪着你|慢慢来|别担心|放心吧|辛苦了|别着急/.test(value)) return 'gentle';
  const patterns = [
    ['happy', /哈哈|太好了|好开心|真开心|太开心|太棒了|太高兴|好耶|终于成功|成功了/g],
    ['sad', /难过|伤心|委屈|想哭|失落|好难受/g],
    ['annoyed', /太过分了|生气|气死我了|受够了|别再这样了/g],
    ['playful', /逗你的|开个玩笑|就不告诉你|你猜(?:呀|嘛|呢|[!！?？])|嘿嘿|略略略/g],
    ['surprised', /哇[，,！!]|竟然|居然|没想到|真的假的|不会吧|吓我一跳/g],
  ];
  for (const [emotion, pattern] of patterns) {
    for (const match of value.matchAll(pattern)) {
      const clauseStart = Math.max(...['，', '。', '！', '？', ',', '.', '!', '?', '\n'].map(c => value.lastIndexOf(c, match.index - 1)), -1) + 1;
      if (!negated(value.slice(clauseStart), match.index - clauseStart, match[0].length)) return emotion;
    }
  }
  return null;
}

function instructionFor(emotion, intensity, direction) {
  const level = intensity >= .8 ? 1 : 0;
  const style = styles[emotion][level] || styles[emotion][0];
  const degree = emotion === 'neutral' ? '' : intensity < .35
    ? '情绪轻轻带出，重点词与句尾保留可听见的变化。' : intensity >= .8
      ? '让情绪落在清楚的重音、语调转折和语义停顿上，情绪起伏鲜明，吐字仍清楚。'
      : '情绪自然清楚，重点词有轻重，句中有短停，句尾有自然变化。';
  const d = direction || defaultDirections[emotion];
  return [style, degree, intentInstructions[d.intent], paceInstructions[d.pace], contourInstructions[d.contour],
    '像对眼前的人说话，保持参考音色与声线。只说提供的台词，不增加字句，不朗读舞台说明或情绪标签。'].filter(Boolean).join(' ');
}

/** Delivery instructions are compiled from finite enums; transcript words stay unchanged. */
export function selectEmotion({ userText = '', text = '', factual = false, intensity = .65, previous, direction, now = Date.now() }) {
  const strength = Number.isFinite(intensity) ? Math.max(0, Math.min(1, intensity)) : .65;
  const semantic = validatedDirection(direction);
  const requested = requestedEmotion(userText);
  let emotion = 'neutral', source = 'neutral', time = now, delivery = null;
  if (factual) {
    source = 'factual'; delivery = { intent: 'explain', pace: 'natural', contour: 'steady' };
  } else if (requested) {
    ({ emotion, source } = requested);
    if (source === 'explicit' && semantic?.emotion === emotion) delivery = semantic;
  } else if (semantic) {
    emotion = semantic.emotion; source = 'semantic'; delivery = semantic;
  } else {
    const current = textEmotion(text);
    if (current) { emotion = current; source = 'text'; }
    else if ((!String(userText).trim() || continuesSpeech(String(userText))) && previous &&
      previous.emotion !== 'neutral' && EMOTIONS.has(previous.emotion) && Number.isFinite(previous.time) &&
      now - previous.time >= 0 && now - previous.time < MOOD_TTL) {
      emotion = previous.emotion; source = 'continuation'; time = previous.time;
    }
  }
  return { emotion, intensity: emotion === 'neutral' ? 0 : strength, source, time,
    instruction: instructionFor(emotion, strength, delivery) };
}
