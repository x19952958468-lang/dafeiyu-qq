/**
 * 人设切换：把 persona/variants/<名字>.md 装到 persona/dafeiyu.md 上。
 *   node tools/persona.js            # 看有哪些形态、当前用的是哪个
 *   node tools/persona.js use friendly
 *   node tools/persona.js use concise
 * 换完要重启引擎才生效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { applyPersonaProfile } from '../src/persona-profile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTIVE = path.join(ROOT, 'persona', 'dafeiyu.md');
const DIR = path.join(ROOT, 'persona', 'variants');

const cfg = loadConfig(ROOT);
const activeFile = path.isAbsolute(cfg.persona.file) ? cfg.persona.file : path.join(ROOT, cfg.persona.file);
const activeText = fs.existsSync(activeFile) ? fs.readFileSync(activeFile, 'utf8') : '';

const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.md')) : [];
const current = files.find((f) => fs.readFileSync(path.join(DIR, f), 'utf8') === activeText);

const cmd = process.argv[2];
const name = process.argv[3];

/**
 * 每个形态配套的采样温度。
 * 如需固定采样参数，可为自己的形态添加同名 .profile.json。
 */
const TEMPS = {};
const DEFAULT_TEMP = 0.85;

if (cmd === 'use') {
  if (!name) {
    console.log('用法：node tools/persona.js use <名字>');
    process.exit(1);
  }
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('人设名只能包含小写字母、数字和连字符');
  const src = path.join(DIR, `${name}.md`);
  if (!fs.existsSync(src)) {
    console.log(`没有这个形态：${name}`);
    console.log(`可选：${files.map((f) => f.replace(/\.md$/, '')).join(', ')}`);
    process.exit(1);
  }
  const profileFile = path.join(DIR, `${name}.profile.json`);
  const raw = JSON.parse(fs.readFileSync(cfg.__file, 'utf8'));
  if (fs.existsSync(profileFile)) {
    applyPersonaProfile(raw, JSON.parse(fs.readFileSync(profileFile, 'utf8')));
    console.log('  ✓ 已恢复配套语气、招牌词和主动搭话规则');
  } else {
    raw.llm = { ...(raw.llm ?? {}), temperature: TEMPS[name] ?? DEFAULT_TEMP };
  }
  raw.persona = { ...raw.persona, activatedAt: Date.now() };
  fs.copyFileSync(src, activeFile);
  console.log(`\n  ✓ 已切到「${name}」→ ${path.relative(ROOT, activeFile)}`);
  const configTmp = cfg.__file + '.tmp';
  fs.writeFileSync(configTmp, `${JSON.stringify(raw, null, 2)}\n`);
  fs.renameSync(configTmp, cfg.__file);

  // 归档旧会话记忆，避免新形态顺着旧口气接着说。
  const sessDir = path.join(ROOT, 'data', 'sessions');
  const archiveDir = path.join(ROOT, 'data', 'persona-session-archives', `${raw.persona.activatedAt}-${current?.replace(/\.md$/, '') ?? 'custom'}`);
  let cleared = 0;
  if (fs.existsSync(sessDir)) {
    for (const f of fs.readdirSync(sessDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        fs.mkdirSync(archiveDir, { recursive: true });
        fs.renameSync(path.join(sessDir, f), path.join(archiveDir, f));
        cleared += 1;
      } catch {
        /* ignore */
      }
    }
  }
  if (cleared) console.log(`  ✓ 已归档 ${cleared} 份旧会话记忆（新形态重新积累上下文）`);

  console.log('  ▸ 重启引擎生效：');
  console.log('    在正在运行机器人的终端按 Ctrl+C，然后执行 npm start。\n');
  process.exit(0);
}

console.log(`\n  当前形态：${current ? current.replace(/\.md$/, '') : '（自定义，不在 variants 里）'}`);
console.log(`  生效文件：${path.relative(ROOT, activeFile)}`);
console.log('  ─────────────────────────────');
for (const f of files) {
  const n = f.replace(/\.md$/, '');
  const first = fs
    .readFileSync(path.join(DIR, f), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('你是「')) || '';
  console.log(`  ${n === (current || '').replace(/\.md$/, '') ? '●' : '○'} ${n}  ${first.slice(0, 42)}`);
}
console.log('  ─────────────────────────────');
console.log('  切换：node tools/persona.js use <名字>\n');
