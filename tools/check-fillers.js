/**
 * 口头禅频率控制验收：连着两句都用「我超」时，第三次生成的提示词里必须出现「换一个」的指令。
 *   node tools/check-fillers.js
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config.js';
import { createEngine } from '../src/pipeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = structuredClone(DEFAULTS);
cfg.trigger = { ...cfg.trigger, interjectRate: 0, interjectRampSec: 0 };
cfg.limits = { ...cfg.limits, quietHours: [], groupCooldownSec: 0, maxRepliesPerGroupPerHour: 999 };

const GROUP = '70118';
const prompts = [];
let n = 0;

const llm = {
  dry: false,
  async chat({ messages }) {
    prompts.push(messages[0].content);
    n += 1;
    return { text: `我超，这是第${n}句测试的话`, cost: 0 };
  },
  async shouldReply() {
    return true;
  },
};

const transport = {
  async sendGroup() {
    return { ok: true, data: { message_id: 1000 + n } };
  },
  async call() {
    return { ok: false };
  },
  async getLoginInfo() {
    return { ok: true, data: { user_id: 70109, nickname: '大肥鱼' } };
  },
};

const history = [];
const store = {
  append(_key, turn) {
    history.push({ ...turn, ts: Date.now() });
  },
  context: () => ({ history: history.slice(-12), notes: [] }),
  addNote() {},
  flush() {},
};
const limits = { gate: () => ({ ok: true }), spend() {}, noteReply() {}, flush() {} };

const engine = createEngine({
  cfg,
  persona: '你是测试助手，请按指令简洁回答。',
  llm,
  transport,
  store,
  limits,
  log: () => {},
});

const evt = (i) => ({
  post_type: 'message',
  self_id: 70109,
  time: Math.floor(Date.now() / 1000),
  message_type: 'group',
  group_id: Number(GROUP),
  sender: { user_id: 10001, nickname: '测试群友' },
  message_id: 500 + i,
  message: [
    { type: 'at', data: { qq: '70109' } },
    { type: 'text', data: { text: ` 第 ${i} 条测试消息` } },
  ],
});

console.log('\n  口头禅频率验收');
console.log('  ─────────────────────────────');

for (let i = 1; i <= 3; i += 1) {
  // 不能用 dry：dry 会在发送前就 return，口头禅统计压根记不上
  await engine.handle(evt(i));
}

const hit = prompts
  .slice(1)
  .some((p) => p.includes('「我超」') && (p.includes('换别的词') || p.includes('绝对不许出现')));
console.log(`  共生成 ${prompts.length} 次提示词`);
console.log(`  ${hit ? '✓' : '✗'} 第二句起就带了「换别的词」的指令`);
if (!hit) {
  console.log(`    最后一次提示词尾部：${JSON.stringify((prompts[prompts.length - 1] ?? '').slice(-160))}`);
}
console.log('  ─────────────────────────────');
console.log(`  ${hit ? '✓ 通过' : '✗ 失败'}\n`);
process.exit(hit ? 0 : 1);
