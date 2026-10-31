/**
 * 判定层抽查：用真模型跑几条 transcript，看 L1「接/不接」判得合不合理。
 *   node tools/judge-taste.js
 * 约 4 次小请求，成本可忽略。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createLLM } from '../src/llm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(ROOT);
const llm = createLLM(cfg);
const self = cfg.persona.selfName;

const cases = [
  { want: '接', t: `阿明: 今天中午吃啥\n小红: 食堂那个鸡腿饭还行\n阿明: 有点想吃米饭了` },
  { want: '接', t: `老板: 这个需求明天能上吗\n阿明: 我尽量\n小刚: 又加班，累死了` },
  { want: '不接', t: `阿明: 你上次说的那个接口文档在哪\n小红: 我发你\n阿明: 收到` },
  { want: '不接', t: `阿明: 哈哈哈哈哈哈哈哈\n小红: ？？？\n阿明: 草草草草草` },
];

console.log(`\n  大肥鱼 · 判定层抽查（${self}）`);
console.log('  ─────────────────────────────');
let hit = 0;
for (const c of cases) {
  const ok = await llm.shouldReply({ transcript: c.t, selfName: self });
  const got = ok ? '接' : '不接';
  const pass = got === c.want;
  if (pass) hit += 1;
  console.log(`  ${pass ? '✓' : '✗'} 预期 ${c.want} / 实际 ${got}`);
  console.log(`      ${c.t.split('\n').join(' | ')}`);
}
console.log('  ─────────────────────────────');
console.log(`  ${hit}/${cases.length} 符合预期\n`);
