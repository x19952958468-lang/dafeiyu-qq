/**
 * 回复质量护栏回归：防复读 + 动作括号降频。不连 QQ、不花真钱。
 *   node tools/check-quality.js
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config.js';
import { createEngine } from '../src/pipeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = structuredClone(DEFAULTS);
Object.assign(cfg, {
  limits: { ...DEFAULTS.limits, quietHours: [], groupCooldownSec: 0, dailyBudgetCny: 999, totalBudgetCny: 999, maxRepliesPerGroupPerHour: 999 },
  trigger: { ...cfg.trigger, interjectRate: 1, interjectMinGapSec: 0, interjectMinChars: 1, groupOverrides: {}, keywordWake: [], ignoreSenderNames: [] },
  reply: { ...cfg.reply, typingCharsPerSec: 1e6, segmentGapMs: [0, 0] },
  judge: { ...cfg.judge, enabled: false },
});

// 模型按顺序返回这些话，模拟「它想复读」
const queue = ['（甩尾巴）就凶呗', '（甩尾巴）就凶呗', '（甩尾巴）别催', '别催', '别催'];
let calls = 0;
const llm = {
  chat: async () => ({ text: queue[Math.min(calls++, queue.length - 1)], cost: 0 }),
  shouldReply: async () => true,
};

const store = { append() {}, context: () => ({ history: [], notes: [] }), recent: () => [] };
const limits = { gate: () => ({ ok: true, reason: '' }), spend() {}, noteReply() {}, used: () => 0 };
const engine = createEngine({ cfg, persona: '你是测试助手，请按指令简洁回答。', llm, transport: { sendGroup: async () => ({ ok: true, data: { message_id: 1 } }), sendPrivate: async () => ({ ok: true }) }, store, limits, log: () => {} });

const mk = (text) => ({
  post_type: 'message', self_id: '70109', time: Math.floor(Date.now() / 1000),
  message_type: 'group', group_id: 70118,
  sender: { user_id: 70107, nickname: '鱼片', card: '' },
  message_id: Math.floor(Math.random() * 1e6),
  message: [{ type: 'text', data: { text } }],
});

const cases = [
  { title: '第一句：正常带动作', expect: ['（甩尾巴）就凶呗'] },
  { title: '第二句：模型复读 + 带动作 → 重生成并剥掉动作', expect: ['别催'] },
  { title: '第三句：又想复读上一句 → 干脆沉默', expect: null },
];

console.log('\n  回复质量护栏回归');
console.log('  ─────────────────────────────');
let fail = 0;
for (const c of cases) {
  const r = await engine.handle(mk('你说话啊'));
  const got = r?.spoke ? r.parts : null;
  const ok = JSON.stringify(got) === JSON.stringify(c.expect);
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${c.title}`);
  console.log(`      实际：${got ? got.map((p) => `「${p}」`).join(' ') : '沉默'}`);
}
console.log('  ─────────────────────────────');
console.log(`  ${fail ? `✗ ${fail} 项不符合预期` : `✓ 全部 ${cases.length} 项通过`}\n`);
process.exit(fail ? 1 : 0);
