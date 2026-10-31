/**
 * 手动补一句：引用回复群里某条消息（用真实人设 + 真实上下文生成）。
 * 引擎在线时也能用，用于补回被冷却/判定漏掉的话。
 *
 *   node tools/reply-now.js 70118 70104
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadPersona } from '../src/config.js';
import { createLLM } from '../src/llm.js';
import { createTransport, seg } from '../src/onebot.js';
import { splitSegments, typingDelayMs } from '../src/humanize.js';
import { hhmm, sleep } from '../src/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(ROOT);
const persona = loadPersona(ROOT, cfg);

const groupId = process.argv[2];
const targetId = String(process.argv[3] || '');
if (!groupId) {
  console.log('用法：node tools/reply-now.js <群号> <要回复的 message_id>');
  process.exit(1);
}

const transport = createTransport({ cfg, log: () => {} });
transport.connect();
await sleep(1200);

const info = await transport.getLoginInfo();
const self = String(info?.data?.user_id ?? '');
const selfName = cfg.persona.selfName;

const plain = (m) =>
  (Array.isArray(m) ? m : [])
    .filter((s) => s.type === 'text')
    .map((s) => s.data?.text ?? '')
    .join('')
    .trim();

const h = await transport.call('get_group_msg_history', { group_id: Number(groupId), count: 40 });
if (!h.ok) {
  console.log('拉历史失败：', h.error);
  process.exit(1);
}
const msgs = h.data?.messages || [];
const idx = msgs.findIndex((m) => String(m.message_id) === targetId);
if (idx < 0) {
  console.log(`历史里找不到 message_id=${targetId}`);
  process.exit(1);
}

const target = msgs[idx];
const who = target.sender?.card || target.sender?.nickname || String(target.sender?.user_id);
const targetText = plain(target.message);

// 取目标之前若干条做上下文（含自己说过的话）
const ctx = msgs.slice(Math.max(0, idx - 12), idx + 1);
const transcript = ctx
  .map((m) => {
    const uid = String(m.sender?.user_id ?? '');
    const nm = uid === self ? selfName : m.sender?.card || m.sender?.nickname || uid;
    const t = plain(m.message);
    return t ? `${nm}: ${t}` : '';
  })
  .filter(Boolean)
  .join('\n');

console.log(`\n  引用回复 → 群${groupId} · ${who}: 「${targetText}」  #${targetId}`);
console.log('  ─────────────────────────────');
console.log('  上下文：');
for (const line of transcript.split('\n')) console.log('   ', line);
console.log('  ─────────────────────────────');

const llm = createLLM(cfg);
const dry = process.argv.includes('--dry');
const ov = cfg.trigger.groupOverrides?.[String(groupId)] || {};
const system =
  persona +
  `\n\n# 运行时\n现在是 ${hhmm()}。你正在一个 QQ 群里。` +
  (ov.personaHint ? `\n${ov.personaHint}` : '') +
  `\n刚才有人（${who}）引用回复了你说的话，内容就是「${targetText}」。` +
  `\n按你的性格接一句。只发一条，40 字以内，不要解释自己在扮演谁，不要客服腔。`;

let result;
try {
  result = await llm.chat({ messages: [{ role: 'system', content: system }, { role: 'user', content: transcript }] });
} catch (e) {
  console.log('模型调用失败：', e.message);
  process.exit(1);
}

const parts = splitSegments(result.text, { maxChars: cfg.reply.maxChars, maxSegments: cfg.reply.maxSegments });
if (!parts.length) {
  console.log('模型返回空');
  process.exit(1);
}

if (dry) {
  console.log('  【dry 预览，未发送】');
  for (const p of parts) console.log(`    →「${p}」`);
  if (result.cost) console.log(`  本次花费 ¥${result.cost.toFixed(4)}`);
  console.log('');
  transport.close();
  process.exit(0);
}

for (let i = 0; i < parts.length; i += 1) {
  await sleep(typingDelayMs(parts[i], cfg.reply.typingCharsPerSec));
  const segments = [];
  if (i === 0) segments.push(seg.reply(targetId));
  segments.push(seg.text(parts[i]));
  const r = await transport.sendGroup(groupId, segments);
  console.log(r.ok ? `  ✓ 已发送（message_id=${r.data?.message_id}）「${parts[i]}」` : `  ✗ 发送失败：${r.error}`);
  if (!r.ok) break;
}

if (result.cost) console.log(`  本次花费 ¥${result.cost.toFixed(4)}`);
console.log('');
transport.close();
process.exit(0);
