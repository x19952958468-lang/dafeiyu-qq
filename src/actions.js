import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseActionIntent } from './action-intent.js';

export function createActions({ rootDir, cfg, llm, singer, getBilibili, getRecentTargets, qqActions, transport, store, limits, log = () => {} }) {
  const file = rootDir && path.join(rootDir, 'data/actions/state.json');
  let state = { recent: {}, seen: {} };
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  const running = new Map();
  const background = new Set();
  const identity = evt => `${evt.message_type === 'group' ? `g:${evt.group_id}` : 'p'}:${evt.user_id ?? evt.sender?.user_id}`;
  const keyOf = evt => evt.message_type === 'group' ? `g:${evt.group_id}` : `p:${evt.user_id ?? evt.sender?.user_id}`;
  function persist() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, file); }
    finally { fs.rmSync(tmp, { force: true }); }
  }
  function note(evt, action, result) {
    const id = identity(evt);
    state.recent[id] = { action, state: result.state, summary: result.summary, at: Date.now() };
    state.recent = Object.fromEntries(Object.entries(state.recent).slice(-200));
    persist();
    log(`[action] ${action.type} ${result.state}`);
  }
  async function say(evt, summary, dry = false) {
    if (dry) return { handled: true, summary, dry: true };
    const isGroup = evt.message_type === 'group';
    let sent;
    try { sent = await (isGroup ? transport.sendGroup(evt.group_id, [{ type: 'text', data: { text: summary } }])
      : transport.sendPrivate(evt.user_id, [{ type: 'text', data: { text: summary } }])); }
    catch { sent = { ok: false }; }
    if (sent?.ok) {
      store.append(keyOf(evt), { role: 'assistant', content: summary, source: 'actions', factual: true });
      limits.noteReply({ groupId: isGroup ? String(evt.group_id) : null });
    }
    return { handled: true, summary, sent: sent?.ok === true };
  }
  async function handle({ evt, text, dry = false }) {
    const id = identity(evt), key = keyOf(evt);
    const prior = state.recent[id];
    const recent = prior && Date.now() - prior.at < 30 * 60000 ? prior : null;
    const eventId = evt.message_id == null ? null : `${id}:${evt.message_id}`;
    if (eventId && state.seen[eventId]) return { handled: true, duplicate: true };
    if (recent?.state === 'clarification' && recent.action.type === 'qq_send' &&
      /^(?:算了[，,\s]*)?(?:算了|不发了|取消(?:了|发送)?|不用了|别发(?:了)?|撤销)[。！!\s]*$/.test(text)) {
      if (!dry) { delete state.recent[id]; persist(); }
      return say(evt, '待补充的传话请求已取消，没有发送消息。', dry);
    }
    let action;
    try {
      if (llm.planAction) {
        const isOwner = evt.message_type === 'private' && String(evt.user_id) === String(getBilibili()?.getConfig?.().ownerQq);
        const planned = await llm.planAction({ text, recentAction: recent,
          recentTargets: isOwner ? getRecentTargets?.() || [] : [] });
        if (planned.cost) limits.spend(planned.cost);
        action = parseActionIntent(planned.action ?? planned.text);
      } else return { handled: false };
    } catch {
      log('[action] intent_unavailable');
      return say(evt, '这次没能解析你的指令，操作还没有执行，请再发一次。', dry);
    }
    if (action.type !== 'qq_send' && recent?.state === 'clarification' && recent.action.type === 'qq_send' && !dry) {
      delete state.recent[id]; persist();
    }
    if (action.type === 'chat') {
      return { handled: false, task: action.task };
    }
    if (action.type === 'speech_reply') return { handled: false, task: true, voice: true };
    if (action.type === 'bili_status' && /评论|留言/.test(text) && /什么|啥|原文|内容|哪句/.test(text)) return { handled: false, task: true };
    if (action.type === 'speak') {
      if (!action.text || !text.includes(action.text)) return say(evt, '把要念的原文发给我，我会按原文说。', dry);
      return { handled: false, task: true, voice: true, literal: action.text };
    }
    // Reserve before any external action. Re-delivery never retries an uncertain send.
    if (!dry && eventId) {
      if (state.seen[eventId]) return { handled: true, duplicate: true };
      state.seen[eventId] = Date.now();
      state.seen = Object.fromEntries(Object.entries(state.seen).slice(-2000));
      persist();
    }
    if (action.type === 'sing' || action.type === 'repeat_singing') {
      if (evt.message_type === 'group' && !evt.message?.some?.(s => s.type === 'at' && String(s.data?.qq) === String(evt.self_id))) {
        return say(evt, '在群里点歌请先 @我，再说歌名，这次还没开始生成。', dry);
      }
      const status = singer?.status?.(evt);
      const title = action.type === 'repeat_singing' ? status?.lastSong || (recent?.action.type === 'sing' ? recent.action.song : '') : action.song;
      if (!title) return say(evt, '你想听哪首？把歌名告诉我。', dry);
      if (action.type === 'sing' && !text.normalize('NFKC').includes(title.normalize('NFKC'))) return say(evt, '请把准确的歌名告诉我，我再开始生成。', dry);
      if (!singer?.request) return say(evt, '唱歌功能暂时不可用，这次没有开始生成。', dry);
      if (dry) return { handled: true, action: { type: 'sing', song: title }, dry: true };
      if (running.has(id)) return say(evt, '你上一首还在生成。可以问我“点歌进度”。');
      const selected = { type: 'sing', song: title };
      note(evt, selected, { state: 'accepted', summary: `已提交《${title}》点歌请求，尚未生成完成。` });
      const job = singer.request(evt, { song: title }).then(async result => {
        const summary = result.audio ? `已发送《${title}》的唱歌语音。` : '本次点歌没有完成音频发送。';
        if (state.recent[id]?.action.type === 'sing' && state.recent[id]?.action.song === title)
          note(evt, selected, { state: result.audio ? 'completed' : 'failed', summary });
        if (result.sent) store.append(key, { role: 'assistant', source: 'singing', factual: true, content: summary,
          ...(evt.message_type === 'group' ? { replyToUserId: String(evt.user_id), replyToName: evt.sender?.card || evt.sender?.nickname || '' } : {}) });
        if (result.sent) limits.noteReply({ groupId: evt.message_type === 'group' ? String(evt.group_id) : null });
      }).catch(() => {
        note(evt, selected, { state: 'failed', summary: '点歌处理异常，未确认发送成功。' });
      }).finally(() => running.delete(id));
      running.set(id, job);
      return { handled: true, state: 'accepted' };
    }
    if (action.type === 'singing_status') {
      if (evt.message_type === 'group' && !evt.message?.some?.(s => s.type === 'at' && String(s.data?.qq) === String(evt.self_id)))
        return say(evt, '在群里查询点歌进度请先 @我。', dry);
      const status = singer?.status?.(evt), jobs = status?.pending || [];
      const summary = jobs.length ? jobs.map(x => `《${x.song}》${x.phase === 'sending' ? '正在发送' : x.phase === 'processing' ? '正在生成' : '正在排队'}，已等待${Math.floor(x.elapsedSec)}秒。`).join('\n')
        : running.has(id) ? '点歌请求正在处理，音频还没有发送完成。'
        : recent?.action.type === 'sing' ? recent.summary : '你目前没有进行中的点歌任务。';
      return say(evt, summary, dry);
    }
    if (action.type === 'clarify') return say(evt, action.question || '请说清楚要做的操作和对象。', dry);
    if (action.type === 'unsupported') return say(evt, '这个操作还没有接入执行功能，我没有替你执行。现在可以点歌、发语音、在明确的群里传话，以及管理或查看B站活动。', dry);
    let result;
    if (action.type === 'qq_send') {
      const priorRequestText = recent?.state === 'clarification' && recent?.action?.type === 'qq_send' ? recent.action.requestText : '';
      const original = typeof evt.message === 'string' ? evt.message : (evt.message || []).filter(s => s.type === 'text').map(s => s.data?.text || '').join('');
      action.requestText = original;
      if (dry) return { handled: true, action, dry: true };
      try { result = qqActions ? await qqActions.execute(evt, action, { priorRequestText }) : { state: 'failed', summary: '跨群传话暂时不可用，没有发送消息。' }; }
      catch { result = { state: 'unknown', summary: '跨群传话未能确认结果，没有自动重发。' }; }
      // Keep only a short-lived, same-requester draft as evidence for a follow-up.
      if (result.state === 'clarification') action = { ...action, requestText: [priorRequestText, original].filter(Boolean).join('\n').slice(-4000) };
    } else if (action.type.startsWith('bili_')) {
      if (action.bvid && !text.includes(action.bvid) && recent?.action?.bvid !== action.bvid) return say(evt, '请给我这个视频的链接或BV号。', dry);
      if (dry) return { handled: true, action, dry: true };
      if (action.type === 'bili_inspect') {
        const bili = getBilibili();
        if (!bili?.executeAction) return say(evt, 'B站功能暂时不可用。');
        // Acknowledgement is receipt of the request, not a claim to have watched.
        await say(evt, '已收到查看视频的请求，处理结果出来后告诉你。');
        note(evt, action, { state: 'accepted', summary: '查看视频的请求正在处理，尚未完成。' });
        const job = Promise.resolve().then(() => bili.executeAction(evt, action)).catch(() => ({ state: 'failed', summary: '这次视频查看失败，没有发布评论或推送。' }))
          .then(async outcome => {
            if (state.recent[id]?.action.type === 'bili_inspect' && state.recent[id]?.action.bvid === action.bvid) note(evt, action, outcome);
            await say(evt, outcome.summary);
          }).catch(() => log('[action] inspect_result_unavailable')).finally(() => background.delete(job));
        background.add(job);
        return { handled: true, state: 'accepted' };
      }
      try { result = await getBilibili()?.executeAction(evt, action); }
      catch { result = { state: 'failed', summary: 'B站操作失败，这次没有确认完成。' }; }
      result ||= { state: 'failed', summary: 'B站功能暂时不可用。' };
    }
    result ||= { state: 'failed', summary: '这条指令还不能执行，没有进行操作。' };
    note(evt, action, result);
    return say(evt, result.summary, dry);
  }
  return { handle, whenIdle: async () => { await Promise.allSettled([...running.values(), ...background]); } };
}
