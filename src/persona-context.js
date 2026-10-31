/**
 * Separate prior-persona dialogue from current style examples without deleting
 * conversation records. The archived turns are available only for explicit
 * retrospective questions; callers must not feed them back as style examples.
 * Opting into user-turn isolation also breaks an old argument/topic loop.
 */
export function projectPersonaHistory(history = [], { since, isolateUserTurns = false } = {}) {
  const current = [], archivedAssistant = [], archivedHistory = [];
  for (const turn of Array.isArray(history) ? history : []) {
    const functional = turn?.source === 'bilibili' || turn?.source === 'singing' || turn?.factual === true;
    const oldDialogue = (turn?.role === 'assistant' || (isolateUserTurns === true && turn?.role === 'user')) && !functional &&
      Number.isFinite(since) && Number.isFinite(turn.ts) && turn.ts < since;
    if (oldDialogue) {
      archivedHistory.push(turn);
      if (turn.role === 'assistant') archivedAssistant.push(turn);
    } else current.push(turn);
  }
  return { history: current, archivedAssistant, archivedHistory };
}
