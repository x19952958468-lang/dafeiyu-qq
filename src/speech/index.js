import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { selectEmotion, wantsSpeech, declinesSpeech, continuesSpeech } from './emotion.js';
import { parseSpeechDirection } from './direction.js';
import { prepareSpeechText, prepareVocalizedText, readParenthesesLiterally } from './spoken-text.js';
import { parseSpeechPlan } from './plan.js';
import { FFMPEG } from '../paths.js';
export { createReplyDelivery } from './reply-delivery.js';

export const SPEECH_DEFAULTS = {
  enabled: false, mode: 'auto', autoRate: .3, intensity: .65, maxChars: 160,
  backendUrl: 'http://127.0.0.1:6197/v1/audio/speech',
  referenceAudio: '', referenceText: '', voiceId: '',
  ffmpeg: FFMPEG,
  requestTimeoutMs: 120000, queueTimeoutMs: 120000, cfgScale: 3, seed: 42,
};
const MAX_PCM_BYTES = 16 * 1024 * 1024;
const FRAME_SECONDS = .08, SAMPLE_RATE = 24000;
const CONTINUATION_MS = 5 * 60000, CONTINUATION_TURNS = 3;
const PREVIEW_PROFILE_ID = /^[a-z][a-z0-9-]{0,47}$/;
const REFERENCE_PROFILE_FIELDS = ['referenceAudio', 'referenceText', 'cfgScale', 'instruction'];
const EMOTION_PROFILES = new Set(['happy', 'sad', 'annoyed', 'gentle', 'playful', 'surprised']);

/** A complete-utterance budget, never a request to cut an utterance at this length. */
export function speechTokenBudget(text, requestTimeoutMs = SPEECH_DEFAULTS.requestTimeoutMs) {
  const units = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Number}]/gu) || []).length;
  const words = (text.match(/[\p{Script=Latin}]+(?:['’][\p{Script=Latin}]+)*/gu) || []).length;
  const pauses = (text.match(/[，。！？；：,.!?;:]/g) || []).length;
  // Slow emotional speech has more pauses than reading; reserve room for a complete ending.
  const seconds = Math.max(30, 3 + units * .4 + words * .65 + pauses * .2);
  // Keep time for cold start/encoding and reject oversized prose before loading the model.
  const maxSeconds = Math.min(90, Math.max(0, (requestTimeoutMs / 1000 - 20) * .9));
  if (seconds > maxSeconds) return null;
  return Math.ceil(seconds / FRAME_SECONDS);
}

export function validateSpeechPcm(pcm, maxNewTokens) {
  if (pcm.length < 2400 || pcm.length % 2) throw new Error('INVALID_AUDIO');
  const duration = pcm.length / 2 / SAMPLE_RATE;
  // Breeze can terminate normally at its token ceiling. Never send that partial sentence.
  if (duration >= (maxNewTokens - 2) * FRAME_SECONDS) throw new Error('TRUNCATED_AUDIO');
  let power = 0;
  for (let i = 0; i < pcm.length; i += 2) { const value = pcm.readInt16LE(i); power += value * value; }
  if (Math.sqrt(power / (pcm.length / 2)) / 32768 < .0001) throw new Error('SILENT_AUDIO');
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function validateReferenceProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !REFERENCE_PROFILE_FIELDS.includes(key) && !['variant', 'vocalization'].includes(key)) ||
      REFERENCE_PROFILE_FIELDS.some(key => !Object.hasOwn(value, key))) throw new Error('INVALID_PREVIEW');
  const { referenceAudio, referenceText, cfgScale, instruction } = value;
  if (Object.hasOwn(value, 'variant') && !['8bit', 'mixed'].includes(value.variant)) throw new Error('INVALID_PREVIEW');
  if (Object.hasOwn(value, 'vocalization') && value.vocalization !== 'sob') throw new Error('INVALID_PREVIEW');
  if (typeof referenceAudio !== 'string' || referenceAudio.length > 10000 || referenceAudio.includes('\0') || !path.isAbsolute(referenceAudio) ||
      typeof referenceText !== 'string' || !referenceText.trim() || referenceText.length > 10000 || referenceText.includes('\0') ||
      !Number.isFinite(cfgScale) || cfgScale < 0 || cfgScale > 5 ||
      typeof instruction !== 'string' || instruction.length > 2000 || instruction.includes('\0')) throw new Error('INVALID_PREVIEW');
  try {
    const stat = fs.statSync(referenceAudio);
    if (!stat.isFile() || stat.size === 0 || stat.size > 20 * 1024 * 1024) throw new Error('INVALID_PREVIEW');
    fs.accessSync(referenceAudio, fs.constants.R_OK);
  } catch { throw new Error('INVALID_PREVIEW'); }
  return { referenceAudio, referenceText, cfgScale, instruction, variant: value.variant || '8bit', vocalization: value.vocalization };
}
function readPreviewProfile(dir, id) {
  if (typeof id !== 'string' || id.trim() !== id || !PREVIEW_PROFILE_ID.test(id)) throw new Error('INVALID_PREVIEW');
  const profiles = readJson(path.join(dir, 'preview-profiles.json'), null);
  const value = profiles && typeof profiles === 'object' && !Array.isArray(profiles) && Object.hasOwn(profiles, id) ? profiles[id] : null;
  return validateReferenceProfile(value);
}
function readEmotionProfile(dir, emotion, log) {
  let contents;
  try { contents = fs.readFileSync(path.join(dir, 'emotion-profiles.json'), 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') log('[speech] emotion voice profile unavailable; using default voice');
    return null;
  }
  try {
    const profiles = JSON.parse(contents);
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) throw new Error('INVALID_PROFILE');
    return Object.hasOwn(profiles, emotion) ? validateReferenceProfile(profiles[emotion]) : null;
  } catch {
    log('[speech] emotion voice profile unavailable; using default voice');
    return null;
  }
}
function applyReferenceProfile(snapshot, profile) {
  snapshot.referenceAudio = profile.referenceAudio;
  snapshot.referenceText = profile.referenceText;
  snapshot.cfgScale = profile.cfgScale;
  snapshot.voiceId = '';
  snapshot.backendVariant = profile.variant;
  snapshot.vocalization = profile.vocalization;
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
function safeBackend(value) {
  const u = new URL(value);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash) throw new Error('INVALID_BACKEND');
  return u.href;
}
export function validateSpeechConfig(patch, old = SPEECH_DEFAULTS) {
  if (!patch || Array.isArray(patch) || typeof patch !== 'object') throw new Error('INVALID_SETTINGS');
  const next = { ...old };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in SPEECH_DEFAULTS)) throw new Error('UNKNOWN_SETTING');
    if (key === 'enabled' && typeof value !== 'boolean') throw new Error('INVALID_ENABLED');
    if (key === 'mode' && !['auto', 'voice', 'text'].includes(value)) throw new Error('INVALID_MODE');
    if (['autoRate', 'intensity'].includes(key) && (!Number.isFinite(value) || value < 0 || value > 1)) throw new Error('INVALID_RATIO');
    if (key === 'maxChars' && (!Number.isInteger(value) || value < 20 || value > 500)) throw new Error('INVALID_LENGTH');
    if (['requestTimeoutMs', 'queueTimeoutMs'].includes(key) && (!Number.isInteger(value) || value < 1000 || value > 600000)) throw new Error('INVALID_TIMEOUT');
    if (key === 'cfgScale' && (!Number.isFinite(value) || value < 1 || value > 5)) throw new Error('INVALID_CFG');
    if (key === 'seed' && (!Number.isInteger(value) || value < 0 || value > 2147483647)) throw new Error('INVALID_SEED');
    if (['referenceAudio', 'referenceText', 'voiceId', 'ffmpeg', 'backendUrl'].includes(key) && (typeof value !== 'string' || value.length > 10000 || value.includes('\0'))) throw new Error('INVALID_TEXT_SETTING');
    next[key] = key === 'backendUrl' ? safeBackend(value) : value;
  }
  return next;
}

export function runFfmpeg(executable, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: 'ignore' });
    let force;
    const abort = () => { child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), 1500); force.unref(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', () => { signal?.removeEventListener('abort', abort); clearTimeout(force); reject(new Error('ENCODER_FAILED')); });
    child.on('close', code => { signal?.removeEventListener('abort', abort); clearTimeout(force);
      code === 0 && !signal?.aborted ? resolve() : reject(new Error('ENCODER_FAILED')); });
  });
}

export function createSpeech({ rootDir, cfg, llm, log = () => {}, acquireHeavy,
  onCost = () => {},
  ensureBackendReady = async () => {}, stopBackend = async () => {},
  fetchImpl = fetch, runImpl = runFfmpeg, now = Date.now, random = Math.random } = {}) {
  const dir = path.join(rootDir, 'data/speech');
  const configFile = path.join(dir, 'config.json'), stateFile = path.join(dir, 'state.json');
  let config;
  try { config = validateSpeechConfig(readJson(configFile, {})); } catch { config = { ...SPEECH_DEFAULTS }; }
  const saved = readJson(stateFile, {});
  const state = { moods: saved.moods || {}, voices: saved.voices || {}, messages: saved.messages || {}, lastGeneratedAt: saved.lastGeneratedAt || 0 };
  let stopped = false, busy = false, queued = 0, lastError = '';
  let queue = Promise.resolve();
  const controllers = new Set(), inFlight = new Set();
  const latestCalls = new Map();
  const verifiedResults = new WeakMap();
  const persist = () => writeJson(stateFile, state);
  function configured(snapshot = config) {
    if (snapshot.voiceId.trim()) return true;
    try { return !!snapshot.referenceText.trim() && fs.statSync(snapshot.referenceAudio).isFile(); } catch { return false; }
  }
  function status() { return { enabled: config.enabled, available: true, ready: !stopped && configured(), busy, queued, lastError, lastGeneratedAt: state.lastGeneratedAt }; }
  function updateConfig(patch) {
    config = validateSpeechConfig(patch, config); writeJson(configFile, config);
    if (!config.enabled || config.mode === 'text') for (const controller of controllers) controller.abort();
    return { ...config };
  }
  function lookup(messageId, key) {
    const r = state.messages[String(messageId)];
    return r && (!key || r.key === key) ? { ...r } : null;
  }
  function remember(messageId, text, key) {
    if (messageId == null || !/^[pg]:\d{1,20}$/.test(key) || typeof text !== 'string' || !text || text.length > 5000) return;
    state.messages[String(messageId)] = { text, key, time: now() };
    const entries = Object.entries(state.messages).sort((a, b) => a[1].time - b[1].time);
    state.messages = Object.fromEntries(entries.slice(-500)); persist();
  }
  async function produce({ text, spokenText, modelText, style, snapshot, controller, maxNewTokens }) {
    const signal = controller.signal;
    let release, folder, generationTimer;
    let backendTouched = false;
    try {
      signal.throwIfAborted();
      release = acquireHeavy ? await acquireHeavy({ kind: 'speech', signal, timeoutMs: snapshot.queueTimeoutMs }) : async () => {};
      signal.throwIfAborted();
      generationTimer = setTimeout(() => controller.abort(), snapshot.requestTimeoutMs); generationTimer.unref();
      backendTouched = true;
      let variant = snapshot.backendVariant || '8bit';
      try { await ensureBackendReady({ signal, variant }); }
      catch (error) {
        if (variant !== 'mixed' || signal.aborted) throw error;
        // The same lease remains held until the failed process is confirmed gone.
        await stopBackend({});
        signal.throwIfAborted();
        log('[speech] mixed backend unavailable; retrying with 8bit');
        variant = '8bit';
        await ensureBackendReady({ signal, variant });
      }
      signal.throwIfAborted();
      style = { ...style, backendVariant: variant };
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      folder = fs.mkdtempSync(path.join(dir, 'render-'));
      const form = new FormData();
      form.set('text', modelText); form.set('instruction', style.instruction);
      form.set('cfg_scale', String(snapshot.cfgScale)); form.set('seed', String(snapshot.seed));
      form.set('max_new_tokens', String(maxNewTokens));
      if (snapshot.voiceId.trim()) form.set('voice_id', snapshot.voiceId.trim());
      else {
        const stat = fs.statSync(snapshot.referenceAudio);
        if (stat.size > 20 * 1024 * 1024) throw new Error('REFERENCE_TOO_LARGE');
        const ref = fs.readFileSync(snapshot.referenceAudio);
        form.set('ref_audio', new Blob([ref], { type: 'audio/wav' }), path.basename(snapshot.referenceAudio));
        form.set('ref_text', snapshot.referenceText);
      }
      const response = await fetchImpl(snapshot.backendUrl, { method: 'POST', body: form, signal, redirect: 'error' });
      if (!response.ok || !response.body) throw new Error('BACKEND_FAILED');
      if (/json|^text\//i.test(response.headers.get('content-type') || '')) throw new Error('INVALID_AUDIO');
      if (Number(response.headers.get('content-length')) > MAX_PCM_BYTES) throw new Error('AUDIO_TOO_LARGE');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length; if (size > MAX_PCM_BYTES) { await response.body.cancel?.().catch(() => {}); throw new Error('AUDIO_TOO_LARGE'); }
        chunks.push(Buffer.from(chunk));
      }
      const pcm = Buffer.concat(chunks);
      validateSpeechPcm(pcm, maxNewTokens);
      const input = path.join(folder, 'speech.pcm'), output = path.join(folder, 'speech.mp3');
      fs.writeFileSync(input, pcm, { mode: 0o600 });
      await runImpl(snapshot.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', input,
        '-c:a', 'libmp3lame', '-b:a', '96k', output], { signal });
      signal.throwIfAborted();
      const audio = fs.readFileSync(output);
      if (audio.length < 100 || !(audio.toString('ascii', 0, 3) === 'ID3' || (audio[0] === 255 && (audio[1] & 224) === 224))) throw new Error('INVALID_AUDIO');
      state.lastGeneratedAt = now(); lastError = ''; persist();
      return { mode: 'voice', audio, text, spokenText, style };
    } finally {
      clearTimeout(generationTimer);
      if (folder) fs.rmSync(folder, { recursive: true, force: true });
      // stopBackend must confirm process exit before the heavy-compute lease is released.
      if (backendTouched) await stopBackend({});
      if (release) await release();
    }
  }
  // Profile overrides are a separate, private argument. Public synthesis inputs
  // cannot select a profile or inject arbitrary snapshot fields.
  async function render({ key, text, userText = '', factual = false, source = 'chat', explicit = false, allowAuto = true, preview = false } = {}, previewProfile = null) {
    if (typeof text !== 'string') throw new Error('INVALID_TEXT');
    const fallback = reason => ({ mode: 'text', text, reason });
    if (!/^[pg]:\d{1,20}$/.test(key || '')) return fallback('INVALID_CONVERSATION');
    const callId = crypto.randomUUID(), stamp = now();
    if (!preview) { latestCalls.delete(key); latestCalls.set(key, callId); }
    if (latestCalls.size > 500) latestCalls.delete(latestCalls.keys().next().value);
    const direct = explicit || wantsSpeech(userText);
    const priorVoice = preview ? null : state.voices[key];
    const continuation = !factual && !direct && continuesSpeech(userText) && priorVoice &&
      priorVoice.remaining > 0 && stamp >= priorVoice.time && stamp < priorVoice.expiresAt;
    // Three follow-ups within a fixed five-minute window; unrelated topics close it.
    if (!preview) {
      if (continuation) priorVoice.remaining--;
      else delete state.voices[key];
      state.voices = Object.fromEntries(Object.entries(state.voices).filter(([, v]) => v.expiresAt > stamp).slice(-500));
      persist();
    }
    if (stopped || !config.enabled || config.mode === 'text') return fallback('DISABLED');
    const snapshot = { ...config };
    if (preview && previewProfile) applyReferenceProfile(snapshot, previewProfile);
    if (!configured(snapshot)) return fallback('VOICE_NOT_CONFIGURED');
    if (declinesSpeech(userText)) return fallback('TEXT_REQUESTED');
    if (!text.trim() || /https?:\/\/|www\.|\[CQ:/i.test(text)) return fallback('TEXT_REQUIRED');
    // Display/fallback text stays intact; stage directions never enter the audio transcript.
    const prepared = prepareSpeechText(text, { factual, userText });
    if (prepared.unsafeForVoice) return fallback('UNCERTAIN_SPOKEN_TEXT');
    let { spokenText } = prepared;
    if (!/[\p{L}\p{N}]/u.test(spokenText)) return fallback('NO_SPOKEN_TEXT');
    const requested = direct || continuation;
    if (spokenText.length > (requested ? 600 : config.maxChars) || (factual && spokenText.length > config.maxChars)) return fallback('LONG_TEXT');
    let maxNewTokens = speechTokenBudget(spokenText, config.requestTimeoutMs);
    if (maxNewTokens == null) return fallback('SPEECH_BUDGET_EXCEEDED');
    if (!requested && config.mode === 'auto' && !allowAuto) return fallback('TEXT_REQUIRED');
    if (!requested && config.mode === 'auto' && random() >= config.autoRate) return fallback('AUTO_TEXT');
    const controller = new AbortController();
    controllers.add(controller); queued++;
    const timeout = setTimeout(() => controller.abort(), snapshot.queueTimeoutMs + snapshot.requestTimeoutMs); timeout.unref();
    const job = queue.catch(() => {}).then(async () => {
      queued--; busy = true;
      try {
        if (stopped || !config.enabled || config.mode === 'text') return fallback('DISABLED');
        controller.signal.throwIfAborted();
        if (!factual && !readParenthesesLiterally(userText)) {
          try {
            if (typeof llm?.planSpeech !== 'function') throw new Error('PLAN_UNAVAILABLE');
            const planned = await llm.planSpeech({ text: spokenText, userText });
            if (planned.cost) onCost(planned.cost);
            controller.signal.throwIfAborted();
            const plan = parseSpeechPlan(planned.plan, spokenText);
            if (plan.decision !== 'speak') return fallback('UNCERTAIN_SPOKEN_TEXT');
            const checked = prepareSpeechText(plan.spokenText, { userText });
            if (checked.unsafeForVoice || checked.spokenText !== plan.spokenText) return fallback('UNCERTAIN_SPOKEN_TEXT');
            spokenText = plan.spokenText;
            maxNewTokens = speechTokenBudget(spokenText, snapshot.requestTimeoutMs);
            if (maxNewTokens == null) return fallback('SPEECH_BUDGET_EXCEEDED');
          } catch {
            if (controller.signal.aborted) throw new Error('SPEECH_TIMEOUT');
            log('[speech] dialogue separation unavailable; sending original text');
            return fallback('SPEECH_PLAN_UNAVAILABLE');
          }
        }
        const previous = preview ? undefined : state.moods[key];
        const stageDirection = prepared.emotionHint ? { emotion: prepared.emotionHint } : undefined;
        let style = selectEmotion({ userText, text: spokenText, factual, intensity: snapshot.intensity, previous,
          direction: stageDirection, now: now() });
        if (!previewProfile && !stageDirection && !factual && !['explicit', 'reset', 'continuation'].includes(style.source) && typeof llm?.directSpeech === 'function') {
          try {
            const directed = await llm.directSpeech({ text: spokenText, userText });
            if (directed.cost) onCost(directed.cost);
            if (directed.direction) style = selectEmotion({ userText, text: spokenText, factual, intensity: snapshot.intensity, previous,
              direction: parseSpeechDirection(directed.direction), now: now() });
          } catch { log('[speech] direction unavailable; using local delivery cues'); }
        }
        if (preview && previewProfile) style = { ...style, instruction: previewProfile.instruction };
        else if (!factual && EMOTION_PROFILES.has(style.emotion) && style.intensity > 0) {
          const emotionProfile = readEmotionProfile(dir, style.emotion, log);
          if (emotionProfile) {
            applyReferenceProfile(snapshot, emotionProfile);
            style = { ...style, instruction: emotionProfile.instruction, voiceProfile: style.emotion };
          }
        }
        controller.signal.throwIfAborted();
        const modelText = prepareVocalizedText(spokenText, { factual, userText,
          crying: snapshot.vocalization === 'sob' && style.emotion === 'sad' && style.intensity > 0 });
        const result = await produce({ text, spokenText, modelText, style, snapshot, controller, maxNewTokens });
        if (!preview) {
          state.moods[key] = { emotion: style.emotion, intensity: style.intensity, time: style.time };
          state.moods = Object.fromEntries(Object.entries(state.moods).sort((a, b) => a[1].time - b[1].time).slice(-500));
          persist();
        }
        const voiceProfile = previewProfile ? 'preview' : EMOTION_PROFILES.has(style.voiceProfile) ? style.voiceProfile : 'default';
        log(`[speech] delivery emotion=${style.emotion} source=${style.source || 'local'} intensity=${style.intensity} voiceProfile=${voiceProfile} backend=${result.style.backendVariant}`);
        if (!preview && direct && latestCalls.get(key) === callId) {
          state.voices[key] = { time: now(), expiresAt: now() + CONTINUATION_MS, remaining: CONTINUATION_TURNS };
          persist();
        }
        verifiedResults.set(result, Object.freeze({ text, spokenText, key, userText, factual, preview,
          audio: result.audio, audioHash: crypto.createHash('sha256').update(result.audio).digest('hex') }));
        return result;
      } catch (error) {
        if (stopped || !config.enabled || config.mode === 'text') return fallback('DISABLED');
        lastError = controller.signal.aborted ? 'SPEECH_TIMEOUT'
          : ['TRUNCATED_AUDIO', 'SILENT_AUDIO', 'INVALID_AUDIO'].includes(error?.message) ? error.message : 'SPEECH_FAILED';
        log(`[speech] ${lastError}`);
        return fallback(lastError);
      } finally { busy = false; clearTimeout(timeout); controllers.delete(controller); }
    });
    queue = job; inFlight.add(job);
    job.finally(() => inFlight.delete(job));
    return job;
  }
  async function stop() {
    stopped = true;
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...inFlight]);
  }
  function synthesize(input) { return render(input); }
  function verifyResult(result, { text, key, userText = '', factual = false, preview = false } = {}) {
    const proof = result && typeof result === 'object' ? verifiedResults.get(result) : null;
    if (!proof || proof.text !== text || proof.key !== key || proof.userText !== userText ||
        proof.factual !== factual || proof.preview !== preview || result.mode !== 'voice' ||
        result.text !== proof.text || result.spokenText !== proof.spokenText || result.audio !== proof.audio ||
        !Buffer.isBuffer(result.audio) || crypto.createHash('sha256').update(result.audio).digest('hex') !== proof.audioHash) return null;
    return proof.spokenText;
  }
  async function preview(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['text', 'userText', 'profile'].includes(key))) throw new Error('INVALID_PREVIEW');
    const { text, userText = '', profile } = input;
    if (typeof text !== 'string' || !text.trim() || text.length > 160 || typeof userText !== 'string' || userText.length > 200)
      throw new Error('INVALID_PREVIEW');
    const previewProfile = profile === undefined ? null : readPreviewProfile(dir, profile);
    return render({ key: 'p:0', text, userText, explicit: true, preview: true }, previewProfile);
  }
  return { status, config: () => ({ ...config }), updateConfig, synthesize, preview, verifyResult, lookup, remember, stop };
}
