import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPersonaProfile } from '../src/persona-profile.js';
import { hydrateGroups } from '../src/hydrate.js';

const tagged = { version: 1, settings: [
  { path: ['trigger', 'requireWords'], present: true, value: { words: ['好奇心'], everyN: 2 } },
  { path: ['trigger', 'watchWords'], present: true, value: ['观察'] },
  { path: ['persona', 'naturalAddress'], present: true, value: false },
  { path: ['proactiveAt', 'goal'], present: true, value: '分享好奇心和观察。' },
] };
const friendly = { version: 1, settings: [
  { path: ['trigger', 'requireWords'], present: false },
  { path: ['trigger', 'watchWords'], present: true, value: [] },
  { path: ['persona', 'naturalAddress'], present: true, value: true },
  { path: ['proactiveAt', 'goal'], present: true, value: '简洁友善地接话。' },
] };

test('switching profile disables required words and restores prior style exactly', () => {
  const raw = { trigger: { ignoreUserIds: ['70110'], focusUsers: [{ qq: '70106' }] }, singing: { enabled: true }, mutedGroups: [] };
  applyPersonaProfile(raw, tagged);
  const original = structuredClone(raw);
  applyPersonaProfile(raw, friendly);
  assert.equal(raw.trigger.requireWords, undefined);
  assert.deepEqual(raw.trigger.watchWords, []);
  assert.equal(raw.persona.naturalAddress, true);
  assert.ok(!raw.proactiveAt.goal.includes('好奇心'));
  assert.deepEqual(raw.trigger.ignoreUserIds, original.trigger.ignoreUserIds);
  assert.deepEqual(raw.trigger.focusUsers, original.trigger.focusUsers);
  assert.deepEqual(raw.singing, original.singing);
  applyPersonaProfile(raw, tagged);
  assert.deepEqual(raw, original);
});

test('startup hydration excludes old persona responses and keeps current user context', async () => {
  const now = Date.now(), stored = [];
  const cfg = { whitelist: { groups: ['70118'] }, trigger: {}, persona: { selfName: '大肥鱼', activatedAt: now-3000 } };
  const msg = (uid, text, age) => ({ sender: { user_id: uid }, time: (now-age)/1000, message: [{ type: 'text', data: { text } }] });
  await hydrateGroups({ cfg, transport: { getLoginInfo: async () => ({ data: { user_id: '123' } }), call: async () => ({ data: { messages: [msg('123','旧人设回复',5000),msg('456','用户消息',5000),msg('123','新人设回复',1000)] } }) }, store: { append: (_, turn) => stored.push(turn) }, log() {} });
  assert.deepEqual(stored.map(x => x.content), ['用户消息','新人设回复']);
});
