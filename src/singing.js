import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

function songTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.trim().replace(/^[《》〈〉“”「」『』"' ]+|[《》〈〉“”「」『』"' ]+$/gu, '');
  if (!title || title.length > 100 || /[\x00-\x1f\x7f]|\[CQ:|https?:\/\//iu.test(title)) return null;
  if (['歌', '首歌', '一首歌', '一段', '什么', '什么歌', '一下', '一遍'].includes(title)) return null;
  return title;
}

export function parseSong(text) {
  const normalized = String(text).normalize('NFKC').trim();
  // Only the user's own imperative goes through this fast path. A quoted command,
  // a discussion about singing, or a negative request belongs to the intent layer.
  if (normalized.length > 500 || /^[“”「」『』"'>]|[\r\n\0]/u.test(normalized)) return null;
  if (/^唱歌(?:是|很|真|太|能|会|有|让|对|的)/u.test(normalized)) return null;
  const match = normalized.match(/^(?:(?:请|麻烦|帮我|给我|能不能|可不可以|可以|你能|你可以|你能不能|你可不可以|我想听你|我想听|想听你|想听)\s*)*(?:唱(?:一下|一首|首|一段|段|歌(?=\s|[《“「]))?|来(?:一首|首)|换(?:一首|首|成(?=\s*《)))\s*(.+?)\s*(?:这首歌)?(?:给我听|听听)?[吧呀嘛呗吗!！?？。]*$/u);
  if (!match) return null;
  const title = songTitle(match[1]);
  if (!title || /[，,；;]|还是|或者|然后|接着|同时|并且|(?:再|并|和)(?:暂停|继续|打开|关闭|唱|看|发|去)|(?:好听|是什么(?:歌)?|什么意思|怎么唱|的人是谁|需要多久|要多久|难不难)(?:吗|呢)?$/u.test(title)) return null;
  return title;
}

export function createSinger({ rootDir, cfg, transport, log = console.log, acquireHeavy }) {
  const options = cfg.singing ?? {};
  const root = path.resolve(rootDir, options.dataDir ?? 'data/singing');
  const jobs = path.join(root, 'jobs');
  const pending = new Map();
  const lastSent = new Map();
  const lastSongs = new Map();

  function allowed(evt) {
    if (!options.enabled || evt.post_type !== 'message' || !['group', 'private'].includes(evt.message_type)) return null;
    const self = String(evt.self_id ?? '');
    const user = String(evt.user_id ?? evt.sender?.user_id ?? '');
    if (!self || !user || user === self) return null;
    if ((cfg.trigger?.ignoreUserIds ?? []).map(String).includes(user)) return null;
    if (evt.message_type === 'group') {
      const group = String(evt.group_id ?? '');
      const groups = cfg.whitelist?.groups ?? [];
      if (!group || (groups.length && !groups.map(String).includes(group))) return null;
      if ((cfg.mutedGroups ?? []).map(String).includes(group)) return null;
      if (!Array.isArray(evt.message)) return null;
      if (!evt.message.some(s => s.type === 'at' && String(s.data?.qq) === self)) return null;
    } else {
      const friends = cfg.whitelist?.friends ?? [];
      if (friends.length && !friends.map(String).includes(user)) return null;
    }
    return true;
  }

  function requesterOf(evt) {
    const user = evt.user_id ?? evt.sender?.user_id;
    return evt.message_type === 'group' ? `g:${evt.group_id}:${user}` : `p:${user}`;
  }

  function match(evt) {
    if (!allowed(evt)) return null;
    const text = typeof evt.message === 'string' ? evt.message : (Array.isArray(evt.message) ? evt.message : [])
      .filter(s => s.type === 'text').map(s => s.data?.text ?? '').join('');
    return parseSong(text);
  }

  async function ready() {
    try {
      const state = JSON.parse(await fs.readFile(path.join(root, 'heartbeat.json'), 'utf8'));
      return state.ready === true && Date.now() / 1000 - state.time < 30;
    } catch { return false; }
  }

  async function start() {
    if (!options.enabled) return;
    if (!await ready() && options.workerLauncher) {
      try {
        await execute(options.python || process.env.DAFEIYU_PYTHON || 'python3', [path.resolve(rootDir, options.workerLauncher)], { timeout: 15000 });
        log('[sing] 本机唱歌引擎已启动');
      } catch (error) {
        log(`[sing] 唱歌引擎启动失败：${error.message}`);
      }
    }
    if (acquireHeavy) {
      // On a bot restart, the independent singer may still own a model.
      const existing = [];
      for (const item of await fs.readdir(jobs, { withFileTypes: true }).catch(() => [])) {
        if (!item.isDirectory()) continue;
        const folder = path.join(jobs, item.name);
        const files = await fs.readdir(folder).catch(() => []);
        if (files.includes('request.json') && !files.includes('status.json') && !files.includes('finished')) existing.push(folder);
      }
      if (existing.length) {
        const release = await acquireHeavy({ kind: 'singing-recovery' });
        (async () => {
          try {
            while (existing.length) {
              for (let i = existing.length - 1; i >= 0; i--) {
                const files = await fs.readdir(existing[i]).catch(() => []);
                if (!files.includes('request.json') || files.includes('status.json') || files.includes('finished')) existing.splice(i, 1);
              }
              if (existing.length) await sleep(500);
            }
          } finally { await release(); }
        })().catch(() => log('[sing] 恢复中的任务检查失败'));
      }
    }
  }

  async function handle(evt, { dry = false } = {}) {
    const song = match(evt);
    if (!song) return { handled: false };
    return request(evt, { song, dry });
  }

  function status(evt) {
    if (!allowed(evt)) return { pending: [], lastSong: null };
    const requester = requesterOf(evt);
    return {
      pending: [...pending.values()].filter(item => item.requester === requester).map(item => ({
        song: item.song, phase: item.phase, elapsedSec: Math.max(0, Math.floor((Date.now() - item.createdAt) / 1000)),
      })),
      lastSong: lastSongs.get(requester) ?? null,
    };
  }

  async function request(evt, { song: value, dry = false } = {}) {
    const song = songTitle(value);
    if (!allowed(evt) || !song) return { handled: false };
    const isGroup = evt.message_type === 'group';
    const user = evt.user_id ?? evt.sender?.user_id;
    const requester = requesterOf(evt);
    const destination = isGroup ? `群${evt.group_id}` : `私聊${user}`;
    const send = segments => isGroup
      ? transport.sendGroup(evt.group_id, segments)
      : transport.sendPrivate(user, segments);
    const result = { handled: true, song, sent: false, audio: false };
    if (dry) return result;
    const say = async text => {
      const response = await send([{ type: 'text', data: { text } }]);
      if (!response.ok) throw new Error(response.error ?? '发送消息失败');
      result.sent = true;
    };
    if ([...pending.values()].some(item => item.requester === requester)) {
      await say('你上一首点歌还在队列里，唱完再点下一首吧～');
      return result;
    }
    if (pending.size >= (options.maxPending ?? 3)) {
      await say('点歌队列满了，稍后再叫我唱～');
      return result;
    }
    if (Date.now() - (lastSent.get(requester) ?? 0) < (options.cooldownSec ?? 20) * 1000) {
      await say('让我歇一会儿再唱下一首～');
      return result;
    }
    // Reserve synchronously before filesystem awaits so simultaneous messages
    // obey the queue limit and each requester has at most one pending song.
    const requestId = randomUUID().replaceAll('-', '');
    const pendingItem = { requester, song, phase: 'queue', createdAt: Date.now() };
    pending.set(requestId, pendingItem);
    const position = pending.size;
    let folder, release;
    try {
      if (!await ready()) {
        await say('唱歌引擎还没准备好，暂时唱不了这首。');
        return result;
      }
      await say(position > 1
        ? `《${song}》已加入点歌队列，目前第${position}首，前面的唱完就轮到你～`
        : `我给你唱一段约${options.targetDurationSec ?? 20}秒的《${song}》，等我一下～`);
      lastSongs.delete(requester); lastSongs.set(requester, song);
      if (lastSongs.size > 500) lastSongs.delete(lastSongs.keys().next().value);
      release = await acquireHeavy?.({ kind: 'singing', timeoutMs: (options.maxRequestAgeSec ?? 900) * 1000 });
      folder = path.join(jobs, requestId);
      await fs.mkdir(folder, { recursive: true });
      const createdAt = Date.now() / 1000;
      const hardDeadline = createdAt + (options.maxRequestAgeSec ?? 900);
      let deadline = Math.min(createdAt + (options.timeoutSec ?? 900), hardDeadline);
      let lastRenewed = Date.now();
      const targetSeconds = options.targetDurationSec ?? 20;
      const request = { song, mode: 'complete_section', target_seconds: targetSeconds, created_at: createdAt, deadline };
      const temporary = path.join(folder, 'request.tmp');
      await fs.writeFile(temporary, JSON.stringify(request));
      await fs.rename(temporary, path.join(folder, 'request.json'));
      pendingItem.phase = 'processing';
      log(`[sing] 已受理 · ${destination} · ${song} · 队列第${position}首`);
      while (Date.now() / 1000 < deadline) {
        // Renew the processing/queueing lease within the total request limit;
        // a live worker heartbeat alone cannot extend a request forever.
        if (Date.now()-lastRenewed > 30000 && await ready()) {
          deadline = Math.min(Date.now()/1000 + (options.timeoutSec ?? 900), hardDeadline);
          request.deadline = deadline;
          await fs.writeFile(temporary, JSON.stringify(request));
          await fs.rename(temporary, path.join(folder, 'request.json'));
          lastRenewed = Date.now();
        }
        let state;
        try { state = JSON.parse(await fs.readFile(path.join(folder, 'status.json'), 'utf8')); }
        catch { state = null; }
        if (state?.state === 'done') {
          let audio;
          try { audio = await fs.readFile(path.join(folder, 'result.mp3')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; audio = await fs.readFile(path.join(folder, 'result.wav')); }
          const wav = audio.toString('ascii', 0, 4) === 'RIFF';
          const mp3 = audio.toString('ascii', 0, 3) === 'ID3' || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0);
          if (audio.length < 1000 || (!wav && !mp3)) {
            throw new Error('音频格式或大小异常');
          }
          pendingItem.phase = 'sending';
          const response = await send([{
            type: 'record', data: { file: 'base64://' + audio.toString('base64') },
          }]);
          if (!response.ok) throw new Error(response.error ?? '语音发送失败');
          result.audio = true;
          result.sent = true;
          lastSent.set(requester, Date.now());
          log(`[sing] 完整乐段翻唱已发送 · ${destination} · ${song}`);
          return result;
        }
        if (state?.state === 'error') {
          await say(state.message ?? '这次生成失败了，换一首试试。');
          return result;
        }
        await sleep(500);
      }
      await say('这首生成超时了，这次先不唱了。');
    } catch (error) {
      log(`[sing] 生成或发送失败：${error.message}`);
      try { await say('这次生成或发送失败了，稍后再试试。'); } catch { /* already logged */ }
    } finally {
      pending.delete(requestId);
      // A user-facing timeout does not mean the independent worker has exited.
      // Keep other models out until its terminal status (or lost heartbeat).
      if (release && folder) {
        while (await ready()) {
          try { await fs.access(path.join(folder, 'status.json')); break; }
          catch { await sleep(500); }
        }
      }
      if (folder) await fs.writeFile(path.join(folder, 'finished'), '').catch(() => {});
      await release?.();
    }
    return result;
  }

  return { match, handle, request, status, ready, start };
}
