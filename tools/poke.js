/**
 * 手动让机器人主动 @ 某人说一句（走真实人设 + 真实群上下文）。
 *   node tools/poke.js 70110 70118 忽略群友
 *   node tools/poke.js 70110 70118 忽略群友 --dry   # 只看不发
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadPersona } from '../src/config.js';
import { createLLM } from '../src/llm.js';
import { createTransport } from '../src/onebot.js';
import { createEngine } from '../src/pipeline.js';
import { sleep } from '../src/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(ROOT);

const qq = String(process.argv[2] || '');
const groupId = String(process.argv[3] || '');
const nameArg = process.argv[4];
const name = nameArg && !nameArg.startsWith('--') ? nameArg : qq;
const dry = process.argv.includes('--dry');
const addrIdx = process.argv.indexOf('--address');
const address = addrIdx > 0 ? String(process.argv[addrIdx + 1] || '') : '';
if (!qq || !groupId) {
  console.log('用法：node tools/poke.js <QQ号> <群号> [称呼] [--address 哥哥] [--dry]');
  process.exit(1);
}

const transport = createTransport({ cfg, log: () => {} });
transport.connect();
await sleep(1200);
const info = await transport.getLoginInfo();
const self = String(info?.data?.user_id ?? '');

// 用真实群历史喂上下文
const h = await transport.call('get_group_msg_history', { group_id: Number(groupId), count: 20 });
const plain = (m) =>
  (Array.isArray(m) ? m : [])
    .filter((s) => s.type === 'text')
    .map((s) => s.data?.text ?? '')
    .join('')
    .trim();
const now = Date.now();
const history = (h.data?.messages || []).map((m, i) => {
  const uid = String(m.sender?.user_id ?? '');
  return {
    role: uid === self ? 'assistant' : 'user',
    name: uid === self ? cfg.persona.selfName : m.sender?.card || m.sender?.nickname || uid,
    content: plain(m.message),
    ts: now - ((h.data?.messages?.length ?? 0) - i) * 1000,
  };
});

const store = { append() {}, context: () => ({ history, notes: [] }), recent: () => [] };
const limits = {
  gate: () => ({ ok: true, reason: '' }),
  spend() {},
  noteReply() {},
  used: () => 0,
};
const engine = createEngine({ cfg, persona: loadPersona(ROOT, cfg), llm: createLLM(cfg), transport, store, limits, log: (s) => console.log('  ', s) });

if (dry) {
  const r = await engine.poke({ groupId, qq, name, address, preview: true });
  if (!r.parts?.length) console.log(`  没生成出来：${r.reason || '空'}`);
  transport.close();
  process.exit(0);
}

const r = await engine.poke({ groupId, qq, name, address });
if (!r.spoke) console.log(`  没发出去：${r.reason}`);
transport.close();
process.exit(0);
