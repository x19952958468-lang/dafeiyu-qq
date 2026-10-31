/**
 * 重点用户（focusUsers）回归：他说话必回 + 回的时候带 @，别人说话不带 @。
 * 不连 QQ、不调真模型、不花钱。
 *   node tools/check-focus.js
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config.js';
import { createEngine } from '../src/pipeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = structuredClone(DEFAULTS);
const FOCUS = { name: '目标群友', qq: '70106', group: '70118', replyAlways: true, atMention: true };

Object.assign(cfg, {
  limits: { ...DEFAULTS.limits, quietHours: [], groupCooldownSec: 0, dailyBudgetCny: 999, totalBudgetCny: 999, maxRepliesPerGroupPerHour: 999 },
  // 概率设 0：能开口就只可能是因为「重点用户」
  trigger: { ...cfg.trigger, interjectRate: 0, interjectMinGapSec: 0, interjectMinChars: 1, keywordWake: [], groupOverrides: {}, focusUsers: [FOCUS] },
  reply: { ...cfg.reply, typingCharsPerSec: 1e6, segmentGapMs: [0, 0] },
  judge: { ...cfg.judge, enabled: false },
});

const store = { append() {}, context: () => ({ history: [], notes: [] }), recent: () => [] };
const limits = { gate: () => ({ ok: true, reason: '' }), spend() {}, noteReply() {}, used: () => 0 };

function run(sender, text) {
  const sent = [];
  const engine = createEngine({
    cfg,
    persona: '你是测试助手，请按指令简洁回答。',
    llm: { chat: async () => ({ text: '（嗤）说这个有意思吗', cost: 0 }), shouldReply: async () => true },
    transport: {
      sendGroup: async (g, segs) => {
        sent.push(segs);
        return { ok: true, data: { message_id: String(1000 + sent.length) } };
      },
      sendPrivate: async () => ({ ok: true, data: { message_id: 1 } }),
      call: async () => ({ ok: false }),
    },
    store,
    limits,
    log: () => {},
  });
  return engine
    .handle({
      post_type: 'message', self_id: '70109', time: Math.floor(Date.now() / 1000),
      message_type: 'group', group_id: Number(FOCUS.group),
      user_id: sender.user_id, sender, message_id: Math.floor(Math.random() * 1e6),
      message: [{ type: 'text', data: { text } }],
    })
    .then((r) => ({ r, sent }));
}

console.log('\n  重点用户回归');
console.log('  ─────────────────────────────');
let fail = 0;
const check = (title, ok, extra = '') => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${title}${extra ? `  ${extra}` : ''}`);
};

// 1. 目标群友说话（没 @ 也没关键词，概率 0）→ 必回，且第一条段是 @他
{
  const { r, sent } = await run({ user_id: FOCUS.qq, nickname: '目标群友', card: '' }, '今天打本又崩了');
  const first = sent[0]?.find(s => s.type === 'at');
  check('目标群友说话必回', !!r?.spoke);
  check('回复里带 @目标群友', first?.type === 'at' && String(first.data.qq) === FOCUS.qq, first ? `实际首段=${first.type}` : '没有发出');
}

// 2. 路人说话（概率 0）→ 沉默
{
  const { r } = await run({ user_id: '70107', nickname: '路人', card: '' }, '今天打本又崩了');
  check('路人说话保持沉默', !r?.spoke);
}

// 3. 机器人主动 @ 他（poke）→ 发出且带 @
{
  const sent = [];
  const engine = createEngine({
    cfg,
    persona: '你是测试助手，请按指令简洁回答。',
    llm: { chat: async () => ({ text: '喂，你今天怎么没冒头', cost: 0 }), shouldReply: async () => true },
    transport: {
      sendGroup: async (g, segs) => {
        sent.push(segs);
        return { ok: true, data: { message_id: '2000' } };
      },
      sendPrivate: async () => ({ ok: true }),
      call: async () => ({ ok: false }),
    },
    store,
    limits,
    log: () => {},
  });
  const r = await engine.poke({ groupId: Number(FOCUS.group), qq: FOCUS.qq, name: '目标群友' });
  const first = sent[0]?.find(s => s.type === 'at');
  check('主动搭话能发出', !!r?.spoke);
  check('主动搭话带 @目标群友', first?.type === 'at' && String(first.data.qq) === FOCUS.qq);
}

console.log('  ─────────────────────────────');
console.log(`  ${fail ? `✗ ${fail} 项不符合预期` : '✓ 全部通过'}\n`);
process.exit(fail ? 1 : 0);
