import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_PERSONA_BYTES = 128 * 1024;
const MAX_BACKUP_BYTES = MAX_PERSONA_BYTES * 6 + 64 * 1024;
const ID = /^[0-9a-z]{1,16}-[0-9a-f]{32}$/;
const REVISION = /^[0-9a-f]{64}$/;
const STYLE_PATHS = [
  ['llm', 'temperature'], ['trigger', 'requireWords'], ['trigger', 'watchWords'],
  ['proactiveAt', 'goal'], ['persona', 'naturalAddress'],
];
const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

function fail(code, status, message) {
  return Object.assign(new Error(message), { code, status, httpStatus: status, publicMessage: message });
}
function field(object, keys) {
  let parent = object;
  for (const key of keys.slice(0, -1)) {
    if (!plain(parent) || !Object.hasOwn(parent, key)) return { path: keys, present: false };
    parent = parent[key];
  }
  const key = keys.at(-1);
  return plain(parent) && Object.hasOwn(parent, key)
    ? { path: keys, present: true, value: structuredClone(parent[key]) }
    : { path: keys, present: false };
}
function setField(object, entry) {
  let parent = object;
  for (const key of entry.path.slice(0, -1)) {
    if (!Object.hasOwn(parent, key)) {
      if (!entry.present) return;
      parent[key] = {};
    }
    if (!plain(parent[key])) throw fail('INVALID_CONFIG', 503, '人设配置暂不可用，请检查本地配置。');
    parent = parent[key];
  }
  if (entry.present) parent[entry.path.at(-1)] = structuredClone(entry.value);
  else delete parent[entry.path.at(-1)];
}
function missingParents(object, entries) {
  const missing = new Map();
  for (const entry of entries) {
    for (let size = 1; size < entry.path.length; size++) {
      const keys = entry.path.slice(0, size);
      if (!field(object, keys).present) missing.set(keys.join('.'), keys);
    }
  }
  return [...missing.values()].sort((a, b) => b.length - a.length);
}
function customStyle(raw, stamp) {
  const settings = [
    { path: ['trigger', 'requireWords'], present: false },
    { path: ['trigger', 'watchWords'], present: true, value: [] },
    { path: ['proactiveAt', 'goal'], present: true, value: '按当前人设，接对方最近一句话里的具体内容，自然、简洁地搭话。' },
    { path: ['persona', 'naturalAddress'], present: true, value: true },
    { path: ['persona', 'activatedAt'], present: true, value: stamp },
  ];
  return settings;
}
function validateText(text) {
  if (typeof text !== 'string' || !text.trim()) throw fail('INVALID_PERSONA', 400, '请填写人设内容。');
  if (text.includes('\0')) throw fail('INVALID_PERSONA', 400, '人设中不能包含空字符。');
  if (Buffer.byteLength(text, 'utf8') > MAX_PERSONA_BYTES) throw fail('PERSONA_TOO_LARGE', 413, '人设内容超过 128 KiB，请缩短后保存。');
}

/** Local text editor. No content rewriting, network calls, or message delivery. */
export function createPersonaEditor({ rootDir, cfg, onApply = () => {}, now = Date.now, io = fs } = {}) {
  if (!rootDir || !plain(cfg) || typeof onApply !== 'function') throw new Error('Incomplete persona editor interface');
  const configFile = cfg.__file ? path.resolve(rootDir, cfg.__file) : path.join(rootDir, 'config.json');
  const backupDir = path.join(rootDir, 'data/persona/backups');
  const activeFile = () => path.resolve(rootDir, cfg.persona?.file || 'persona/dafeiyu.md');

  function atomicWrite(file, content, mode = 0o600) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = io.openSync(temporary, 'wx', mode);
      io.fchmodSync(fd, mode);
      io.writeFileSync(fd, content);
      io.fsyncSync(fd);
      io.closeSync(fd); fd = undefined;
      io.renameSync(temporary, file);
    } finally {
      if (fd !== undefined) io.closeSync(fd);
      try { io.rmSync(temporary, { force: true }); } catch { /* never hide the write failure */ }
    }
  }
  function active() {
    const file = activeFile(), info = io.statSync(file);
    if (!info.isFile() || info.size > MAX_PERSONA_BYTES) throw fail('PERSONA_UNAVAILABLE', 503, '当前人设文件暂不可编辑。');
    const text = io.readFileSync(file, 'utf8');
    return { file, text, revision: digest(text), updatedAt: new Date(info.mtimeMs).toISOString(), mode: info.mode & 0o777 };
  }
  function readBackup(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw fail('BACKUP_NOT_FOUND', 404, '没有找到这个历史版本。');
    try {
      const file = path.join(backupDir, `${id}.json`), info = io.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BACKUP_BYTES) throw new Error();
      const record = JSON.parse(io.readFileSync(file, 'utf8'));
      if (record.version !== 1 || record.id !== id || typeof record.text !== 'string' ||
          typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) throw new Error();
      return record;
    } catch (error) {
      if (error?.code === 'BACKUP_NOT_FOUND') throw error;
      throw fail('BACKUP_NOT_FOUND', 404, '没有找到这个历史版本。');
    }
  }
  function backups() {
    let files;
    try { files = io.readdirSync(backupDir); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const list = [];
    for (const name of files) {
      if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
      try {
        const record = readBackup(name.slice(0, -5));
        list.push({ id: record.id, createdAt: record.createdAt,
          label: typeof record.label === 'string' ? record.label.slice(0, 80) : '历史人设' });
      } catch { /* an incomplete/corrupt backup does not block editing */ }
    }
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  let appliedText, appliedRevision;
  try { const initial = active(); appliedText = initial.text; appliedRevision = initial.revision; }
  catch { throw fail('PERSONA_UNAVAILABLE', 503, '当前人设文件暂不可编辑。'); }

  function state() {
    try {
      const current = active();
      return { available: true, text: current.text, revision: current.revision, updatedAt: current.updatedAt,
        appliedRevision, needsApply: current.revision !== appliedRevision, backups: backups() };
    } catch (error) {
      if (error?.httpStatus) throw error;
      throw fail('PERSONA_UNAVAILABLE', 503, '当前人设文件暂不可编辑。');
    }
  }
  function save({ text, revision } = {}) {
    validateText(text);
    if (typeof revision !== 'string' || !REVISION.test(revision)) throw fail('INVALID_REVISION', 400, '请先加载当前人设，再保存修改。');
    let current, raw, configBytes, configMode;
    try {
      current = active();
      if (revision !== current.revision) throw fail('PERSONA_CONFLICT', 409, '人设已在别处更新，草稿已保留；请重新加载后再保存。');
      configBytes = io.readFileSync(configFile);
      configMode = io.statSync(configFile).mode & 0o777;
      raw = JSON.parse(configBytes.toString('utf8'));
      if (!plain(raw)) throw new Error();
      if (path.resolve(rootDir, raw.persona?.file || 'persona/dafeiyu.md') !== current.file) {
        throw fail('PERSONA_CONFLICT', 409, '人设文件位置已发生变化，请重新加载程序后编辑。');
      }
    } catch (error) {
      if (error?.httpStatus) throw error;
      throw fail('PERSONA_UNAVAILABLE', 503, '当前人设配置暂不可保存。');
    }
    if (text === current.text && current.revision === appliedRevision) return state();

    const stamp = Number(now());
    if (!Number.isSafeInteger(stamp) || stamp < 0 || !Number.isFinite(new Date(stamp).getTime())) throw fail('SAVE_FAILED', 503, '本机时间暂不可用，请稍后再保存。');
    const settings = customStyle(raw, stamp), next = structuredClone(raw);
    for (const entry of settings) setField(next, entry);
    const runtimeBefore = settings.map(entry => field(cfg, entry.path));
    const absentRuntimeParents = missingParents(cfg, settings);
    const previousText = appliedText, previousRevision = appliedRevision;
    const id = `${Math.trunc(stamp).toString(36)}-${crypto.randomUUID().replaceAll('-', '')}`;
    const backupRecord = {
      version: 1, id, createdAt: new Date(stamp).toISOString(),
      label: current.text.split(/\r?\n/).find(line => line.trim())?.replace(/^#+\s*/, '').trim().slice(0, 80) || '未命名人设',
      text: current.text, profile: { version: 1, settings: STYLE_PATHS.map(keys => field(raw, keys)) },
    };
    let textWritten = false, configWritten = false, memoryTouched = false, applyCalled = false;
    try {
      io.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      atomicWrite(path.join(backupDir, `${id}.json`), JSON.stringify(backupRecord, null, 2) + '\n');
      // Recheck both sources just before the two commits; do not overwrite an external edit.
      if (active().revision !== current.revision || !io.readFileSync(configFile).equals(configBytes)) {
        throw fail('PERSONA_CONFLICT', 409, '人设或配置刚刚发生变化，草稿已保留；请重新加载后再保存。');
      }
      if (text !== current.text) { atomicWrite(current.file, text, current.mode); textWritten = true; }
      atomicWrite(configFile, JSON.stringify(next, null, 2) + '\n', configMode); configWritten = true;
      memoryTouched = true;
      for (const entry of settings) setField(cfg, entry);
      applyCalled = true;
      const result = onApply({ text, activatedAt: stamp, cfg, rollback: false });
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new Error('Persona onApply must be synchronous');
      }
      appliedText = text; appliedRevision = digest(text);
    } catch (error) {
      let rollbackFailed = false;
      if (textWritten) try { atomicWrite(current.file, current.text, current.mode); } catch { rollbackFailed = true; }
      if (configWritten) try { atomicWrite(configFile, configBytes, configMode); } catch { rollbackFailed = true; }
      if (memoryTouched) {
        try {
          for (const entry of runtimeBefore) setField(cfg, entry);
          for (const keys of absentRuntimeParents) setField(cfg, { path: keys, present: false });
        } catch { rollbackFailed = true; }
      }
      if (applyCalled) {
        try {
          const result = onApply({ text: previousText, activatedAt: cfg.persona?.activatedAt, cfg, rollback: true });
          if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); rollbackFailed = true; }
        } catch { rollbackFailed = true; }
      }
      appliedText = previousText; appliedRevision = previousRevision;
      if (rollbackFailed) throw fail('ROLLBACK_FAILED', 503, '人设没有完整加载，请重新加载程序后检查；旧版本备份已保留。');
      if (error?.code === 'PERSONA_CONFLICT') throw error;
      throw fail('SAVE_FAILED', 503, '人设暂未保存，已恢复原版本，请稍后重试。');
    }
    return state();
  }
  function backup(id) {
    const record = readBackup(id);
    return { text: record.text };
  }
  return { state, save, backup };
}
