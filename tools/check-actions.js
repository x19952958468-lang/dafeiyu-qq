import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActions } from '../src/actions.js';
import { parseActionIntent } from '../src/action-intent.js';
import { createEngine } from '../src/pipeline.js';
import { DEFAULTS } from '../src/config.js';
import { recentGroupTargets } from '../src/action-context.js';

const evt = (text, id = 1) => ({ post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20000,
  message_id: id, sender: { nickname: '测试用户' }, message: [{ type: 'text', data: { text } }] });
function setup(t, options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-check-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const sent = [], facts = [], calls = [], plans = [];
  const transport = { async sendPrivate(id, segments) { sent.push({ id, segments }); return { ok: true }; },
    async sendGroup(id, segments) { sent.push({ id, segments }); return { ok: true }; } };
  const store = { append(key, value) { facts.push({ key, ...value }); }, context() { return { history: [], notes: [] }; } };
  const limits = { gate: () => ({ ok: true }), spend() {}, noteReply() {} };
  const llm = { async planAction(args) { plans.push(args); return { action: options.plan?.(args) ?? { type: 'chat' } }; },
    async chat() { throw new Error('Unexpected persona generation'); } };
  const make = () => createActions({ rootDir, cfg: {}, llm, store, transport, limits, singer: options.singer,
    getBilibili: () => ({ async executeAction(e, action) { calls.push(action); return options.execute ? await options.execute(action) : { state: 'completed', summary: '操作已完成。' }; } }),
    qqActions: options.qqActions });
  const actions = make();
  return { actions, make, llm, sent, facts, calls, plans, rootDir, transport, store, limits };
}
test('intent parser rejects invented tools and malformed arguments', () => {
  for (const raw of ['{"type":"shell","cmd":"anything"}', '[]', '{"type":"sing","song":42}']) assert.throws(() => parseActionIntent(raw));
  assert.deepEqual(parseActionIntent('{"type":"chat","task":true,"command":"ignored"}'), { type: 'chat', task: true });
});
test('natural action calls the executor instead of persona generation and records real result', async t => {
  const s = setup(t, { plan: () => ({ type: 'bili_pause' }) });
  const result = await s.actions.handle({ evt: evt('先别刷B站了'), text: '先别刷B站了' });
  assert.equal(result.handled, true); assert.equal(s.calls.length, 1);
  assert.equal(s.facts.at(-1).factual, true); assert.equal(s.sent[0].segments[0].data.text, '操作已完成。');
});
test('duplicate delivery after process restart does not repeat an action', async t => {
  const s = setup(t, { plan: () => ({ type: 'bili_resume' }) });
  const input = { evt: evt('继续刷B站'), text: '继续刷B站' };
  await s.actions.handle(input);
  assert.equal((await s.make().handle(input)).duplicate, true);
  assert.equal(s.calls.length, 1);
});
test('overlapping duplicate messages invoke executor only once', async t => {
  const s = setup(t, { plan: () => ({ type: 'bili_pause' }) });
  await Promise.all([s.actions.handle({ evt: evt('暂停B站'), text: '暂停B站' }), s.actions.handle({ evt: evt('暂停B站'), text: '暂停B站' })]);
  assert.equal(s.calls.length, 1);
});
test('a singing job runs without blocking its progress query', async t => {
  let complete;
  const s = setup(t, { singer: { match: () => null, request: () => new Promise(resolve => { complete = resolve; }),
    status: () => ({ pending: [{ song: '晴天', phase: 'processing', elapsedSec: 17 }] }) },
    plan: ({ text }) => text.includes('进度') ? { type: 'singing_status' } : { type: 'sing', song: '晴天' } });
  assert.equal((await s.actions.handle({ evt: evt('我想听你唱晴天'), text: '我想听你唱晴天' })).state, 'accepted');
  assert.match((await s.actions.handle({ evt: evt('点歌进度', 2), text: '点歌进度' })).summary, /正在生成.*17秒/);
  assert.equal(s.facts.some(x => /已发送/.test(x.content)), false);
  complete({ audio: true, sent: true }); await s.actions.whenIdle();
  assert.match(s.facts.at(-1).content, /已发送《晴天》/);
});
test('missing song and invented BV do not call an executor', async t => {
  const s = setup(t, { plan: ({ text }) => text.includes('唱') ? { type: 'repeat_singing' } : { type: 'bili_inspect', bvid: 'BV1234567890' } });
  assert.match((await s.actions.handle({ evt: evt('再唱一遍'), text: '再唱一遍' })).summary, /哪首/);
  assert.match((await s.actions.handle({ evt: evt('看看那个视频', 2), text: '看看那个视频' })).summary, /BV号/);
  assert.equal(s.calls.length, 0);
});
test('voice requests and literal reading produce content directives, not fake execution', async t => {
  const s = setup(t, { plan: ({ text }) => text.includes('晚安') ? { type: 'speak', text: '晚安' } : { type: 'speech_reply' } });
  assert.deepEqual(await s.actions.handle({ evt: evt('来句哭腔我听听'), text: '来句哭腔我听听' }), { handled: false, task: true, voice: true });
  assert.equal((await s.actions.handle({ evt: evt('用语音说：晚安', 2), text: '用语音说：晚安' })).literal, '晚安');
  assert.equal(s.sent.length, 0);
});
test('dry run neither executes nor consumes the real message', async t => {
  const s = setup(t, { plan: () => ({ type: 'bili_pause' }) });
  const input = { evt: evt('暂停B站'), text: '暂停B站' };
  await s.actions.handle({ ...input, dry: true }); assert.equal(s.calls.length, 0); assert.equal(s.sent.length, 0);
  await s.actions.handle(input); assert.equal(s.calls.length, 1);
});
test('a vague cross-group request asks for missing information and can continue a draft', async t => {
  const executed = [];
  const s = setup(t, { plan: ({ recentAction }) => ({ type: 'qq_send', ...(recentAction ? { groupName: '测试群', text: '晚上好' } : {}) }),
    qqActions: { async execute(e, a, c) { executed.push({ a, c }); return { state: 'clarification', summary: '要发到哪个群？请给群名和要发送的原话。' }; } } });
  const example = '去群里提醒他一句';
  assert.match((await s.actions.handle({ evt: evt(example), text: example })).summary, /哪个群/);
  await s.actions.handle({ evt: evt('测试群，说“晚上好”', 2), text: '测试群，说“晚上好”' });
  assert.equal(executed[1].c.priorRequestText, example);
  assert.equal(executed[1].a.requestText, '测试群，说“晚上好”');
});
test('pipeline keeps access checks before actions and preserves exact instructed text', async t => {
  const s = setup(t); const cfg = structuredClone(DEFAULTS);
  cfg.whitelist = { friends: ['20000'], groups: ['30000'] }; cfg.mutedGroups = ['30000'];
  cfg.reply = { maxChars: 2, maxSegments: 1, typingCharsPerSec: 1e9 };
  let called = 0; const deliveries = [];
  const literal = '这里是一段必须保持完整的测试台词。';
  const engine = createEngine({ cfg, persona: '普通聊天角色', llm: s.llm, store: s.store, limits: s.limits, transport: s.transport,
    actions: { async handle() { called++; return { handled: false, task: true, voice: true, literal }; } },
    async deliverReply(args) { deliveries.push(args); return { ok: true, mode: 'voice' }; }, log() {} });
  await engine.handle({ ...evt('语音读原文'), message_type: 'group', group_id: 30000 });
  assert.equal(called, 0);
  await engine.handle(evt('语音读原文', 2));
  assert.equal(deliveries[0].text, literal); assert.equal(deliveries[0].explicit, true);
});
test('cancel and topic changes invalidate an unfinished relay draft', async t => {
  for (const change of ['算了不发了', '今天好开心', '用语音说晚安']) {
    const s = setup(t, { plan: ({ text }) => text === change ? { type: change.includes('语音') ? 'speech_reply' : 'chat' } : { type: 'qq_send' },
      qqActions: { async execute() { return { state: 'clarification', summary: '请补充要发的原话。' }; } } });
    await s.actions.handle({ evt: evt('去群里发消息'), text: '去群里发消息' });
    await s.actions.handle({ evt: evt(change, 2), text: change });
    await s.actions.handle({ evt: evt('测试群', 3), text: '测试群' });
    assert.equal(s.plans.at(-1).recentAction, null);
  }
});
test('requested video inspection does not block a subsequent pause', async t => {
  let finish;
  const s = setup(t, { plan: ({ text }) => text.includes('暂停') ? { type: 'bili_pause' } : { type: 'bili_inspect', bvid: 'BV1234567890' },
    execute: action => action.type === 'bili_inspect' ? new Promise(resolve => { finish = resolve; }) : { state: 'completed', summary: '已暂停' } });
  assert.equal((await s.actions.handle({ evt: evt('看BV1234567890'), text: '看BV1234567890' })).state, 'accepted');
  assert.equal((await s.actions.handle({ evt: evt('暂停B站', 2), text: '暂停B站' })).summary, '已暂停');
  finish({ state: 'completed', summary: '视频实际摘要' }); await s.actions.whenIdle();
  assert.equal(s.facts.at(-1).content, '视频实际摘要');
});
test('comment contents questions still use the factual conversation bridge', async t => {
  const s = setup(t, { plan: () => ({ type: 'bili_status' }) });
  assert.deepEqual(await s.actions.handle({ evt: evt('刚才评论了什么'), text: '刚才评论了什么' }), { handled: false, task: true });
  assert.equal(s.calls.length, 0);
});
test('group singing without the existing required mention is not falsely accepted', async t => {
  let requests = 0;
  const s = setup(t, { plan: () => ({ type: 'sing', song: '晴天' }), singer: { request() { requests++; } } });
  const event = { ...evt('唱晴天'), message_type: 'group', group_id: 30000 };
  assert.match((await s.actions.handle({ evt: event, text: '唱晴天' })).summary, /请先 @我/);
  assert.equal(requests, 0);
});
test('recent targets use actual bot turns, preserve ambiguity and expire stale evidence', () => {
  const now = 1000000, history = new Map();
  const cfg = { whitelist: { groups: ['30000', '40000'] }, mutedGroups: ['40000'] };
  const store = { get: key => ({ history: history.get(key) || [] }) };
  history.set('g:30000', [{ role: 'user', ts: now - 2, content: '有人说话' },
    { role: 'assistant', ts: now - 100, replyToUserId: '20000', replyToName: '小明' }]);
  assert.deepEqual(recentGroupTargets({ cfg, store, now }), [{ groupId: '30000', lastSpokeAt: now - 100, memberQq: '20000', memberName: '小明' }]);
  history.set('g:40000', [{ role: 'assistant', ts: now - 200 }]);
  assert.equal(recentGroupTargets({ cfg, store, now }).length, 2, 'A subsequently muted group must not silently select another group');
  history.set('g:30000', [{ role: 'assistant', ts: now - 100, replyToUserId: '20000' }, { role: 'assistant', ts: now - 50, replyToUserId: '50000' }]);
  assert.equal(recentGroupTargets({ cfg, store, now })[0].memberQq, undefined);
  assert.deepEqual(recentGroupTargets({ cfg, store, now: now + 600001 }), []);
});
