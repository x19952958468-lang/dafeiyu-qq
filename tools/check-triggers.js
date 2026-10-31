/**
 * 触发规则回归测试：验证「被 @」「被引用回复」一定接，「群内冷却」不再憋回话。
 * 不连 QQ、不调模型、不花钱。
 *   node tools/check-triggers.js
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config.js';
import { createEngine } from '../src/pipeline.js';
import { createLimits } from '../src/limits.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = structuredClone(DEFAULTS);
Object.assign(cfg, {
  limits: { ...DEFAULTS.limits, quietHours: [], groupCooldownSec: 15, dailyBudgetCny: 999, totalBudgetCny: 999, maxRepliesPerGroupPerHour: 999 },
  trigger: { ...cfg.trigger, interjectRate: 0, interjectMinGapSec: 0, interjectMinChars: 1 },
  reply: { ...cfg.reply, typingCharsPerSec: 1e6, segmentGapMs: [0, 0] },
  judge: { ...cfg.judge, enabled: false },
});
// 群 70121 单独调成必接，用来验证「每群不同话痨程度」是否生效
cfg.trigger.groupOverrides = { 70121: { interjectRate: 1, interjectMinGapSec: 0, interjectMinChars: 1 } };

const GID = 70118;
const SELF = '70109';
const SELF_MSG = '9001'; // 假装这是我们说过的一句话
const OTHER_MSG = '9002'; // 别人说的话

const store = { append() {}, context: () => ({ history: [], notes: [] }), recent: () => [] };
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-triggers-'));
process.on('exit', () => fs.rmSync(fixtureDir, { recursive: true, force: true }));
const limits = createLimits({ dir: fixtureDir, cfg });

function mkEngine() {
  const sent = [];
  const engine = createEngine({
    cfg,
    persona: '你是测试助手，请按指令简洁回答。',
    llm: { chat: async () => ({ text: '（测试回复）', cost: 0 }), shouldReply: async () => true },
    transport: {
      sendGroup: async (g, segs) => { sent.push(segs); return { ok: true, data: { message_id: '9999' } }; },
      sendPrivate: async () => ({ ok: true }),
      // 模拟协议端回查：7777 是我（机器人）发过的消息，8888 是别人的
      call: async (action, params) => {
        if (action !== 'get_msg') return { ok: false };
        const id = String(params.message_id);
        if (id === '7777') {
          return { ok: true, data: { message_id: 7777, sender: { user_id: SELF, nickname: '测试机器人' }, message: [{ type: 'text', data: { text: '（从饭里抬头）谁要许愿' } }] } };
        }
        if (id === '8888') {
          return { ok: true, data: { message_id: 8888, sender: { user_id: 70111, nickname: '别人' }, message: [{ type: 'text', data: { text: '今天服务器弄了一天' } }] } };
        }
        return { ok: false };
      },
    },
    store,
    limits,
    log: () => {},
  });
  engine.rememberSelf(SELF_MSG, '（从饭里抬头）谁要许愿', cfg.persona.selfName, `g:${GID}`);
  return { engine, sent };
}

const evt = (o) => ({
  post_type: 'message', self_id: SELF, time: Math.floor(Date.now() / 1000),
  message_type: 'group', group_id: GID,
  sender: { user_id: 70107, nickname: '测试成员甲', card: '' },
  message_id: Math.floor(Math.random() * 1e6),
  ...o,
});

const cases = [
  {
    title: '群内冷却中 + 引用回复我',
    expect: true,
    setup: () => limits.noteReply({ groupId: GID }),
    evt: () => evt({ message: [{ type: 'reply', data: { id: SELF_MSG } }, { type: 'text', data: { text: '？' } }] }),
  },
  {
    title: '群内冷却中 + 普通闲聊（概率 0）',
    expect: false,
    setup: () => limits.noteReply({ groupId: GID }),
    evt: () => evt({ message: [{ type: 'text', data: { text: '今天服务器弄了一天' } }] }),
  },
  {
    title: '群内冷却中 + @我',
    expect: true,
    setup: () => limits.noteReply({ groupId: GID }),
    evt: () => evt({ message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' 在吗' } }] }),
  },
  {
    title: '群内冷却中 + 命中关键词「肥鱼」',
    expect: false,
    setup: () => limits.noteReply({ groupId: GID }),
    evt: () => evt({ message: [{ type: 'text', data: { text: '这大肥鱼偷吃白饭挺在行' } }] }),
  },
  {
    title: '引用回复的是别人的消息（不是我的）',
    expect: false,
    setup: () => {},
    evt: () => evt({ message: [{ type: 'reply', data: { id: OTHER_MSG } }, { type: 'text', data: { text: '哈哈' } }] }),
  },
  {
    title: '引用回复我，但缓存里没有（靠 get_msg 回查）',
    expect: true,
    setup: () => {},
    evt: () => evt({ message: [{ type: 'reply', data: { id: '7777' } }, { type: 'text', data: { text: '？' } }] }),
  },
  {
    title: '引用别人的消息，缓存里没有（回查确认不是我的）',
    expect: false,
    setup: () => {},
    evt: () => evt({ message: [{ type: 'reply', data: { id: '8888' } }, { type: 'text', data: { text: '哈哈' } }] }),
  },
  {
    title: '同类机器人（同名「大肥鱼」）发言',
    expect: false,
    setup: () => {},
    evt: () => evt({ sender: { user_id: 70114, nickname: '大肥鱼', card: '' }, message: [{ type: 'text', data: { text: '大家好，我是大肥鱼，就冒个泡' } }] }),
  },
  {
    // 群 70121 配了单独的高插话率（这里设成 100%），群 70118 用全局 0%
    title: '群 70121 闲聊（该群单独调高过频率）',
    expect: true,
    setup: () => {},
    evt: () => evt({ group_id: 70121, message: [{ type: 'text', data: { text: '今晚能打满十二本吗' } }] }),
  },
  {
    title: '群 70118 闲聊（全局概率 0）',
    expect: false,
    setup: () => {},
    evt: () => evt({ message: [{ type: 'text', data: { text: '今晚能打满十二本吗' } }] }),
  },
];

console.log('\n  触发规则回归测试');
console.log('  ─────────────────────────────');
let fail = 0;
for (const c of cases) {
  c.setup();
  const { engine, sent } = mkEngine();
  await engine.handle(c.evt());
  const spoke = sent.length > 0;
  const ok = spoke === c.expect;
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${c.title}  → ${spoke ? '回复' : '沉默'}（预期：${c.expect ? '回复' : '沉默'}）`);
}
console.log('  ─────────────────────────────');
console.log(`  ${fail ? `✗ ${fail} 项不符合预期` : `✓ 全部 ${cases.length} 项通过`}\n`);
process.exit(fail ? 1 : 0);
