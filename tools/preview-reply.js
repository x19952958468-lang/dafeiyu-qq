/**
 * 回复质量验收：拿群里真实的历史消息，走完整决策+生成链路，**只打印不发送**。
 *   node tools/preview-reply.js 70118        # 对最后 1 条
 *   node tools/preview-reply.js 70118 3      # 对最后 3 条各生成一次
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadPersona, DEFAULTS } from '../src/config.js';
import { createLLM } from '../src/llm.js';
import { createTransport } from '../src/onebot.js';
import { createEngine } from '../src/pipeline.js';
import { sleep } from '../src/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(ROOT);
const groupId = String(process.argv[2] || cfg.whitelist.groups[0]);
const n = Math.max(1, Number(process.argv[3] || 1));

// 彩排不设限：预算/冷却/概率都放开，只看「如果它开口，会说什么」
Object.assign(cfg, {
  limits: { ...DEFAULTS.limits, quietHours: [], groupCooldownSec: 0, dailyBudgetCny: 999, totalBudgetCny: 999, maxRepliesPerGroupPerHour: 999 },
  trigger: { ...cfg.trigger, interjectRate: 1, interjectMinGapSec: 0, interjectMinChars: 1 },
});

const transport = createTransport({ cfg, log: () => {} });
transport.connect();
await sleep(1200);
const info = await transport.getLoginInfo();
const self = String(info?.data?.user_id ?? '');

const h = await transport.call('get_group_msg_history', { group_id: Number(groupId), count: 30 });
if (!h.ok) {
  console.log('拉历史失败：', h.error);
  process.exit(1);
}
const msgs = h.data?.messages || [];
const plain = (m) =>
  (Array.isArray(m) ? m : [])
    .filter((s) => s.type === 'text')
    .map((s) => s.data?.text ?? '')
    .join('')
    .trim();

// 把真实历史塞进一个内存 store，让引擎按真实上下文生成
// 默认丢掉机器人自己以前说过的话：换人设之后线上也是清空记忆的，留着会顺着旧口气说
const withSelf = process.argv.includes('--with-self');
const now = Date.now();
const history = msgs
  .map((m, i) => {
    const uid = String(m.sender?.user_id ?? '');
    const isSelf = uid === self;
    return {
      role: isSelf ? 'assistant' : 'user',
      name: isSelf ? cfg.persona.selfName : m.sender?.card || m.sender?.nickname || uid,
      content: plain(m.message),
      ts: now - (msgs.length - i) * 1000,
      message_id: m.message_id,
      user_id: uid,
      isSelf,
    };
  })
  .filter((h) => withSelf || !h.isSelf);

console.log(`\n  回复验收 · 群${groupId}（只生成，不发送）`);
console.log('  ─────────────────────────────');

const targets = msgs.slice(-n).filter((m) => plain(m.message) && String(m.sender?.user_id) !== self);

// 复用同一个引擎，这样「防复读」「动作括号降频」这些跨句状态和线上一模一样
let currentHistory = [];
const store = { append() {}, context: () => ({ history: currentHistory, notes: [] }), recent: () => [] };
const limits = { gate: () => ({ ok: true, reason: '' }), spend() {}, noteReply() {}, used: () => 0 };
const engine = createEngine({
  cfg,
  persona: loadPersona(ROOT, cfg),
  llm: createLLM(cfg),
  transport,
  store,
  limits,
  log: () => {},
});

for (const t of targets) {
  const idx = history.findIndex((x) => x.message_id === t.message_id);
  currentHistory = history.slice(0, idx + 1).map(({ role, name, content, ts }) => ({ role, name, content, ts }));

  const who = t.sender?.card || t.sender?.nickname || t.sender?.user_id;
  console.log(`\n  ▸ ${who}: ${plain(t.message).slice(0, 60)}`);
  const r = await engine.handle(
    {
      post_type: 'message', self_id: self, time: Math.floor(Date.now() / 1000),
      message_type: 'group', group_id: Number(groupId),
      sender: t.sender, message_id: t.message_id, message: t.message,
    },
    { dry: true },
  );
  if (r?.spoke) {
    for (const p of r.parts) console.log(`    →「${p}」`);
    if (r.cost) console.log(`       ¥${r.cost.toFixed(4)}`);
  } else {
    console.log(`    → 沉默${r?.reason ? `（${r.reason}）` : ''}`);
  }
  await sleep(300);
}

console.log('');
transport.close();
process.exit(0);
