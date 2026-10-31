// Local preview only: uses the configured LLM and speech backend, never QQ.
// node tools/preview-emotional-voice.js "今天过得怎么样？" "温柔地说"
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpeech } from '../src/speech/index.js';
import { createSpeechBackend } from '../src/speech-backend.js';
import { createHeavyCompute } from '../src/heavy-compute.js';
import { loadConfig } from '../src/config.js';
import { createLLM } from '../src/llm.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'data/speech/previews');
const cfg = loadConfig(root), llm = createLLM(cfg);
if (llm.dry) throw new Error('请先配置 LLM API Key；语音预览需要模型生成台词分段计划。');
const speechConfig = JSON.parse(await fs.readFile(path.join(root, 'data/speech/config.json'), 'utf8'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dafeiyu-voice-preview-'));
const backend = createSpeechBackend({ rootDir: root, log: console.log });
const compute = createHeavyCompute();
const speech = createSpeech({ rootDir: temp, cfg, llm,
  ensureBackendReady: backend.ensureReady, stopBackend: backend.stop,
  acquireHeavy: compute.acquire, log: console.log });
const start = Date.now();
try {
  speech.updateConfig({ ...speechConfig, enabled: true });
  for (const name of ['emotion-profiles.json', 'preview-profiles.json']) {
    try { await fs.copyFile(path.join(root, 'data/speech', name), path.join(temp, 'data/speech', name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const result = await speech.preview({
    text: process.argv[2] || '你回来了，今天过得怎么样？',
    userText: process.argv[3] || '温柔地说',
  });
  if (result.mode !== 'voice') throw new Error(`Speech preview failed: ${result.reason}`);
  await fs.mkdir(out, { recursive: true });
  const file = path.join(out, `preview-${Date.now()}.mp3`);
  await fs.writeFile(file, result.audio, { mode: 0o600 });
  const report = { mode: result.mode, text: result.spokenText, style: result.style, bytes: result.audio.length,
    elapsedSeconds: (Date.now() - start) / 1000, file, externalMessages: 0 };
  await fs.writeFile(file.replace(/\.mp3$/, '.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
} finally {
  await speech.stop(); await backend.stop(); compute.stop();
  await fs.rm(temp, { recursive: true, force: true });
}
