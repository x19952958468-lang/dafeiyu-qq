import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadPersona } from './config.js';
import { createLLM } from './llm.js';
import { createStore } from './memory.js';
import { createLimits } from './limits.js';
import { createTransport } from './onebot.js';
import { createEngine } from './pipeline.js';
import { createPoker } from './poke.js';
import { hydrateGroups } from './hydrate.js';
import { createRequestHandler } from './requests.js';
import { createSinger } from './singing.js';
import { startBilibili } from './bilibili/index.js';
import { createSpeech, createReplyDelivery } from './speech/index.js';
import { createSpeechBackend } from './speech-backend.js';
import { createHeavyCompute } from './heavy-compute.js';
import { createPersonaEditor } from './persona-editor.js';
import { createActions } from './actions.js';
import { createQqActions } from './qq-actions.js';
import { recentGroupTargets } from './action-context.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

function ts() {
  return new Date().toTimeString().slice(0, 8);
}
const log = (...a) => console.log(`[${ts()}]`, ...a);

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    console.error(`需要 Node.js 22 及以上（当前 ${process.versions.node}）。原生 WebSocket 依赖 22+。`);
    process.exit(1);
  }

  const cfg = loadConfig(ROOT);
  if (path.basename(cfg.__file) === 'config.example.json') {
    throw new Error('请先运行 npm run setup，填写 config.json 后再启动。');
  }
  const persona = loadPersona(ROOT, cfg);
  const llm = createLLM(cfg);
  const store = createStore({ dir: DATA, ctx: cfg.context, mem: cfg.memory });
  const limits = createLimits({ dir: DATA, cfg });
  const transport = createTransport({ cfg, log });
  const compute = createHeavyCompute();
  const backend = createSpeechBackend({ rootDir: ROOT, log });
  const speech = createSpeech({ rootDir: ROOT, cfg, llm, log, acquireHeavy: compute.acquire,
    onCost: cost => limits.spend(cost),
    ensureBackendReady: backend.ensureReady, stopBackend: backend.stop });
  const deliverReply = createReplyDelivery({ speech, transport, log });
  const singer = createSinger({ rootDir: ROOT, cfg, transport, log, acquireHeavy: compute.acquire });
  await singer.start();
  let bili = null;
  const getRecentTargets = () => recentGroupTargets({ cfg, store });
  const qqActions = createQqActions({ cfg, transport, store, getOwner: () => bili?.getConfig().ownerQq,
    getRecentTargets, dataDir: path.join(DATA, 'actions'), log });
  const actions = createActions({ rootDir: ROOT, cfg, llm, singer, getBilibili: () => bili,
    getRecentTargets, qqActions, transport, store, limits, log });
  const engine = createEngine({ cfg, persona, llm, transport, store, limits, singer, actions, speech, deliverReply, log,
    getConversationContext: evt => bili?.getConversationContext(evt) });
  const personaEditor = createPersonaEditor({ rootDir: ROOT, cfg, onApply: ({ text }) => {
    engine.updatePersona(text);
    log('[persona] 用户编辑的人设已即时加载');
  } });
  const handleRequest = createRequestHandler({ transport, cfg, log });
  bili = await startBilibili({ rootDir: ROOT, cfg, llm, limits, transport, store, log, speech, deliverReply,
    acquireHeavy: compute.acquire, personaEditor })
    .catch(() => { log('[bilibili] 视频模块启动失败；聊天和唱歌继续运行'); return null; });

  console.log('');
  console.log('  大肥鱼 · QQ 群陪聊');
  console.log('  ─────────────────────────────');
  console.log(`  配置      ${path.basename(cfg.__file)}`);
  console.log(`  模型      ${cfg.llm.model}${llm.dry ? '（dry：未填 API Key，只会回预设话）' : ''}`);
  console.log(`  协议端    ${cfg.onebot.ws}`);
  console.log(`  触发      群内 @ / 关键词 / ${Math.round((cfg.trigger.interjectRate ?? 0) * 100)}% 概率插话`);
  console.log(`  预算      ¥${cfg.limits.dailyBudgetCny}/天，总计 ¥${cfg.limits.totalBudgetCny}`);
  console.log(
    `  白名单    ${cfg.whitelist.groups.length ? `群 ${cfg.whitelist.groups.join(',')}` : '群：未限制（全部群都会响应）'}`,
  );
  console.log('');
  for (const p of cfg.__problems) log(`⚠ ${p}`);

  transport.setEventHandler((evt) => {
    if (evt.post_type === 'request') {
      handleRequest(evt).catch((e) => log(`请求处理异常：${e.stack || e.message}`));
      return;
    }
    (async () => {
      if (bili && await bili.handleEvent(evt)) return;
      await engine.handle(evt);
    })().catch((e) => log(`处理异常：${e.stack || e.message}`));
  });
  let hydrated = false;
  transport.setStatusHandler(async ({ connected }) => {
    if (!connected) return;
    const r = await transport.getLoginInfo();
    if (r.ok) log(`登录账号 ${r.data.nickname ?? ''}（${r.data.user_id}）`);
    else log('已连接，但取不到登录信息（协议端可能还在登录中）');

    if (!hydrated && r.ok) {
      hydrated = true;
      await hydrateGroups({ cfg, transport, store, log }).catch((e) => log(`回填上下文失败：${e.message}`));
    }
  });

  transport.connect();

  const poker = createPoker({ cfg, engine, limits, transport, log });
  poker.start(45);

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    log(`收到 ${sig}，正在退出…`);
    poker.stop();
    transport.close();
    compute.stop();
    await Promise.allSettled([speech.stop(), bili?.stop()]);
    await backend.stop().catch(() => {});
    store.flush();
    limits.flush();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(`启动失败：${e.message}`);
  process.exit(1);
});
