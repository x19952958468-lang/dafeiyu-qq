import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/config.js';
import { createEngine } from '../src/pipeline.js';

// Every dependency is in memory. This suite never connects to QQ, Bilibili or an LLM.
const SELF = '10000', OWNER = '20000', IGNORED = '30000';
const GROUP = '40000', MUTED = '50000';
const RECORD = '【B站最近记录】\n视频：《测试标题》（已观看）\n评论原文：“第一句。第二句！”——结果未知，不能当作已发布。\n推荐：尚未发送；链接：https://www.bilibili.com/video/BV1234567890/';

function privateEvent(id = 1, text = '你刚才在B站看了什么？', user = OWNER) {
  return { post_type: 'message', message_type: 'private', self_id: SELF, user_id: user,
    message_id: id, sender: { nickname: '测试主人' }, message: [{ type: 'text', data: { text } }] };
}
function groupEvent(id = 1, group = GROUP, user = OWNER) {
  return { ...privateEvent(id, '你刚才在B站看了什么？', user), message_type: 'group', group_id: group,
    message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: '你刚才在B站看了什么？' } }] };
}
function setup({ context = { factual: true, system: '来自本地活动记录', directReply: RECORD },
  chat = () => ({ text: '这句话藏着好奇心。', cost: 0.01 }), gate = { ok: true }, singing = false,
  configure = () => {}, contextError = null } = {}) {
  const cfg = structuredClone(DEFAULTS);
  Object.assign(cfg.trigger, { interjectRate: 0, ignoreUserIds: [IGNORED],
    requireWords: { words: ['好奇心'], everyN: 1, style: 'integrated' } });
  cfg.whitelist = { groups: [GROUP, MUTED], friends: [OWNER] };
  cfg.mutedGroups = [MUTED];
  cfg.reply = { maxChars: 12, maxSegments: 1, typingCharsPerSec: 1e6, segmentGapMs: [0, 0] };
  configure(cfg);
  const sent = [], appends = [], gates = [], replies = [], spends = [], chats = [], contextCalls = [], songCalls = [], logs = [];
  const history = new Map();
  const store = {
    append(key, entry) { appends.push({ key, ...entry }); history.set(key, [...(history.get(key) || []), entry]); },
    context(key) { return { history: history.get(key) || [], notes: ['共享记忆标记'] }; },
  };
  const engine = createEngine({ cfg, persona: '你是喜欢观察和提问的测试助手。', store,
    transport: {
      async sendPrivate(user, segments) { sent.push({ user, segments }); return { ok: true, data: { message_id: 100 + sent.length } }; },
      async sendGroup(group, segments) { sent.push({ group, segments }); return { ok: true, data: { message_id: 100 + sent.length } }; },
      async call() { throw new Error('Unexpected protocol lookup'); },
    },
    limits: { gate(args) { gates.push(args); return gate; }, spend(value) { spends.push(value); }, noteReply(args) { replies.push(args); } },
    llm: { async chat(args) { chats.push(args); return await chat(args, chats.length); }, async shouldReply() { throw new Error('Unexpected reply judge'); } },
    singer: { match() { return singing; }, async handle(evt, options) { songCalls.push({ evt, options }); return { sent: false, audio: true, song: '测试歌曲' }; } },
    async getConversationContext(evt) { contextCalls.push(evt); if (contextError) throw contextError; return typeof context === 'function' ? context(evt) : context; },
    log(line) { logs.push(line); },
  });
  return { cfg, engine, sent, appends, gates, replies, spends, chats, contextCalls, songCalls, logs };
}
const texts = sent => sent.map(message => message.segments.filter(segment => segment.type === 'text').map(segment => segment.data.text).join(''));

test('direct private facts bypass the LLM and preserve the complete record in transport and shared memory', async () => {
  const s = setup({ chat() { throw new Error('Direct facts must not call the LLM'); } });
  assert.ok(RECORD.length > s.cfg.reply.maxChars);
  const result = await s.engine.handle(privateEvent());
  assert.equal(result.spoke, true);
  assert.deepEqual(result.parts, [RECORD]);
  assert.deepEqual(texts(s.sent), [RECORD]);
  assert.equal(s.sent[0].user, OWNER);
  assert.equal(s.chats.length, 0);
  assert.deepEqual(s.spends, []);
  assert.equal(s.contextCalls.length, 1);
  assert.equal(s.gates.length, 1);
  assert.equal(s.gates[0].groupId, null);
  assert.deepEqual(s.replies, [{ groupId: null }]);
  assert.deepEqual(s.appends.filter(entry => entry.role === 'assistant'), [
    { key: `p:${OWNER}`, role: 'assistant', name: '大肥鱼', content: RECORD, factual: true },
  ]);
});

test('consecutive identical factual replies retain brackets and are not rejected as repetition', async () => {
  const s = setup();
  const first = await s.engine.handle(privateEvent(10));
  const second = await s.engine.handle(privateEvent(11, '再发一次刚才的记录'));
  assert.equal(first.spoke, true);
  assert.equal(second.spoke, true);
  assert.deepEqual(texts(s.sent), [RECORD, RECORD]);
  assert.equal(s.chats.length, 0);
  assert.equal(s.replies.length, 2);
});

test('dry direct facts preserve the complete text without sending or claiming a sent reply', async () => {
  const s = setup();
  const result = await s.engine.handle(privateEvent(), { dry: true });
  assert.deepEqual(result.parts, [RECORD]);
  assert.equal(s.sent.length, 0);
  assert.equal(s.chats.length, 0);
  assert.equal(s.replies.length, 0);
  assert.equal(s.gates.length, 1);
  assert.equal(s.appends.filter(entry => entry.role === 'assistant').length, 0);
});

test('non-direct factual answers receive the evidence and skip mandatory persona terms and rewriting', async () => {
  const marker = '活动证据：测试视频已观看，评论发布结果未知。';
  const s = setup({ context: { factual: true, system: marker }, chat: () => ({ text: RECORD, cost: 0.02 }) });
  const result = await s.engine.handle(privateEvent(), { dry: true });
  assert.equal(s.chats.length, 1, 'No retries to force a catchphrase');
  assert.deepEqual(result.parts, [RECORD]);
  const system = s.chats[0].messages.find(message => message.role === 'system').content;
  assert.ok(system.includes(marker));
  assert.match(system, /共享记忆标记/);
  assert.match(system, /不要求招牌词/);
  assert.match(system, /不能声称执行了本轮未执行的操作/);
  assert.doesNotMatch(system, /这一句\*\*必须\*\*/);
  assert.doesNotMatch(system, /本轮风格：心理术语/);
  assert.deepEqual(s.spends, [0.02]);
  assert.equal(s.sent.length, 0);
});

test('ordinary private chat retains requireWords enforcement and its integrated persona instructions', async () => {
  const s = setup({ context: null, chat: (_args, call) => ({ text: call === 1 ? '今天挺忙。' : '这叫好奇心。' }) });
  const result = await s.engine.handle(privateEvent(1, '今天真忙'), { dry: true });
  assert.equal(s.chats.length, 2, 'Missing signature word must still trigger a rewrite');
  assert.match(result.parts.join(''), /好奇心/);
  const system = s.chats[0].messages[0].content;
  assert.match(system, /这一句\*\*必须\*\*包含「好奇心」/);
  assert.match(system, /本轮风格：心理术语/);
  assert.equal(s.sent.length, 0);
});

test('factual replies do not consume the normal persona catchphrase cadence', async () => {
  let factual = true;
  const s = setup({ context: () => factual ? { factual: true, directReply: RECORD } : null,
    configure(cfg) { cfg.trigger.requireWords.everyN = 2; },
    chat: (_args, call) => ({ text: call === 1 ? '先喝口水。' : '工作也会好奇心。' }) });
  await s.engine.handle(privateEvent(1), { dry: true });
  factual = false;
  await s.engine.handle(privateEvent(2, '今天真忙'), { dry: true });
  await s.engine.handle(privateEvent(3, '任务还没做完'), { dry: true });
  assert.equal(s.chats.length, 2);
  assert.doesNotMatch(s.chats[0].messages[0].content, /这一句\*\*必须\*\*/);
  assert.match(s.chats[1].messages[0].content, /这一句\*\*必须\*\*包含「好奇心」/);
});

test('ignored, muted, and non-whitelisted events cannot reach factual context or sending', async t => {
  const cases = [
    ['ignored private sender', privateEvent(1, '唱测试歌曲', IGNORED)],
    ['ignored group sender', groupEvent(2, GROUP, IGNORED)],
    ['muted group', groupEvent(3, MUTED)],
    ['non-whitelisted group', groupEvent(4, '60000')],
    ['non-whitelisted private sender', privateEvent(5, '你看了什么', '70000')],
    ['self message', privateEvent(6, '你看了什么', SELF)],
  ];
  for (const [name, event] of cases) await t.test(name, async () => {
    const s = setup({ singing: true });
    await s.engine.handle(event);
    assert.equal(s.contextCalls.length, 0);
    assert.equal(s.chats.length, 0);
    assert.equal(s.songCalls.length, 0);
    assert.equal(s.sent.length, 0);
    assert.equal(s.appends.length, 0);
  });
});

test('singing remains ahead of factual context in both private and group messages', async () => {
  const s = setup({ singing: true });
  await s.engine.handle(privateEvent(1, '唱测试歌曲'), { dry: true });
  await s.engine.handle(groupEvent(2), { dry: true });
  assert.equal(s.songCalls.length, 2);
  assert.ok(s.songCalls.every(call => call.options.dry === true));
  assert.equal(s.contextCalls.length, 0);
  assert.equal(s.chats.length, 0);
  assert.equal(s.sent.length, 0);
  assert.equal(s.gates.length, 2);
  assert.ok(s.gates.every(gate => gate.bypassCooldown));
  assert.equal(s.appends.filter(entry => entry.role === 'assistant').length, 2);
});

test('group replies do not receive private Bilibili activity context', async () => {
  const s = setup();
  const result = await s.engine.handle(groupEvent(), { dry: true });
  assert.equal(s.contextCalls.length, 0);
  assert.equal(s.chats.length, 1);
  assert.match(result.parts.join(''), /好奇心/);
  assert.equal(s.sent.length, 0);
});

test('the original limits gate can stop direct factual replies before the provider runs', async () => {
  const s = setup({ gate: { ok: false, reason: 'budget' } });
  await s.engine.handle(privateEvent());
  assert.equal(s.gates.length, 1);
  assert.equal(s.contextCalls.length, 0);
  assert.equal(s.chats.length, 0);
  assert.equal(s.sent.length, 0);
  assert.equal(s.replies.length, 0);
  assert.equal(s.appends.filter(entry => entry.role === 'assistant').length, 0);
});

test('provider failure cannot fall back to invented activity or leak its raw error', async () => {
  const s = setup({ contextError: new Error('private-token=DO_NOT_PRINT') });
  const result = await s.engine.handle(privateEvent(), { dry: true });
  assert.equal(result.spoke, false);
  assert.equal(result.reason, 'context-error');
  assert.equal(s.chats.length, 0);
  assert.equal(s.sent.length, 0);
  assert.doesNotMatch(s.logs.join('\n'), /DO_NOT_PRINT/);
});

test('directReply without factual:true cannot bypass ordinary chat rules', async () => {
  const s = setup({ context: { directReply: RECORD } });
  const result = await s.engine.handle(privateEvent(), { dry: true });
  assert.equal(s.chats.length, 1);
  assert.notDeepEqual(result.parts, [RECORD]);
  assert.match(result.parts.join(''), /好奇心/);
});
