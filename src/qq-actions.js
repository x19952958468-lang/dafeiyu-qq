import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const id = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const validId = value => /^\d{5,20}$/.test(id(value));
const ignored = (cfg, user) => (cfg.trigger?.ignoreUserIds || []).map(String).includes(String(user));
const plainText = evt => Array.isArray(evt?.message)
  ? evt.message.filter(part => part.type === 'text').map(part => String(part.data?.text || '')).join('')
  : typeof evt?.message === 'string' ? evt.message : '';
const clarify = summary => ({ state: 'clarification', summary });
const failed = summary => ({ state: 'failed', summary });
const groupPronoun = /^(?:(?:这|那)(?:个)?群|群|群里|群体|这里|那里)$/;
const personPronoun = /^(?:他|她|它|那个人|这个人|对方)$/;
const pluralPerson = /^(?:他们|她们|它们|所有人|全体成员|all)$/i;
const RECENT_TARGET_MS = 10 * 60000;

/** Owner-requested, literal QQ relay. Parsing and any clarification stay upstream. */
export function createQqActions({ cfg, transport, store, getOwner, getRecentTargets, log = () => {}, dataDir }) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('QQ_ACTION_DATA_DIR_REQUIRED');
  const ledgerFile = path.join(dataDir, 'sent.json');
  let records = {}, ledgerAvailable = true;
  const pending = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    if (saved?.version !== 1 || !saved.records || typeof saved.records !== 'object' || Array.isArray(saved.records) ||
        Object.values(saved.records).some(record => !record || !['completed', 'failed', 'unknown'].includes(record.state))) throw new Error('INVALID_LEDGER');
    records = saved.records;
  } catch (error) {
    if (error.code !== 'ENOENT') { ledgerAvailable = false; log('[qq-actions] 发送记录不可读，已停止跨群发送'); }
  }

  function persist() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${ledgerFile}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, records })}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, ledgerFile);
      fs.chmodSync(ledgerFile, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  function ownerFor(evt) {
    const owner = id(getOwner?.()), sender = id(evt?.user_id ?? evt?.sender?.user_id);
    if (evt?.post_type !== 'message' || evt.message_type !== 'private' || !validId(owner) || !validId(evt.self_id) || sender !== owner ||
        sender === id(evt.self_id) || ignored(cfg, sender)) return null;
    const friends = (cfg.whitelist?.friends || []).map(String);
    return friends.length && !friends.includes(sender) ? null : owner;
  }
  function groupAllowed(group) {
    // An empty allowlist never grants cross-group messaging to arbitrary groups.
    return (cfg.whitelist?.groups || []).map(String).includes(group) &&
      !(cfg.mutedGroups || []).map(String).includes(group);
  }
  function duplicate(record) {
    if (record.state === 'completed') return { state: 'completed', duplicate: true,
      summary: `这条指令已经向群 ${record.groupId} 发送成功，不会重复发送。` };
    if (record.state === 'failed') return { state: 'failed', duplicate: true,
      summary: '这条指令上次发送失败，本次没有重复发送。' };
    return { state: 'unknown', duplicate: true, summary: '这条指令已经尝试发送，但结果未确认；为避免重复，本次没有再次发送。' };
  }
  async function lookup(method, params) {
    try {
      const result = await transport.call(method, params);
      return result?.ok && Array.isArray(result.data) ? result.data : null;
    } catch { return null; }
  }
  function remember(key, entry) {
    try { store?.append(key, entry); }
    catch { log('[qq-actions] 发送结果已确认，但共享聊天记录写入失败'); }
  }

  async function recentTargets() {
    if (typeof getRecentTargets !== 'function') return [];
    try {
      const values = await getRecentTargets();
      if (!Array.isArray(values)) return [];
      const stamp = Date.now(), groups = new Map();
      for (const value of values) {
        const groupId = id(value?.groupId), age = stamp - Number(value?.lastSpokeAt);
        if (!validId(groupId) || !Number.isFinite(age) || age < 0 || age > RECENT_TARGET_MS) continue;
        const rows = groups.get(groupId) || [];
        rows.push(value); groups.set(groupId, rows);
      }
      return [...groups].map(([groupId, rows]) => {
        const result = { groupId, lastSpokeAt: Math.max(...rows.map(row => Number(row.lastSpokeAt))) };
        const members = new Set(rows.map(row => validId(row.memberQq) ? id(row.memberQq) : ''));
        if (members.size === 1 && !members.has('')) {
          result.memberQq = [...members][0];
          const names = new Set(rows.map(row => typeof row.memberName === 'string' ? row.memberName : ''));
          if (names.size === 1 && !names.has('')) result.memberName = [...names][0];
        }
        return result;
      });
    } catch { log('[qq-actions] 最近群目标暂不可用'); return []; }
  }

  async function run(evt, action, owner, eventKey, priorRequestText) {
    if (records[eventKey]) return duplicate(records[eventKey]);
    const requestText = plainText(evt);
    if (action.requestText !== undefined && action.requestText !== requestText) return failed('指令正文与当前消息不一致，本次未发送。');
    const trustedSource = [priorRequestText || '', requestText].join('\n');
    const hasId = value => new RegExp(`(?:^|[^0-9])${value}(?![0-9])`).test(trustedSource);
    if (typeof action.text !== 'string' || !action.text.trim()) return clarify('请写明要发送的原话；我不会自行代拟要发给别人的内容。');
    const text = action.text;
    if (text.length > 1200 || /\[\s*CQ\s*:|@(?:所有人|全体成员|all)\b|@(?:所有人|全体成员)/i.test(text) || /[\x00-\x08\x0b-\x1f]/.test(text)) {
      return failed('消息正文过长或包含不支持的消息代码、全体提醒，本次未发送。');
    }
    if (!trustedSource.includes(text)) return clarify('请明确写出要发送的原话；我不会用自行改写的内容发送。');

    const recent = await recentTargets();
    const uniqueRecent = recent.length === 1 ? recent[0] : null;
    const suppliedGroupId = action.groupId == null ? '' : id(action.groupId);
    const suppliedGroupName = typeof action.groupName === 'string' ? action.groupName.trim() : '';
    if (suppliedGroupId && !validId(suppliedGroupId)) return clarify('请提供有效的目标群号。');
    const literalGroupId = !!suppliedGroupId && hasId(suppliedGroupId);
    const literalGroupName = !!suppliedGroupName && !groupPronoun.test(suppliedGroupName) && trustedSource.includes(suppliedGroupName);
    // "Another group" is a deliberate change of target, never a reference to the last one.
    const otherGroupRequested = /别的群|另一个群|其他群|其它群|换(?:个|一个)群/.test(trustedSource.split(text).join(''));
    let selectedGroupId = suppliedGroupId, selectedGroupName = groupPronoun.test(suppliedGroupName) ? '' : suppliedGroupName;
    if (!literalGroupId && !literalGroupName) {
      if (selectedGroupName) return clarify('请亲自写明目标群的完整群名或群号，我不会替你猜目标群。');
      if (otherGroupRequested) return clarify('你说的是另一个群，请给出要改发的完整群名或群号。');
      if (!uniqueRecent) return clarify(recent.length > 1
        ? '我刚才在不止一个群说过话，请明确这次发到哪个群。'
        : '最近十分钟没有唯一可沿用的群，请给出完整群名或群号。');
      if (selectedGroupId && selectedGroupId !== uniqueRecent.groupId) return clarify('当前指令没有给出这个群，最近发言记录也不能唯一对应，请明确目标群。');
      selectedGroupId = uniqueRecent.groupId;
    } else {
      if (suppliedGroupName && !groupPronoun.test(suppliedGroupName) && !literalGroupName) return clarify('请亲自写明目标群的完整群名，我不会替你猜目标群。');
      if (suppliedGroupId && !literalGroupId && !recent.some(target => target.groupId === suppliedGroupId)) return clarify('当前指令和最近发言记录都没有这个群号，请核对目标群。');
    }
    if (selectedGroupId && !groupAllowed(selectedGroupId)) return failed('这个群不在允许发言的群列表中，或当前已暂停发言，本次未发送。');
    const groups = await lookup('get_group_list', {});
    if (!groups) return failed('暂时无法读取 QQ 群列表，本次未发送。');
    const matches = groups.filter(group => (!selectedGroupId || id(group.group_id) === selectedGroupId) &&
      (!selectedGroupName || group.group_name === selectedGroupName));
    if (matches.length !== 1) return clarify(matches.length > 1 ? '有多个群使用这个名字，请给出目标群号。' : '没有找到唯一对应的群，请核对完整群名或群号。');
    const group = id(matches[0].group_id), groupName = String(matches[0].group_name || group);
    if (!validId(group) || !groupAllowed(group)) return failed('这个群不在允许发言的群列表中，或当前已暂停发言，本次未发送。');

    const suppliedMentionId = action.mentionQq == null ? '' : id(action.mentionQq);
    const suppliedMentionName = typeof action.mentionName === 'string' ? action.mentionName.trim() : '';
    const recentMember = recent.find(target => target.groupId === group);
    let mention = '', mentionLabel = '';
    if (suppliedMentionId || suppliedMentionName) {
      if ((suppliedMentionId && !validId(suppliedMentionId)) || pluralPerson.test(suppliedMentionName || suppliedMentionId)) {
        return clarify('请明确要 @ 的单个成员昵称或 QQ 号，不能把多个人或全体成员作为目标。');
      }
      let selectedMentionId = suppliedMentionId;
      let selectedMentionName = personPronoun.test(suppliedMentionName) ? '' : suppliedMentionName;
      if (suppliedMentionId && !hasId(suppliedMentionId) && suppliedMentionId !== recentMember?.memberQq) return clarify('当前指令和这个群最近的回复记录不能确定该成员，请写明昵称或 QQ 号。');
      if (personPronoun.test(suppliedMentionName) && !selectedMentionId) {
        if (!recentMember?.memberQq) return clarify('这个群最近没有唯一明确的回复对象，请写明“他/她”指哪位成员。');
        selectedMentionId = recentMember.memberQq;
      }
      if (selectedMentionName && !trustedSource.includes(selectedMentionName)) {
        if (selectedMentionName !== recentMember?.memberName || !recentMember?.memberQq ||
            selectedMentionId && selectedMentionId !== recentMember.memberQq) return clarify('请亲自写明要 @ 的成员昵称或 QQ 号，我不会替你猜具体成员。');
        selectedMentionId = recentMember.memberQq;
        selectedMentionName = '';
      }
      const members = await lookup('get_group_member_list', { group_id: group });
      if (!members) return failed('暂时无法读取目标群的成员列表，本次未发送。');
      const memberMatches = new Map(members.filter(member => (!selectedMentionId || id(member.user_id) === selectedMentionId) &&
        (!selectedMentionName || member.card === selectedMentionName || member.nickname === selectedMentionName))
        .map(member => [id(member.user_id), member]));
      if (memberMatches.size !== 1) return clarify(memberMatches.size > 1 ? '目标群里有多个同名成员，请给出要 @ 的 QQ 号。' : '目标群里没有找到这个成员，请核对昵称或 QQ 号。');
      const member = [...memberMatches.values()][0];
      mention = id(member.user_id); mentionLabel = String(member.card || member.nickname || mention);
      if (!validId(mention) || ignored(cfg, mention)) return failed('这个成员当前不接受机器人互动，本次未发送。');
    }

    // Lookups may await a reconnect. Recheck mutable policy immediately before writing.
    if (ownerFor(evt) !== owner || !groupAllowed(group) || mention && ignored(cfg, mention)) return failed('发言权限或目标状态已经变化，本次未发送。');
    records[eventKey] = { state: 'unknown', groupId: group, time: Date.now(),
      textHash: crypto.createHash('sha256').update(text).digest('hex'), ...(mention ? { mentionQq: mention } : {}) };
    try { persist(); }
    catch { delete records[eventKey]; return failed('发送记录未能保存，本次未发送。'); }

    const segments = [...(mention ? [{ type: 'at', data: { qq: mention } }] : []), { type: 'text', data: { text } }];
    let response;
    try { response = await transport.sendGroup(group, segments); }
    catch { response = { ok: false, unknown: true }; }
    const definitelyUnsent = response?.unknown === false || response?.notSent === true ||
      ['尚未连接到协议端', '该群已暂停发言'].includes(response?.error);
    const state = response?.ok === true ? 'completed' : definitelyUnsent ? 'failed' : 'unknown';
    records[eventKey].state = state;
    try { persist(); } catch { log('[qq-actions] 发送后记录未能更新；重启后将按结果未知处理，不会重发'); }
    const target = `群「${groupName}」（${group}）${mention ? `的 @${mentionLabel}（${mention}）` : ''}`;
    const summary = state === 'completed' ? `已向${target}发送：\n${text}` : state === 'failed'
      ? `向${target}发送失败，这条消息没有发出。` : `已尝试向${target}发送，但 QQ 没有确认结果；不会自动重发。`;
    const entry = { role: 'assistant', source: 'qq_action', factual: true, action: 'qq_send', actionState: state,
      groupId: group, ...(mention ? { mentionQq: mention } : {}), ...(response?.data?.message_id != null ? { messageId: response.data.message_id } : {}) };
    if (state === 'completed') remember(`g:${group}`, { ...entry, content: `${mention ? `@${mentionLabel} ` : ''}${text}` });
    remember(`p:${owner}`, { ...entry, content: summary });
    return { state, summary };
  }

  async function execute(evt, action, { priorRequestText = '' } = {}) {
    const owner = ownerFor(evt);
    if (!owner) return failed('只有绑定的主人私聊可以要求跨群发送消息。');
    if (!action || action.type !== 'qq_send') return failed('不支持这个 QQ 操作。');
    if (typeof priorRequestText !== 'string' || priorRequestText.length > 12000) return failed('待补充指令记录无效，本次未发送。');
    if (!ledgerAvailable) return failed('发送记录不可用，本次未发送。');
    const messageId = id(evt.message_id);
    if (!messageId || messageId.length > 80 || /[\x00-\x20]/.test(messageId)) return failed('当前消息缺少可核对的消息编号，本次未发送。');
    const eventKey = `${owner}:${id(evt.self_id)}:${messageId}`;
    if (pending.has(eventKey)) {
      await pending.get(eventKey);
      return records[eventKey] ? duplicate(records[eventKey]) : failed('这条指令已在处理，本次未重复执行。');
    }
    const work = run(evt, action, owner, eventKey, priorRequestText);
    pending.set(eventKey, work);
    try { return await work; }
    finally { pending.delete(eventKey); }
  }
  return { execute };
}
