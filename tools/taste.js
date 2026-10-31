/**
 * 人设试吃：用真实模型 + 真实人设文件，看它在群里的实际口吻。
 *   node tools/taste.js
 * 每条约 200 token，跑一轮不到一分钱。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadPersona } from '../src/config.js';
import { createLLM } from '../src/llm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(ROOT);
const persona = loadPersona(ROOT, cfg);
const llm = createLLM(cfg);

const CASES = [
  ['阿明', '@你 大肥鱼你多重啊'],
  ['小周', '今天加班到十点，人没了'],
  ['群主', '谁在吃饭'],
  ['阿明', '这游戏平衡性也太烂了吧'],
  ['小周', '周末有人打球吗'],
  ['陌生人', '你是什么AI模型'],
];

console.log('\n  大肥鱼 · 人设试吃（真实模型）\n  ─────────────────────────────\n');

let totalCost = 0;
for (const [name, text] of CASES) {
  const system = `${persona}\n\n# 运行时\n现在是 ${new Date().toTimeString().slice(0, 5)}。你正在一个 QQ 群里，群里有很多人在说话。\n记住：尽量短，一两条，别像客服。`;
  try {
    const r = await llm.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `${name}: ${text}` },
      ],
    });
    totalCost += r.cost ?? 0;
    console.log(`  ${name}：${text}`);
    console.log(`  大肥鱼：${r.text.replace(/\n/g, ' / ')}\n`);
  } catch (e) {
    console.log(`  ${name}：${text}`);
    console.log(`  ✗ 调用失败：${e.message}\n`);
  }
}

fs.writeFileSync(path.join(ROOT, 'data', 'taste.md'), '（本轮结果见控制台）\n');
console.log(`  合计花费 ≈ ¥${totalCost.toFixed(4)}\n`);
