/**
 * 插话彩排：拿群里真实的最近消息，让模型按该群的设定生成一句「想插的话」，
 * **只打印不发送**，用来验收人设和群氛围对不对。
 *   node tools/preview-interject.js 70121
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadPersona } from '../src/config.js';
import { createLLM } from '../src/llm.js';
import { createTransport } from '../src/onebot.js';
import { splitSegments } from '../src/humanize.js';
import { hhmm, sleep } from '../src/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(ROOT);
const persona = loadPersona(ROOT, cfg);
const groupId = String(process.argv[2] || cfg.whitelist.groups[0]);
const ov = cfg.trigger.groupOverrides?.[groupId] || {};

const transport = createTransport({ cfg, log: () => {} });
transport.connect();
await sleep(1200);
const info = await transport.getLoginInfo();
const self = String(info?.data?.user_id ?? '');

const h = await transport.call('get_group_msg_history', { group_id: Number(groupId), count: 20 });
if (!h.ok) {
  console.log('拉历史失败：', h.error);
  process.exit(1);
}
const plain = (m) =>
  (Array.isArray(m) ? m : [])
    .filter((s) => s.type === 'text')
    .map((s) => s.data?.text ?? '')
    .join('')
    .trim();

const transcript = (h.data?.messages || [])
  .map((m) => {
    const uid = String(m.sender?.user_id ?? '');
    const nm = uid === self ? cfg.persona.selfName : m.sender?.card || m.sender?.nickname || uid;
    const t = plain(m.message);
    return t ? `${nm}: ${t}` : '';
  })
  .filter(Boolean)
  .join('\n');

console.log(`\n  插话彩排 · 群${groupId}（不发消息）`);
console.log('  ─────────────────────────────');
for (const line of transcript.split('\n')) console.log('   ', line);
console.log('  ─────────────────────────────');

const system =
  persona +
  `\n\n# 运行时\n现在是 ${hhmm()}。你正在一个 QQ 群里，群里在聊上面那些。` +
  (ov.personaHint ? `\n${ov.personaHint}` : '') +
  `\n你想插一句。只发一条，40 字以内，符合你的性格，不要客服腔，不要总结别人说了什么。`;

const llm = createLLM(cfg);
const result = await llm.chat({ messages: [{ role: 'system', content: system }, { role: 'user', content: transcript }] });
const parts = splitSegments(result.text, { maxChars: cfg.reply.maxChars, maxSegments: cfg.reply.maxSegments });
for (const p of parts) console.log(`    →「${p}」`);
if (result.cost) console.log(`\n  本次花费 ¥${result.cost.toFixed(4)}`);
console.log('');
transport.close();
process.exit(0);
