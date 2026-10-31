import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  onebot: { ws: 'ws://127.0.0.1:8080', accessToken: '', autoAcceptInvite: false, reconnectDelayMs: 3000 },
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    judgeModel: 'deepseek-chat',
    temperature: 1.1,
    maxTokens: 200,
    timeoutMs: 45000,
  },
  persona: { file: 'persona/dafeiyu.md', selfName: '大肥鱼' },
  trigger: {
    alwaysReplyMention: true,
    alwaysReplyPrivate: true,
    interjectRate: 0.05,
    interjectMinGapSec: 300,
    interjectMinChars: 5,
    // 「饿」模型：多久之内插话概率从 interjectRate 涨到 100%。0 = 关闭（纯固定概率）
    interjectRampSec: 0,
    keywordWake: [],
    ignoreUserIds: [],
  },
  reply: { maxChars: 60, maxSegments: 2, typingCharsPerSec: 7, segmentGapMs: [400, 1200] },
  // 主动 @ 群友（叫他哥哥/姐姐）。groups 为空 = 关掉
  proactiveAt: {
    groups: [],
    everySec: 600,
    minGapAfterBotSec: 120,
    onlyRecentSec: 900,
    personCooldownSec: 1800,
    maxPerHour: 6,
  },
  judge: { enabled: true },
  context: { maxTurns: 24, maxChars: 700, maxAgeSec: 600 },
  memory: { noteCount: 3, noteMaxChars: 120 },
  limits: {
    dailyBudgetCny: 3,
    totalBudgetCny: 50,
    groupCooldownSec: 15,
    maxRepliesPerGroupPerHour: 40,
    quietHours: [],
  },
  pricing: { inputPerMillion: 2, outputPerMillion: 8 },
  whitelist: { groups: [], friends: [] },
  mutedGroups: [],
  singing: { enabled: false, dataDir: 'data/singing', timeoutSec: 900, cooldownSec: 20, maxPending: 3, targetDurationSec: 20 },
};

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig(rootDir) {
  const candidates = ['config.json', 'config.local.json', 'config.example.json'];
  let file = null;
  for (const c of candidates) {
    const p = path.join(rootDir, c);
    if (fs.existsSync(p)) {
      file = p;
      break;
    }
  }
  if (!file) {
    throw new Error(`找不到配置文件。请先复制 config.example.json 为 config.json：\n  cp config.example.json config.json`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`配置文件 ${path.basename(file)} 不是合法 JSON：${e.message}`);
  }
  const cfg = deepMerge(DEFAULTS, raw);
  cfg.__file = file;

  const problems = [];
  if (!cfg.llm.apiKey) problems.push('llm.apiKey 为空（可用 --dry 先跑模拟）');
  if (!cfg.onebot.ws) problems.push('onebot.ws 为空');
  cfg.__problems = problems;
  return cfg;
}

export function loadPersona(rootDir, cfg) {
  const p = path.isAbsolute(cfg.persona.file) ? cfg.persona.file : path.join(rootDir, cfg.persona.file);
  if (!fs.existsSync(p)) throw new Error(`人设文件不存在：${p}`);
  return fs.readFileSync(p, 'utf8');
}
