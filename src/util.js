export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** 本地时间 HH:MM */
export function hhmm(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function ymd(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function truncate(str, n) {
  if (!str) return '';
  const s = String(str);
  return s.length <= n ? s : s.slice(0, n) + '…';
}

/** 按字符数估算 token，中文约 1 字 1 token，英文约 4 字符 1 token */
export function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export function costOf(usage, pricing) {
  const input = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens ?? 0;
  return (
    (input / 1_000_000) * (pricing.inputPerMillion ?? 0) +
    (output / 1_000_000) * (pricing.outputPerMillion ?? 0)
  );
}

export function safeKey(key) {
  return String(key).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

/** "22:00-07:00" 支持跨零点，也支持数组 */
export function inQuietHours(ranges, now = new Date()) {
  if (!ranges || !ranges.length) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const toMin = (t) => {
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + (m || 0);
  };
  return ranges.some((r) => {
    const [a, b] = String(r).split('-').map((x) => x.trim());
    const s = toMin(a);
    const e = toMin(b);
    return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
  });
}
