/**
 * 白名单闸门自检：使用独立的合成配置，验证哪些群会被响应。
 * 不发消息、不调模型、不花钱。
 *   node tools/check-whitelist.js
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createEngine } = await import('../src/pipeline.js');

const cfg = structuredClone(DEFAULTS);
cfg.whitelist.groups = ['81001', '81002'];
cfg.whitelist.friends = ['82001'];

// 只测闸门：放开概率/预算/静默时段，确保唯一可能拦截的原因是白名单
Object.assign(cfg, {
  limits: { ...DEFAULTS.limits, quietHours: [], groupCooldownSec: 0, dailyBudgetCny: 999, totalBudgetCny: 999, maxRepliesPerGroupPerHour: 999 },
  trigger: { ...cfg.trigger, interjectRate: 1, interjectMinGapSec: 0, interjectMinChars: 1 },
  reply: { ...cfg.reply, typingCharsPerSec: 1e6, segmentGapMs: [0, 0] }, // 跳过打字延迟
  judge: { ...cfg.judge, enabled: false },
  llm: { ...cfg.llm, apiKey: '' }, // dry：不调真模型
});

const wl = (cfg.whitelist?.groups || []).map(String);
console.log(`\n  白名单群：${wl.length ? wl.join(', ') : '（空 = 全部群都响应）'}`);
console.log('  ─────────────────────────────');

const SELF = '70101';
const probes = [...wl, '70122']; // 白名单里的群 + 一个参照群
let pass = 0;
let fail = 0;

for (const gid of probes) {
  let spoke = false;
  const engine = createEngine({
    cfg,
    persona: '你是测试助手，请按指令简洁回答。',
    llm: { chat: async () => ({ text: '（测试回复）', cost: 0 }), shouldReply: async () => true },
    transport: {
      sendGroup: async () => { spoke = true; return { ok: true }; },
      sendPrivate: async () => { spoke = true; return { ok: true }; },
    },
    store: { append() {}, context: () => ({ history: [], notes: [] }), recent: () => [] },
    limits: { gate: () => ({ ok: true, reason: '' }), spend() {}, noteReply() {}, used: () => 0 },
    log: () => {},
  });

  await engine.handle({
    post_type: 'message',
    self_id: SELF,
    time: Math.floor(Date.now() / 1000),
    message_type: 'group',
    group_id: Number(gid),
    sender: { user_id: 70107, nickname: '自检', card: '' },
    message_id: 1,
    message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: '在吗' } }],
  });

  const expect = wl.length === 0 || wl.includes(String(gid));
  const ok = spoke === expect;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} 群 ${gid}  ${spoke ? '会响应' : '被拦截'}  （预期：${expect ? '响应' : '拦截'}）`);
}

console.log('  ─────────────────────────────');
console.log(`  ${fail ? `✗ ${fail} 项不符合预期` : `✓ 全部 ${pass} 项通过`}\n`);
process.exit(fail ? 1 : 0);
