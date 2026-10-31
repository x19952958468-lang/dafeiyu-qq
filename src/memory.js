import fs from 'node:fs';
import path from 'node:path';
import { safeKey, truncate } from './util.js';

/**
 * 会话存储：
 * - history：短期上下文（有 age / 条数 / 字数 三重上限，冷场自动遗忘）
 * - notes：长期便签（少量、按需取用，替代长上下文）
 * 每个群 / 每个私聊互相隔离。
 */
export function createStore({ dir, ctx, mem }) {
  const sessDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  const cache = new Map();
  const dirty = new Set();
  let timer = null;

  const fileOf = (key) => path.join(sessDir, `${safeKey(key)}.json`);

  function get(key) {
    if (cache.has(key)) return cache.get(key);
    let s = { key, history: [], notes: [] };
    try {
      const p = fileOf(key);
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        s = {
          key,
          history: Array.isArray(raw.history) ? raw.history : [],
          notes: Array.isArray(raw.notes) ? raw.notes : [],
        };
      }
    } catch {
      /* 文件损坏就当新会话，不阻塞 */
    }
    cache.set(key, s);
    return s;
  }

  function touch(key) {
    dirty.add(key);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, 800);
  }

  let lastErr = 0;
  function flush() {
    for (const key of dirty) {
      try {
        fs.writeFileSync(fileOf(key), JSON.stringify(cache.get(key), null, 2));
      } catch (e) {
        // 60 秒只报一次；上下文仍在内存里，不影响本次对话的连贯性
        const now = Date.now();
        if (now - lastErr > 60000) {
          lastErr = now;
          console.error('[store] 写入失败（上下文仅本进程内有效）', key, e.message);
        }
      }
    }
    dirty.clear();
  }

  function append(key, turn, ts) {
    const s = get(key);
    s.history.push({ ...turn, ts: ts ?? Date.now() });
    const hardCap = Math.max(ctx.maxTurns * 3, 120);
    if (s.history.length > hardCap) s.history = s.history.slice(-hardCap);
    touch(key);
  }

  /** 取出可直接喂给模型的上下文 */
  function context(key) {
    const s = get(key);
    const freshFrom = Date.now() - ctx.maxAgeSec * 1000;
    let hist = s.history.filter((t) => (t.ts ?? 0) >= freshFrom);
    if (hist.length > ctx.maxTurns) hist = hist.slice(-ctx.maxTurns);
    let total = hist.reduce((n, t) => n + (t.content?.length ?? 0), 0);
    while (hist.length > 1 && total > ctx.maxChars) {
      total -= hist[0].content?.length ?? 0;
      hist.shift();
    }
    return {
      // Keep provenance for the prompt layer's persona boundary. The stored
      // turns stay intact; callers still choose which facts enter the model.
      history: hist.map(turn => {
        const projected = { role: turn.role, name: turn.name, content: turn.content };
        for (const field of ['ts', 'source', 'factual', 'messageId', 'bvid']) {
          if (Object.hasOwn(turn, field)) projected[field] = turn[field];
        }
        return projected;
      }),
      notes: s.notes.slice(-mem.noteCount),
    };
  }

  function addNote(key, text) {
    const s = get(key);
    const clean = truncate(String(text).replace(/\s+/g, ' ').trim(), mem.noteMaxChars);
    if (!clean) return;
    if (s.notes.includes(clean)) return;
    s.notes.push(clean);
    while (s.notes.length > mem.noteCount * 2) s.notes.shift();
    touch(key);
  }

  return { get, append, context, addNote, flush };
}
