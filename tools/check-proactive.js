/**
 * 主动 @ 群友 的选人逻辑验收：不真的发消息，只把「会挑谁、叫他什么」打出来。
 *   node tools/check-proactive.js
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadPersona } from '../src/config.js';
import { createLLM } from '../src/llm.js';
import { createTransport } from '../src/onebot.js';
import { createEngine } from '../src/pipeline.js';
import { createPoker } from '../src/poke.js';
import { sleep } from '../src/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(ROOT);
const argGroup = process.argv[2] && !process.argv[2].startsWith('--') ? String(process.argv[2]) : '';
const groupId = argGroup || String((cfg.proactiveAt.groups ?? [])[0] ?? cfg.whitelist.groups[0]);

const transport = createTransport({ cfg, log: () => {} });
transport.connect();
await sleep(1200);

const store = { append() {}, context: () => ({ history: [], notes: [] }), recent: () => [] };
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

// 拦截真正的发送：只记录要 @ 谁、叫他什么
const sent = [];
const realPoke = engine.poke;
const fakeEngine = {
  stats: () => ({ lastReplyAt: 0 }),
  poke: async (args) => {
    sent.push(args);
    return { spoke: true };
  },
};

const poker = createPoker({
  cfg: { ...cfg, proactiveAt: { ...cfg.proactiveAt, everySec: 0, minGapAfterBotSec: 0 } },
  engine: fakeEngine,
  limits,
  transport,
  log: (s) => console.log('  ', s),
});

console.log(`\n  主动 @ 群友 · 群${(cfg.proactiveAt.groups ?? []).join(',')}（本轮会逐个群试）`);
console.log('  ─────────────────────────────');
await poker.tick();
if (!sent.length) {
  console.log('  （这一轮没挑到人：可能最近 15 分钟没人说话，或都在冷却里）');
} else {
  for (const s of sent) {
    console.log(`  ✓ @${s.name}（${s.qq}）叫「${s.address}」`);
  }
  // 用真实链路生成一句，看看称呼有没有真的出现
  const first = sent[0];
  if (process.argv.includes('--send')) {
    const r = await realPoke.call(engine, first);
    console.log(`  已发送：${r.spoke ? `「${r.parts?.[0]}」` : `没发出去（${r.reason}）`}`);
  } else {
    const r = await realPoke.call(engine, { ...first, preview: true });
    console.log(`  生成：${r.parts?.[0] ?? '（空）'}（未发送，加 --send 才真发）`);
  }
}
console.log('');

transport.close();
process.exit(0);
