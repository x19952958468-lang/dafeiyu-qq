/**
 * 离线彩排：不连 QQ、不花钱，验证决策链和拟人化逻辑。
 *   node tools/simulate.js
 * 想接真模型彩排（会花钱）：
 *   node tools/simulate.js --live
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadPersona, DEFAULTS } from '../src/config.js';
import { createLLM } from '../src/llm.js';
import { createStore } from '../src/memory.js';
import { createLimits } from '../src/limits.js';
import { createEngine } from '../src/pipeline.js';
import { sleep } from '../src/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'sim');
const live = process.argv.includes('--live');

const log = (...a) => console.log('   ', ...a);
const sent = [];

const cfg = loadConfig(ROOT);
Object.assign(cfg, {
  limits: {
    ...DEFAULTS.limits,
    quietHours: [],
    groupCooldownSec: 0,
    dailyBudgetCny: 999,
    totalBudgetCny: 999,
    maxRepliesPerGroupPerHour: 999,
  },
  trigger: { ...cfg.trigger, interjectRate: 1, interjectMinGapSec: 0, interjectMinChars: 1 },
});
if (!live) cfg.llm = { ...cfg.llm, apiKey: '' };

const transport = {
  sendGroup: async (gid, segs) => {
    sent.push({ to: `群${gid}`, text: segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('') });
    return { ok: true };
  },
  sendPrivate: async (uid, segs) => {
    sent.push({ to: `私聊${uid}`, text: segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('') });
    return { ok: true };
  },
};

const engine = createEngine({
  cfg,
  persona: loadPersona(ROOT, cfg),
  llm: createLLM(cfg),
  transport,
  store: createStore({ dir: DATA, ctx: cfg.context, mem: cfg.memory }),
  limits: createLimits({ dir: DATA, cfg }),
  log,
});

const SELF = '70101';
const mk = (o) => ({
  post_type: 'message',
  self_id: SELF,
  time: Math.floor(Date.now() / 1000),
  sender: { user_id: 70107, nickname: '阿明', card: '' },
  message_id: Math.floor(Math.random() * 1e6),
  ...o,
});

const cases = [
  {
    title: '群里闲聊 · 不插话（概率 0）',
    interject: 0,
    evt: mk({ message_type: 'group', group_id: 900001, message: [{ type: 'text', data: { text: '今天下午开会吗' } }] }),
  },
  {
    title: '群里闲聊 · 概率插话（彩排里设成 100%）',
    interject: 1,
    evt: mk({ message_type: 'group', group_id: 900001, message: [{ type: 'text', data: { text: '好饿啊，谁去食堂' } }] }),
  },
  {
    title: '群里 @ 它（必答）',
    interject: 0,
    evt: mk({ message_type: 'group', group_id: 900001, message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' 你在干嘛' } }] }),
  },
  {
    title: '关键词唤醒（必答）',
    interject: 0,
    evt: mk({ message_type: 'group', group_id: 900002, message: [{ type: 'text', data: { text: '这条小鲸鱼是不是又胖了' } }] }),
  },
  {
    title: '私聊（必答）',
    interject: 0,
    evt: mk({ message_type: 'private', message: [{ type: 'text', data: { text: '在吗' } }] }),
  },
  {
    title: '静默时段（被闸门拦住）',
    interject: 0,
    quiet: true,
    evt: mk({ message_type: 'group', group_id: 900003, message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' 说话' } }] }),
  },
];

console.log('\n  大肥鱼 · 离线彩排' + (live ? '（接真模型）' : '（dry：不调模型、不花钱）'));
console.log('  ─────────────────────────────');

for (const c of cases) {
  sent.length = 0;
  cfg.trigger.interjectRate = c.interject;
  cfg.limits.quietHours = c.quiet ? ['00:00-23:59'] : [];
  console.log(`\n  ▸ ${c.title}`);
  await engine.handle(c.evt);
  if (!sent.length) console.log('    → 沉默');
  for (const s of sent) console.log(`    → [${s.to}] ${s.text}`);
  await sleep(120);
}

console.log('\n  彩排结束。逻辑通不代表群里就好用，真人聊起来再调 persona 和概率。\n');
