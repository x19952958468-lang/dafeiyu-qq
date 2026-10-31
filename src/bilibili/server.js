import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { BILI_PYTHON } from '../paths.js';
import { prepareSpeechText } from '../speech/spoken-text.js';

const PAGE = new URL('./login.html', import.meta.url);
const PERSONA_FORM_PAGE = new URL('./persona-form.html', import.meta.url);
const MAX_BODY = 16 * 1024;
const MAX_PERSONA_BODY = 128 * 1024 * 6 + 1024; // JSON can encode a text character as six bytes.
const MAX_PERSONA_FORM_BODY = 128 * 1024 * 8 + 4096;
const SETTINGS = new Set(['ownerQq', 'enabled', 'watchPerDay', 'commentPerDay', 'sharePerDay', 'intervalMinutes', 'commentGapMinutes', 'shareGapMinutes', 'keywords']);
const SPEECH_SETTINGS = new Set(['enabled', 'mode', 'autoRate', 'intensity', 'maxChars']);
const SPEECH_MODES = ['auto', 'voice', 'text'];
const PREVIEW_EMOTIONS = new Set(['neutral', 'happy', 'sad', 'annoyed', 'gentle', 'playful', 'surprised']);
const PREVIEW_SOURCES = new Set(['explicit', 'semantic', 'text', 'continuation', 'neutral', 'reset', 'factual', 'unknown']);
const QR_SCRIPT = 'import sys,io,qrcode\ns=sys.stdin.read(8193)\nassert len(s)<=8192\nb=io.BytesIO()\nqrcode.make(s).save(b,format="PNG")\nsys.stdout.buffer.write(b.getvalue())';

function fail(status, message) {
  return Object.assign(new Error(message), { httpStatus: status, publicMessage: message });
}
function short(value, length = 200) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, length) : '';
}
function account(value = {}) {
  return { loggedIn: value.loggedIn === true, uid: /^\d{1,20}$/.test(String(value.uid || '')) ? String(value.uid) : '', name: short(value.name, 80) };
}
function publicConfig(value = {}) {
  const result = {};
  for (const key of SETTINGS) {
    const item = value[key];
    if (key === 'ownerQq') result[key] = /^\d{5,20}$/.test(String(item || '')) ? String(item) : '';
    else if (key === 'enabled') result[key] = item === true;
    else if (key === 'keywords') result[key] = Array.isArray(item) ? item.slice(0, 20).map(v => short(v, 60)) : [];
    else if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
  }
  return result;
}
function publicStatus(value = {}) {
  const stats = {};
  for (const key of ['todayWatched', 'todayComments', 'todayShared']) {
    stats[key] = Number.isFinite(value.stats?.[key]) ? value.stats[key] : 0;
  }
  for (const key of ['lastRunAt', 'nextRunAt']) {
    const raw = value.stats?.[key];
    stats[key] = typeof raw === 'number' && Number.isFinite(raw) ? raw : short(raw, 40);
  }
  stats.busy = value.stats?.busy === true;
  const recent = Array.isArray(value.recent) ? value.recent.slice(-20).map(item => {
    const record = {};
    for (const key of ['time', 'bvid', 'title', 'action', 'status', 'message', 'summary']) record[key] = short(item?.[key], key === 'summary' ? 600 : 240);
    try {
      const url = new URL(item?.url);
      if (url.protocol === 'https:' && /^(www\.)?bilibili\.com$/.test(url.hostname)) record.url = url.href;
    } catch { /* records without a video link remain readable */ }
    return record;
  }) : [];
  const phase = ['awaiting_owner', 'awaiting_login', 'ready', 'paused', 'busy', 'error'].includes(value.phase) ? value.phase : 'awaiting_login';
  return { phase, account: account(value.account), config: publicConfig(value.config), stats, recent };
}
function publicSpeechConfig(value = {}) {
  return {
    enabled: value.enabled === true,
    mode: SPEECH_MODES.includes(value.mode) ? value.mode : 'text',
    autoRate: Number.isFinite(value.autoRate) && value.autoRate >= 0 && value.autoRate <= 1 ? value.autoRate : 0.3,
    intensity: Number.isFinite(value.intensity) && value.intensity >= 0 && value.intensity <= 1 ? value.intensity : 0.65,
    maxChars: Number.isInteger(value.maxChars) && value.maxChars >= 20 && value.maxChars <= 500 ? value.maxChars : 160,
  };
}
function validateSpeechPatch(body) {
  if (Object.keys(body).some(key => !SPEECH_SETTINGS.has(key))) throw fail(400, '语音设置中含有不支持的字段。');
  if ('enabled' in body && typeof body.enabled !== 'boolean') throw fail(400, '语音开关不正确。');
  if ('mode' in body && !SPEECH_MODES.includes(body.mode)) throw fail(400, '请选择有效的语音方式。');
  for (const key of ['autoRate', 'intensity']) {
    if (key in body && (!Number.isFinite(body[key]) || body[key] < 0 || body[key] > 1)) throw fail(400, '语音比例和情绪强度应在 0–100% 之间。');
  }
  if ('maxChars' in body && (!Number.isInteger(body.maxChars) || body.maxChars < 20 || body.maxChars > 500)) throw fail(400, '单条语音字数应为 20–500 的整数。');
}
function validateSpeechPreview(body) {
  if (Object.keys(body).some(key => !['text', 'userText', 'profile'].includes(key))) throw fail(400, '试听请求中含有不支持的字段。');
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 160) throw fail(400, '试听正文应为 1–160 字的非空文字。');
  if ('userText' in body && (typeof body.userText !== 'string' || body.userText.length > 200)) throw fail(400, '试听语气提示应为不超过 200 字的文字。');
  if ('profile' in body && (typeof body.profile !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/u.test(body.profile) || body.profile.trim() !== body.profile)) throw fail(400, '试听方案编号不正确。');
  if ([body.text, body.userText || ''].some(value => /[\x00-\x1f\x7f-\x9f]|\[\s*CQ\s*:/iu.test(value))) throw fail(400, '试听文字不能包含消息代码或控制字符。');
}
function publicSpeechPreview(result, text, userText, speech) {
  const prepared = prepareSpeechText(text, { factual: false, userText });
  const { unsafeForVoice } = prepared;
  if (unsafeForVoice) throw new Error('INVALID_PREVIEW_RESULT');
  const spokenText = typeof speech?.verifyResult === 'function'
    ? speech.verifyResult(result, { text, key: 'p:0', userText, factual: false, preview: true }) : prepared.spokenText;
  if (typeof spokenText !== 'string') throw new Error('INVALID_PREVIEW_RESULT');
  const audio = result?.audio;
  const mp3 = Buffer.isBuffer(audio) && (audio.toString('ascii', 0, 3) === 'ID3' || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0));
  if (result?.mode !== 'voice' || !mp3 || audio.length < 100 || audio.length > 8 * 1024 * 1024 || result.text !== text) throw new Error('INVALID_PREVIEW_RESULT');
  if (!spokenText.trim() || (('spokenText' in result || spokenText !== text) && result.spokenText !== spokenText)) throw new Error('INVALID_PREVIEW_RESULT');
  return { mode: 'voice', audioBase64: audio.toString('base64'), mimeType: 'audio/mpeg', text,
    ...(spokenText !== text ? { spokenText } : {}),
    emotion: PREVIEW_EMOTIONS.has(result.style?.emotion) ? result.style.emotion : 'neutral',
    intensity: Number.isFinite(result.style?.intensity) && result.style.intensity >= 0 && result.style.intensity <= 1 ? result.style.intensity : 0,
    source: PREVIEW_SOURCES.has(result.style?.source) ? result.style.source : 'unknown' };
}
function readBody(req, maxBytes = MAX_BODY, trace = null) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return Promise.reject(fail(415, '请使用 JSON 请求。'));
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (trace) trace.bytes = size;
      if (size > maxBytes) { settled = true; reject(fail(413, '请求内容过大。')); return; }
      chunks.push(chunk);
    });
    req.on('error', () => { if (!settled) { settled = true; reject(fail(400, '请求中断，请重试。')); } });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      trace?.record('body-end');
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch { reject(fail(400, '请求格式不正确。')); }
    });
  });
}

function readPersonaForm(req, trace) {
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return Promise.reject(fail(415, '请使用人设编辑页提交。'));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, settled = false;
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (trace) trace.bytes = size;
      if (size > MAX_PERSONA_FORM_BODY) { settled = true; reject(fail(413, '提交内容过大，请保留原页面中的草稿。')); return; }
      chunks.push(chunk);
    });
    req.on('error', () => { if (!settled) { settled = true; reject(fail(400, '提交中断，请保留原页面中的草稿再试。')); } });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      trace?.record('body-end');
      try {
        const encoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const decode = value => decodeURIComponent(value.replaceAll('+', ' '));
        const entries = encoded ? encoded.split('&').map(pair => {
          const separator = pair.indexOf('=');
          return separator < 0 ? [decode(pair), ''] : [decode(pair.slice(0, separator)), decode(pair.slice(separator + 1))];
        }) : [];
        resolve(entries);
      } catch { reject(fail(400, '提交格式不正确，请保留原页面中的草稿再试。')); }
    });
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

// Metadata only: never retain body text, request headers, query strings, or errors.
function tracePersonaRequest(req, res, log) {
  let pathname;
  try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { return null; }
  if (req.method !== 'POST' || !['/api/persona', '/persona/save-form'].includes(pathname)) return null;
  const trace = {
    id: crypto.randomBytes(8).toString('hex'), phase: 'headers',
    bytes: 0, responseBytes: 0, status: 0,
    record(stage) {
      // Logging must not change whether a save succeeds or a response is sent.
      try {
        log(`[local-ui-request] id=${trace.id} path=${pathname} stage=${stage} phase=${trace.phase} status=${trace.status} bytes=${trace.bytes} responseBytes=${trace.responseBytes}`);
      } catch { /* diagnostics are best effort */ }
    },
  };
  trace.record('start');
  req.once('aborted', () => trace.record('aborted'));
  res.once('finish', () => trace.record('finish'));
  res.once('close', () => { if (!res.writableFinished) trace.record('closed'); });
  return trace;
}

export function encodeQrPng(url, python) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', QR_SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(fail(503, '本地二维码生成超时，请重试。'));
    }, 15000);
    child.on('error', () => finish(fail(503, '本地二维码组件暂不可用。')));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 512 * 1024) { child.kill('SIGKILL'); finish(fail(503, '二维码生成失败。')); }
      else chunks.push(chunk);
    });
    child.on('close', code => {
      const png = Buffer.concat(chunks);
      if (code !== 0 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) finish(fail(503, '本地二维码组件暂不可用。'));
      else finish(null, `data:image/png;base64,${png.toString('base64')}`);
    });
    child.stdin.on('error', () => { /* a failed child is reported by close/error */ });
    child.stdin.end(url);
  });
}

/** Local-only UI. Constructing it never starts the companion or creates a QR. */
export function createLoginServer({ companion, speech = null, personaEditor = null, port = 6196, csrfToken, python = BILI_PYTHON, log = () => {}, qrEncoder = encodeQrPng }) {
  if (!companion || ['status', 'friends', 'configure', 'createQr', 'pollQr', 'runNow'].some(name => typeof companion[name] !== 'function')) throw new Error('Incomplete Bilibili companion interface');
  if (csrfToken !== undefined && (typeof csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrfToken) ||
      Buffer.from(csrfToken, 'base64url').length !== 32 || Buffer.from(csrfToken, 'base64url').toString('base64url') !== csrfToken)) {
    throw new Error('Invalid local UI CSRF token');
  }
  const csrf = csrfToken === undefined ? crypto.randomBytes(32).toString('base64url') : csrfToken;
  const scriptNonce = crypto.randomBytes(24).toString('base64url');
  const qrSessions = new Map();
  const hasSpeech = !!speech && ['status', 'config', 'updateConfig'].every(name => typeof speech[name] === 'function');
  const hasPersona = !!personaEditor && ['state', 'save', 'backup'].every(name => typeof personaEditor[name] === 'function');
  const personaState = value => ({
    available: true, text: value.text, revision: value.revision, updatedAt: value.updatedAt,
    appliedRevision: value.appliedRevision, needsApply: value.needsApply === true,
    backups: (Array.isArray(value.backups) ? value.backups : []).map(({ id, createdAt, label }) => ({ id, createdAt, label })),
  });
  async function personaAction(method, input) {
    if (!hasPersona) throw fail(503, '人设编辑暂未接入。');
    try { return await personaEditor[method](input); }
    catch (error) {
      if (error.code === 'ROLLBACK_FAILED') throw fail(503, '人设没有完整加载，请重启程序后检查。旧版本备份已保留。');
      if (error.code === 'SAVE_FAILED') throw fail(503, '人设暂未保存，已恢复原版本；草稿已保留，请稍后重试。');
      const messages = {
        400: '人设内容或版本格式不正确，请重新加载后重试。',
        404: '这个历史版本已不存在，请重新加载列表。',
        409: '人设已被另一处修改。你的草稿已保留，请先备份草稿，再重新加载最新版本。',
        413: '人设内容过长，最多支持 128 KiB 文本。',
      };
      const status = error.status || error.httpStatus;
      throw fail(messages[status] ? status : 503, messages[status] || '人设操作未完成，草稿已保留，请稍后重试。');
    }
  }
  async function personaFormHtml({ text = '', revision = '', status, statusClass, formAction, managerUrl }) {
    const values = {
      __CSRF_NONCE__: csrf, __SCRIPT_NONCE__: scriptNonce,
      __PERSONA_TEXT__: escapeHtml(text), __PERSONA_TEXT_JSON__: escapeHtml(JSON.stringify(text)),
      __PERSONA_REVISION__: escapeHtml(revision), __PERSONA_STATUS__: escapeHtml(status),
      __PERSONA_STATUS_CLASS__: statusClass === 'success' ? 'success' : 'error',
      __PERSONA_FORM_ACTION__: escapeHtml(formAction), __MANAGER_URL__: escapeHtml(managerUrl),
    };
    const template = await fs.readFile(PERSONA_FORM_PAGE, 'utf8');
    // Replace only placeholders in the template, never placeholder-looking user text.
    return template.replace(/__(?:CSRF_NONCE|SCRIPT_NONCE|PERSONA_TEXT_JSON|PERSONA_TEXT|PERSONA_REVISION|PERSONA_STATUS_CLASS|PERSONA_STATUS|PERSONA_FORM_ACTION|MANAGER_URL)__/g, placeholder => values[placeholder]);
  }
  async function speechState() {
    if (!hasSpeech) return { available: false, ready: false, busy: false, queued: 0, hasError: false, lastGeneratedAt: null, config: null };
    try {
      const state = await speech.status();
      const config = await speech.config();
      const rawTime = state?.lastGeneratedAt;
      const timestamp = typeof rawTime === 'number' ? rawTime : typeof rawTime === 'string' && /^\d{4}-\d\d-\d\dT/.test(rawTime) ? Date.parse(rawTime) : NaN;
      const date = new Date(timestamp);
      return {
        available: state?.available !== false, ready: state?.ready === true, busy: state?.busy === true,
        queued: Number.isInteger(state?.queued) && state.queued >= 0 && state.queued <= 1000 ? state.queued : 0,
        hasError: !!state?.lastError,
        lastGeneratedAt: timestamp > 0 && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
        config: publicSpeechConfig(config),
      };
    } catch { throw fail(503, '语音状态暂不可用，请稍后重试。'); }
  }
  let actualPort = Number(port);
  let starting;
  const server = http.createServer(async (req, res) => {
    const trace = tracePersonaRequest(req, res, log);
    const host = String(req.headers.host || '').toLowerCase();
    const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    const headers = {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'nonce-${scriptNonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      ...(trace ? { 'X-Request-Id': trace.id } : {}),
    };
    const send = (status, data, type = 'application/json; charset=utf-8') => {
      if (res.writableEnded || res.destroyed || res.socket?.writableEnded) return;
      const payload = type.startsWith('application/json') ? JSON.stringify(data) : data;
      if (trace) { trace.status = status; trace.responseBytes = Buffer.byteLength(payload); }
      res.writeHead(status, { ...headers, 'Content-Type': type });
      res.end(payload);
    };
    let isPersonaForm = false, submittedDraft = { text: '', revision: '' };
    const sendPersonaForm = async (status, draft, message, statusClass = 'error') => {
      headers['Content-Security-Policy'] = headers['Content-Security-Policy'].replace("form-action 'none'", "form-action 'self'");
      headers['Referrer-Policy'] = 'same-origin';
      let html;
      try { html = await personaFormHtml({ ...draft, status: message, statusClass, formAction: `http://${host}/persona/save-form`, managerUrl: `http://${host}/?editor=2#persona` }); }
      catch {
        // A missing template must not discard the draft or turn a known result into a blank response.
        html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>人设保存结果</title><h1>人设保存结果</h1><p>${escapeHtml(message)}</p><p>编辑页暂不可用，请保留下面的草稿。</p><textarea>\n${escapeHtml(draft.text)}</textarea><input type="hidden" name="revision" value="${escapeHtml(draft.revision)}"><a href="/persona/editor">重新打开编辑页</a></html>`;
      }
      send(status, html, 'text/html; charset=utf-8');
    };
    try {
      if (!allowedHosts.includes(host)) throw fail(403, '仅允许本机访问。');
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw fail(403, '请求来源不匹配。');
      if (!['GET', 'POST'].includes(req.method)) throw fail(405, '不支持此请求方式。');
      const url = new URL(req.url, `http://${host}`);
      isPersonaForm = ['/persona/editor', '/persona/save-form'].includes(url.pathname);
      if (req.method === 'GET') {
        if (url.pathname === '/') {
          const html = (await fs.readFile(PAGE, 'utf8')).replaceAll('__CSRF_NONCE__', csrf).replaceAll('__SCRIPT_NONCE__', scriptNonce);
          send(200, html, 'text/html; charset=utf-8'); return;
        }
        if (url.pathname === '/persona/editor') {
          const current = await personaAction('state');
          await sendPersonaForm(200, current, '当前人设已载入。修改后提交，保存结果会在新页面显示。', 'success'); return;
        }
        if (url.pathname === '/persona/save-form') throw fail(405, '这个地址只接受提交，请从人设编辑页保存。');
        if (url.pathname === '/api/status') { send(200, publicStatus(await companion.status())); return; }
        if (url.pathname === '/api/speech') { send(200, await speechState()); return; }
        if (url.pathname === '/api/persona') {
          send(200, hasPersona ? personaState(await personaAction('state')) : { available: false }); return;
        }
        if (url.pathname === '/api/persona/backup') {
          const value = await personaAction('backup', url.searchParams.get('id'));
          send(200, { text: value.text, id: value.id, createdAt: value.createdAt, label: value.label }); return;
        }
        if (url.pathname === '/api/friends') {
          const list = await companion.friends();
          send(200, { friends: (Array.isArray(list) ? list : []).filter(v => /^\d{5,20}$/.test(String(v.user_id))).slice(0, 1000).map(v => ({ user_id: String(v.user_id), nickname: short(v.nickname, 80), remark: short(v.remark, 80) })) }); return;
        }
        throw fail(404, '页面不存在。');
      }
      if (url.pathname === '/persona/editor') throw fail(405, '请从人设编辑页中的表单提交。');
      if (url.pathname === '/persona/save-form') {
        if (trace) trace.phase = 'body';
        const entries = await readPersonaForm(req, trace);
        if (trace) trace.phase = 'validate';
        const values = key => entries.filter(([name]) => name === key).map(([, value]) => value);
        const textValues = values('textJson'), revisionValues = values('revision');
        let text;
        if (textValues.length === 1) {
          try { text = JSON.parse(textValues[0]); } catch { /* invalid JSON is rejected below */ }
          if (typeof text === 'string') submittedDraft.text = text;
        }
        if (revisionValues.length === 1) submittedDraft.revision = revisionValues[0];
        if (entries.length !== 3 || !['csrf', 'revision', 'textJson'].every(key => values(key).length === 1)) {
          throw fail(400, '提交字段不正确或重复。草稿已保留，请从编辑页重新提交。');
        }
        if (trace) trace.phase = 'csrf';
        const token = values('csrf')[0];
        if (Buffer.byteLength(token) !== Buffer.byteLength(csrf) || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) throw fail(403, '页面验证已失效。草稿已保留，可在本页重新提交。');
        if (trace) trace.phase = 'validate';
        if (typeof text !== 'string' || !/^[a-f0-9]{64}$/.test(submittedDraft.revision)) throw fail(400, '人设内容或版本格式不正确，请保留草稿后重新加载编辑页。');
        if (Buffer.byteLength(text, 'utf8') > 128 * 1024) throw fail(413, '人设内容过长，最多支持 128 KiB 文本。草稿已保留。');
        if (trace) trace.phase = 'save';
        const result = await personaAction('save', submittedDraft);
        if (result?.text !== submittedDraft.text || result?.revision !== result?.appliedRevision || result?.needsApply !== false) {
          throw fail(503, '本次保存尚未确认生效。草稿已保留，请核对当前人设后再试。');
        }
        await sendPersonaForm(200, result, '已保存并生效，下一条回复会使用这版人设。', 'success'); return;
      }
      if (trace) trace.phase = 'csrf';
      const token = req.headers['x-csrf-token'];
      if (typeof token !== 'string' || Buffer.byteLength(token) !== Buffer.byteLength(csrf) || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) throw fail(403, '页面已过期，请刷新后重试。');
      if (trace) trace.phase = 'body';
      const body = await readBody(req, url.pathname === '/api/persona' ? MAX_PERSONA_BODY : MAX_BODY, trace);
      if (url.pathname === '/api/persona') {
        if (trace) trace.phase = 'validate';
        if (Object.keys(body).some(key => !['text', 'revision'].includes(key)) || typeof body.text !== 'string' || typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) throw fail(400, '人设内容或版本格式不正确，请重新加载后重试。');
        if (trace) trace.phase = 'save';
        send(200, personaState(await personaAction('save', body))); return;
      }
      if (url.pathname === '/api/speech') {
        if (!hasSpeech) throw fail(503, '情绪语音暂未接入。');
        validateSpeechPatch(body);
        try { await speech.updateConfig(body); }
        catch { throw fail(503, '语音设置暂未保存，请稍后重试。'); }
        send(200, await speechState()); return;
      }
      if (url.pathname === '/api/speech/preview') {
        validateSpeechPreview(body);
        if (!hasSpeech || typeof speech.preview !== 'function') throw fail(503, '语音试听暂不可用，请稍后重试。');
        let result;
        try {
          result = publicSpeechPreview(await speech.preview({ text: body.text, userText: body.userText || '',
            ...('profile' in body ? { profile: body.profile } : {}) }), body.text, body.userText || '', speech);
        } catch { throw fail(503, '语音试听暂不可用，请稍后重试。'); }
        send(200, result); return;
      }
      if (url.pathname === '/api/config') {
        if (Object.keys(body).some(key => !SETTINGS.has(key))) throw fail(400, '设置中含有不支持的字段。');
        await companion.configure(body);
        send(200, publicStatus(await companion.status())); return;
      }
      if (url.pathname === '/api/login/start') {
        const state = await companion.status();
        if (!/^\d{5,20}$/.test(String(state.config?.ownerQq || ''))) throw fail(400, '请先选择接收推荐的 QQ 并保存。');
        const qr = await companion.createQr();
        let qrUrl;
        try { qrUrl = new URL(qr.url); } catch { throw fail(502, 'B站没有返回有效二维码。'); }
        if (qrUrl.protocol !== 'https:' || !(qrUrl.hostname === 'bilibili.com' || qrUrl.hostname.endsWith('.bilibili.com')) || !/^[A-Za-z0-9_-]{16,128}$/.test(String(qr.key || ''))) throw fail(502, 'B站没有返回有效二维码。');
        const image = await qrEncoder(qrUrl.href, python);
        const expiresAt = Math.min(Number(qr.expiresAt) || Date.now() + 180000, Date.now() + 180000);
        qrSessions.clear();
        qrSessions.set(qr.key, expiresAt);
        send(200, { key: qr.key, image, expiresAt }); return;
      }
      if (url.pathname === '/api/login/poll') {
        const key = String(body.key || '');
        if (!qrSessions.has(key) || Date.now() >= qrSessions.get(key)) { send(200, { status: 'expired' }); return; }
        const result = await companion.pollQr(key);
        if (!['waiting', 'scanned', 'expired', 'confirmed'].includes(result?.status)) throw fail(502, '暂时无法确认扫码状态。');
        if (['expired', 'confirmed'].includes(result.status)) qrSessions.delete(key);
        send(200, { status: result.status, ...(result.status === 'confirmed' ? { account: account({ ...result.account, loggedIn: true }) } : {}) }); return;
      }
      if (url.pathname === '/api/run') {
        if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') throw fail(400, '试运行参数不正确。');
        const result = await companion.runNow({ dryRun: body.dryRun !== false });
        send(202, { accepted: result?.accepted !== false, dryRun: body.dryRun !== false }); return;
      }
      throw fail(404, '接口不存在。');
    } catch (error) {
      // Do not echo upstream exceptions: they can contain URLs or account data.
      if (!error.httpStatus) log('[bilibili-ui] 请求未完成');
      if (isPersonaForm) {
        await sendPersonaForm(error.httpStatus || 503, submittedDraft, error.publicMessage || '保存未完成。草稿已保留，请稍后重试。'); return;
      }
      send(error.httpStatus || 503, { error: error.publicMessage || '操作暂未完成，请稍后重试或查看状态记录。' });
    }
  });
  // HTTP parser errors happen before the route handler. Node's default reply is
  // an empty 400/408/431, so the page otherwise cannot explain a failed save.
  server.on('clientError', (error, socket) => {
    const code = /^[A-Z0-9_]{1,50}$/.test(String(error.code || '')) ? error.code : 'HTTP_READ_ERROR';
    if (code === 'ECONNRESET' || socket.destroyed || !socket.writable || socket.writableEnded) return;
    const status = code === 'HPE_HEADER_OVERFLOW' ? 431 : code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : 400;
    const reason = { 400: 'Bad Request', 408: 'Request Timeout', 431: 'Request Header Fields Too Large' }[status];
    const message = {
      400: '浏览器提交的请求未完整读取，尚未确认保存。请保留草稿并重试。',
      408: '提交超时，尚未确认保存。请保留草稿并重试。',
      431: '浏览器请求头过大，尚未确认保存。请保留草稿，用新页面重试。',
    }[status];
    const body = JSON.stringify({ error: message, code, uncertain: true });
    log(`[local-ui] HTTP请求未完成 status=${status} code=${code}`);
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${body}`);
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  const address = () => ({ host: '127.0.0.1', port: actualPort, url: `http://127.0.0.1:${actualPort}` });
  return {
    start() {
      if (server.listening) return Promise.resolve(address());
      if (starting) return starting;
      starting = new Promise((resolve, reject) => {
        const onError = error => { starting = undefined; reject(error); };
        server.once('error', onError);
        server.listen(actualPort, '127.0.0.1', () => {
          server.removeListener('error', onError);
          actualPort = server.address().port;
          log(`[bilibili-ui] 本地页面 ${address().url}`);
          resolve(address());
        });
      });
      return starting;
    },
    async stop() {
      qrSessions.clear();
      if (starting) await starting.catch(() => {});
      starting = undefined;
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
    },
  };
}
