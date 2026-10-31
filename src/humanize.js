import { randInt } from './util.js';

/** 去 AI 味：清掉最出戏的那些腔调 */
const AI_ISMS = [
  /作为一个(?:AI|人工智能|语言模型)[，,]?/g,
  /我(?:是|只是)(?:一个)?(?:AI|人工智能|语言模型)[，,]?/g,
  /希望(?:这|以上)?(?:能|可以)?(?:对你)?有(?:所)?帮助[。！!]?/g,
  /如果你(?:还有|有)(?:任何)?(?:其他|别的)?问题[，,]?(?:随时|欢迎)[^。！!？?]*[。！!？?]?/g,
  /值得(?:注意|一提)的是[，,]?/g,
  /综上所述[，,]?/g,
  /总的来说[，,]?/g,
  /首先[，,]?/g,
  /其次[，,]?/g,
  /另外[，,]?/g,
  /需要(?:说明|指出)的是[，,]?/g,
  /^好的[，,]/gm,
  /^嗯[，,]让我(?:想|看)(?:想|看)[。.…]?/gm,
];

export function stripAIisms(text) {
  let s = String(text ?? '');
  for (const re of AI_ISMS) s = s.replace(re, '');
  s = s.replace(/——/g, '，');
  s = s.replace(/[*_`#>]/g, '');
  s = s.replace(/【[^】]*】/g, '');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * 分条发送。真人不会一次甩一大段。
 * 优先按换行切，其次按句末标点，最后按长度硬切。
 */
export function splitSegments(text, { maxChars, maxSegments }) {
  const clean = stripAIisms(text);
  if (!clean) return [];

  let parts = clean
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length === 1 && parts[0].length > maxChars) {
    parts = parts[0]
      .split(/(?<=[。！？!?～~])\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (parts.length === 1 && parts[0].length > maxChars) {
    const hard = [];
    for (let i = 0; i < parts[0].length; i += maxChars) hard.push(parts[0].slice(i, i + maxChars));
    parts = hard;
  }

  if (parts.length > maxSegments) {
    const keep = parts.slice(0, maxSegments - 1);
    keep.push(parts.slice(maxSegments - 1).join(''));
    parts = keep;
  }

  return parts.map((p) => (p.length > maxChars ? p.slice(0, maxChars) : p)).filter(Boolean);
}

/** 模拟打字：按字数估算停顿 */
export function typingDelayMs(text, charsPerSec) {
  const base = (String(text).length / Math.max(1, charsPerSec)) * 1000;
  return Math.min(4500, Math.max(600, Math.round(base + randInt(-150, 350))));
}

/** 该不该在已经冷却的群里插话 */
export function randomBelow(p) {
  return Math.random() < p;
}
