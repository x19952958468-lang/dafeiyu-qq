// Targets come only from successful bot speech, never guesses made by the LLM.
export function recentGroupTargets({ cfg, store, now = Date.now(), maxAgeMs = 10 * 60000 }) {
  const groups = [...new Set((cfg.whitelist?.groups || []).map(String))];
  const result = [];
  for (const groupId of groups) {
    const history = store.get(`g:${groupId}`).history || [];
    const turns = history.filter(t => t.role === 'assistant' && Number(t.ts) <= now && Number(t.ts) >= now - maxAgeMs &&
      (!t.actionState || t.actionState === 'completed') && t.dry !== true);
    if (!turns.length) continue;
    const members = new Map();
    for (const turn of turns) {
      const qq = String(turn.replyToUserId || turn.mentionQq || '');
      if (qq) members.set(qq, String(turn.replyToName || ''));
    }
    const target = { groupId, lastSpokeAt: Math.max(...turns.map(t => Number(t.ts))) };
    const latest = turns.reduce((a, b) => a.ts > b.ts ? a : b);
    if (members.size === 1 && (latest.replyToUserId || latest.mentionQq)) {
      const [memberQq, memberName] = [...members][0]; Object.assign(target, { memberQq, memberName });
    }
    result.push(target);
  }
  return result.sort((a, b) => b.lastSpokeAt - a.lastSpokeAt);
}
