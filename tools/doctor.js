/**
 * 自检：启动前先跑这个，把能提前发现的问题都查一遍。
 *   node tools/doctor.js
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadPersona } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ⚠ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);

let failed = 0;

console.log('\n  大肥鱼 · 环境自检\n  ─────────────────────────────');

const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) ok(`Node.js ${process.versions.node}（原生 WebSocket 可用）`);
else {
  bad(`Node.js ${process.versions.node} 过低，需要 22+`);
  failed += 1;
}

let cfg;
try {
  cfg = loadConfig(ROOT);
  ok(`配置已加载：${path.basename(cfg.__file)}`);
} catch (e) {
  bad(e.message);
  process.exit(1);
}

try {
  const p = loadPersona(ROOT, cfg);
  ok(`人设已加载：${cfg.persona.file}（${p.length} 字符）`);
} catch (e) {
  bad(e.message);
  failed += 1;
}

if (cfg.llm.apiKey) ok('API Key 已配置');
else warn('API Key 未填：现在只能 dry 运行，不会真聊天');

console.log('\n  连通性');
if (cfg.llm.apiKey) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(`${cfg.llm.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.llm.apiKey}` },
      body: JSON.stringify({ model: cfg.llm.model, messages: [{ role: 'user', content: '在' }], max_tokens: 4 }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.ok) ok(`模型接口可达（${cfg.llm.model}）`);
    else bad(`模型接口返回 ${res.status}：${(await res.text()).slice(0, 160)}`);
  } catch (e) {
    bad(`模型接口不可达：${e.message}`);
  }
} else {
  warn('跳过模型连通性检查');
}

await new Promise((resolve) => {
  let done = false;
  const finish = (m) => {
    if (done) return;
    done = true;
    m();
    resolve();
  };
  let ws;
  try {
    ws = new WebSocket(cfg.onebot.ws);
  } catch (e) {
    finish(() => bad(`协议端地址非法：${e.message}`));
    return;
  }
  const timer = setTimeout(() => {
    try {
      ws.close();
    } catch {}
    finish(() => warn(`协议端 ${cfg.onebot.ws} 10 秒内没连上（先把 Lagrange/NapCat 启动并登录）`));
  }, 10000);
  ws.addEventListener('open', () => {
    clearTimeout(timer);
    try {
      ws.close();
    } catch {}
    finish(() => ok(`协议端可达：${cfg.onebot.ws}`));
  });
  ws.addEventListener('error', () => {
    clearTimeout(timer);
    finish(() => warn(`协议端 ${cfg.onebot.ws} 连不上（是不是还没启动？）`));
  });
});

if (!fs.existsSync(path.join(ROOT, 'data'))) warn('data/ 目录还没生成，首次启动会自动建');

console.log('');
if (failed) {
  console.log(`  有 ${failed} 项必须先修，修完再启动。\n`);
  process.exit(1);
}
console.log('  自检通过。启动：node src/index.js\n');
