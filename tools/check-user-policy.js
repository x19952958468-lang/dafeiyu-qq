import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/config.js';
import { createEngine } from '../src/pipeline.js';
import { createPoker } from '../src/poke.js';
import { hydrateGroups } from '../src/hydrate.js';

const GROUP = '70118', FOCUS = '70106', IGNORED = '70110';
function setup() {
  const cfg = structuredClone(DEFAULTS);
  Object.assign(cfg.trigger, { interjectRate: 0, ignoreUserIds: [IGNORED], focusUsers: [
    { qq: FOCUS, group: GROUP, name: '目标群友', replyAlways: true, atMention: true, singleReply: true },
  ] });
  cfg.whitelist.groups = [GROUP, '70121'];
  cfg.reply.typingCharsPerSec = 1e6;
  const sent = [], stored = [], gates = [];
  let calls = 0, singing = 0;
  const transport = { sendGroup: async (group, segments) => { sent.push({ group, segments }); return { ok: true, data: { message_id: sent.length } }; },
    sendPrivate: async () => { throw Error('unexpected private reply'); }, call: async () => ({ ok: false }) };
  const store = { append: (...args) => stored.push(args), context: () => ({ history: [], notes: [] }) };
  const limits = { gate: args => { gates.push(args); return { ok: true }; }, spend() {}, noteReply() {} };
  const engine = createEngine({ cfg, persona: '', transport, store, limits,
    llm: { chat: async () => { calls++; return { text: '你又来了。\n这回接住了。' }; } },
    singer: { match: () => { singing++; return null; } }, log() {} });
  return { cfg, sent, stored, gates, engine, transport, store, limits, calls: () => calls, singing: () => singing };
}
function event(id, user = FOCUS, message = [{ type: 'text', data: { text: '今天又加班了' } }]) {
  return { post_type: 'message', message_type: 'group', self_id: '70109', user_id: user,
    group_id: GROUP, message_id: id, sender: { nickname: user === FOCUS ? '目标群友' : '忽略群友' }, message };
}

test('ignored sender is dropped before LLM, context, quote lookup, and singing', async () => {
  const s = setup();
  await s.engine.handle(event(1, IGNORED, [{ type: 'reply', data: { id: '1' } }, { type: 'at', data: { qq: '70109' } }, { type: 'text', data: { text: '唱朋友的酒 肥鱼' } }]));
  await s.engine.handle({ ...event(2, IGNORED), message_type: 'private' });
  assert.equal(s.calls(), 0); assert.equal(s.singing(), 0); assert.equal(s.stored.length, 0); assert.equal(s.sent.length, 0);
});
test('focused sender gets one @ reply for each consecutive message, in order', async () => {
  const s = setup();
  await Promise.all([s.engine.handle(event(10)), s.engine.handle(event(11)), s.engine.handle(event(12))]);
  assert.equal(s.sent.length, 3);
  assert.deepEqual(s.sent.map(x => x.segments.find(a => a.type === 'reply')?.data.id), ['10', '11', '12']);
  assert.ok(s.sent.every(x => x.segments.some(a => a.type === 'at' && a.data.qq === FOCUS)));
  assert.ok(s.gates.every(x => x.bypassCooldown));
});
test('duplicate delivery of the same focused message does not create another reply', async () => {
  const s = setup(); await Promise.all([s.engine.handle(event(20)), s.engine.handle(event(20))]);
  assert.equal(s.sent.length, 1);
});
test('focus is limited to the configured group', async () => {
  const s = setup(); await s.engine.handle({ ...event(30), group_id: '70121' });
  assert.equal(s.sent.length, 0);
});
test('focused image-only messages also get one reply', async () => {
  const s = setup(); await s.engine.handle(event(40, FOCUS, [{ type: 'image', data: { summary: '[哈哈哈]' } }]));
  assert.equal(s.sent.length, 1); assert.match(s.stored[0][1].content, /哈哈哈/);
});
test('ignored sender cannot be proactively mentioned', async () => {
  const s = setup(); const r = await s.engine.poke({ groupId: GROUP, qq: IGNORED, name: '忽略群友' });
  assert.equal(r.reason, 'ignored-user'); assert.equal(s.calls(), 0); assert.equal(s.sent.length, 0);
});
test('proactive picker excludes ignored users and targets the configured member', async () => {
  const s = setup(), picks = [];
  s.cfg.proactiveAt = { groups: [GROUP], everySec: 0, minGapAfterBotSec: 0, targetUsersByGroup: { [GROUP]: [FOCUS] } };
  const transport = { call: async () => ({ ok: true, data: { messages: [IGNORED, '999', FOCUS].map((uid, i) => ({ sender: { user_id: uid, nickname: uid }, time: Math.floor(Date.now()/1000)-i, message: [{ type: 'text', data: { text: '今天真忙' } }] })) } }), getLoginInfo: async () => ({ data: { user_id: '70109' } }) };
  const p = createPoker({ cfg: s.cfg, transport, limits: s.limits, engine: { stats: () => ({ lastReplyAt: 0 }), poke: async args => picks.push(args) }, log() {} });
  await p.tick(); assert.equal(picks.length, 1); assert.equal(picks[0].qq, FOCUS);
});
test('startup history does not import ignored sender messages', async () => {
  const s = setup(); s.cfg.whitelist.groups = [GROUP];
  const transport = { getLoginInfo: async () => ({ data: { user_id: '70109' } }), call: async () => ({ ok: true, data: { messages: [IGNORED, FOCUS].map(uid => ({ sender: { user_id: uid }, time: Date.now()/1000, message: [{ type: 'text', data: { text: uid } }] })) } }) };
  await hydrateGroups({ cfg: s.cfg, transport, store: s.store, log() {} });
  assert.equal(s.stored.length, 1); assert.equal(s.stored[0][1].content, FOCUS);
});
