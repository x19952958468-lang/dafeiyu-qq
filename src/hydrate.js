import { truncate } from './util.js';
import { isIgnoredUser } from './user-policy.js';

/**
 * 启动时把群里最近的消息拉回来当上下文。
 *
 * 为什么需要：沙箱里 data/sessions/*.json 写不进去，进程一重启上下文就空了——
 * 结果是它刚上线时一脸茫然（「这么晚还不睡呀，在忙什么」这种空话），
 * 也接不上刚才在聊的事。拉一次历史就补上了。
 */
function plainText(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message
    .filter((s) => s.type === 'text')
    .map((s) => s.data?.text ?? '')
    .join('')
    .trim();
}

export async function hydrateGroups({ cfg, transport, store, log = console.log }) {
  const groups = cfg.whitelist?.groups ?? [];
  if (!groups.length) return;

  const info = await transport.getLoginInfo();
  const selfId = String(info?.data?.user_id ?? '');
  const maxAgeMs = (cfg.hydrateMaxAgeSec ?? 1800) * 1000;
  const now = Date.now();

  for (const groupId of groups) {
    try {
      const r = await transport.call('get_group_msg_history', { group_id: Number(groupId), count: 20 });
      const list = r?.data?.messages ?? [];
      if (!list.length) continue;

      let n = 0;
      for (const m of list) {
        const text = plainText(m.message);
        if (!text) continue;
        const ts = Number(m.time) ? Number(m.time) * 1000 : now;
        if (now - ts > maxAgeMs) continue;
        const uid = String(m.sender?.user_id ?? '');
        if (isIgnoredUser(cfg, uid)) continue;
        const isSelf = !!selfId && uid === selfId;
        if (isSelf && ts < (cfg.persona.activatedAt ?? 0)) continue;
        const parts = Array.isArray(m.message) ? m.message : [];
        const addressed = parts.filter(s => s.type === 'at').map(s => String(s.data?.qq || '')).filter(x => /^\d+$/.test(x) && x !== selfId);
        const replyId = parts.find(s => s.type === 'reply')?.data?.id;
        const replied = replyId != null ? list.find(x => String(x.message_id) === String(replyId)) : null;
        const targetUser = isSelf ? addressed.length === 1 ? addressed[0] : addressed.length === 0 ? String(replied?.sender?.user_id || '') : '' : '';
        store.append(
          `g:${groupId}`,
          {
            role: isSelf ? 'assistant' : 'user',
            name: isSelf ? cfg.persona.selfName : m.sender?.card || m.sender?.nickname || uid,
            content: truncate(text, 200),
            ...(targetUser && targetUser !== selfId ? { replyToUserId: targetUser,
              replyToName: replied?.sender?.card || replied?.sender?.nickname || '' } : {}),
          },
          ts,
        );
        n += 1;
      }
      if (n) log(`  回填    群${groupId} ${n} 条最近消息`);
    } catch (e) {
      log(`  回填失败 群${groupId}：${e.message}`);
    }
  }
}
