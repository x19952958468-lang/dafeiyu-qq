import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../src/config.js';
import { createEngine } from '../src/pipeline.js';
import { createStore } from '../src/memory.js';
import { createReplyDelivery } from '../src/speech/index.js';
import { createSpeech } from './helpers/speech-fixture.js';
import { createBilibiliCompanion } from '../src/bilibili/service.js';

// Generation, model processes, Bilibili and QQ are mocked. Only disposable local
// history/transcript files are real, so restart and shared-memory checks are meaningful.
const OWNER = '70102', OTHER = '70108', IGNORED = '70113', SELF = '70115';
const GROUP = '70117', MUTED = '70119';
function event(id, text = '用语音和我说句话', user = OWNER, quote) {
  return { post_type: 'message', message_type: 'private', self_id: SELF, user_id: user, message_id: id,
    sender: { nickname: '测试朋友' }, message: [...(quote == null ? [] : [{ type: 'reply', data: { id: String(quote) } }]), { type: 'text', data: { text } }] };
}
function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-integration-'));
  const cfg = structuredClone(DEFAULTS);
  cfg.trigger.interjectRate = 0;
  cfg.trigger.ignoreUserIds = [IGNORED];
  cfg.whitelist = { friends: [OWNER, OTHER], groups: [GROUP, MUTED] };
  cfg.mutedGroups = [MUTED];
  cfg.reply = { maxChars: 80, maxSegments: 1, typingCharsPerSec: 1e6, segmentGapMs: [0, 0] };
  cfg.context.maxChars = 10000;
  options.configure?.(cfg);
  const store = createStore({ dir: path.join(root, 'memory'), ctx: cfg.context, mem: cfg.memory });
  const calls = { chats: [], syntheses: [], sends: [], lookups: [], gates: [], replies: [], deliveries: [] };
  const registries = [], cleanups = [];
  function registry() { const value = createSpeech({ rootDir: root }); registries.push(value); return value; }
  const firstRegistry = registry();
  const transport = {
    async sendPrivate(userId, segments) {
      calls.sends.push({ userId, segments });
      return options.send ? options.send({ userId, segments }, calls.sends.length) : { ok: true, data: { message_id: 700 + calls.sends.length } };
    },
    async sendGroup(groupId, segments) {
      calls.sends.push({ groupId, segments });
      return { ok: true, data: { message_id: 700 + calls.sends.length } };
    },
    async call(action) {
      if (action === 'get_friend_list') return { ok: true, data: [{ user_id: OWNER, nickname: '主人' }] };
      if (action === 'get_msg') return { ok: false };
      throw new Error('Unexpected protocol call: ' + action);
    },
  };
  const limits = { gate(args) { calls.gates.push(args); return options.blocked ? { ok: false, reason: 'quiet' } : { ok: true }; },
    spend() {}, noteReply(args) { calls.replies.push(args); } };
  function speechFor(transcripts) {
    return { config: () => ({ enabled: true }),
      async synthesize(args) {
        calls.syntheses.push(args);
        if (options.synthesize) return options.synthesize(args, calls.syntheses.length);
        return { mode: 'voice', audio: Buffer.from('mock-audio'), text: '渲染器提供的错误转写不得覆盖原文' };
      },
      lookup(id, key) { calls.lookups.push({ id: String(id), key }); return transcripts.lookup(id, key); },
      remember: transcripts.remember,
    };
  }
  function make(transcripts = firstRegistry) {
    const speech = speechFor(transcripts);
    const deliver = createReplyDelivery({ speech, transport, log() {} });
    const deliverReply = args => { calls.deliveries.push(args); return deliver(args); };
    const engine = createEngine({ cfg, persona: '你是大肥鱼。', store, limits, transport, speech, deliverReply,
      llm: { async chat(args) { calls.chats.push(args); return options.chat ? options.chat(args, calls.chats.length) : { text: '今天终于见到你了。' }; } },
      getConversationContext: options.context || (() => null), log() {},
    });
    return { engine, speech, deliverReply };
  }
  const initial = make();
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); store.flush(); await Promise.all(registries.map(value => value.stop())); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, cfg, store, calls, transport, limits, registry: firstRegistry, cleanup: fn => cleanups.push(fn), reopen: () => make(registry()), ...initial };
}
const assistantTurns = h => h.store.get(`p:${OWNER}`).history.filter(turn => turn.role === 'assistant');

test('pipeline final text becomes voice while shared history and persisted transcript keep the actual words', async t => {
  const h = harness(t, { chat: () => ({ text: '好的，今天——终于见到你了。【动作】' }) });
  const result = await h.engine.handle(event(1));
  const final = '今天，终于见到你了。';
  assert.deepEqual(result.parts, [final]);
  assert.equal(h.calls.syntheses.length, 1);
  assert.equal(h.calls.syntheses[0].text, final);
  assert.equal(h.calls.syntheses[0].key, `p:${OWNER}`);
  assert.equal(h.calls.sends.length, 1);
  assert.equal(h.calls.sends[0].segments[0].type, 'record');
  assert.deepEqual(assistantTurns(h).map(turn => turn.content), [final]);
  assert.deepEqual(assistantTurns(h)[0].delivered, [{ mode: 'voice', messageId: 701 }]);
  h.store.flush();
  const reopenedStore = createStore({ dir: path.join(h.root, 'memory'), ctx: h.cfg.context, mem: h.cfg.memory });
  assert.equal(reopenedStore.context(`p:${OWNER}`).history.at(-1).content, final);
  const restarted = h.reopen();
  assert.equal(restarted.speech.lookup(701, `p:${OWNER}`).text, final);
  assert.equal(restarted.speech.lookup(701, `p:${OTHER}`), null);
});

test('after engine restart a quoted voice ID resolves its persisted text only in the same conversation', async t => {
  const privateText = '主人秘密约定的专属句子。';
  const h = harness(t, { chat: () => ({ text: privateText }) });
  await h.engine.handle(event(1));
  const restarted = h.reopen();
  await restarted.engine.handle(event(2, '你刚才说什么？', OWNER, 701), { dry: true });
  assert.ok(h.calls.chats.at(-1).messages.at(-1).content.includes(privateText));
  await restarted.engine.handle(event(3, '这句是什么意思？', OTHER, 701), { dry: true });
  assert.ok(!JSON.stringify(h.calls.chats.at(-1).messages).includes(privateText));
  assert.ok(h.calls.lookups.some(call => call.id === '701'));
  assert.equal(h.calls.sends.length, 1);
});

test('in-memory voice quote cache also cannot expose another private conversation', async t => {
  const privateText = '这句私聊内容只能让主人看到。';
  const h = harness(t, { chat: () => ({ text: privateText }) });
  await h.engine.handle(event(1));
  await h.engine.handle(event(2, '引用这个语音', OTHER, 701), { dry: true });
  assert.ok(!JSON.stringify(h.calls.chats.at(-1).messages).includes(privateText), 'A cached quote must be scoped just like a persisted quote');
});

test('voice quotes use dialogue without stage notes before and after restart while history retains the original', async t => {
  const original = '我在这里。（声音抖着，鼻音很浓）你听见了吗？';
  const spoken = '我在这里。你听见了吗？';
  const h = harness(t, { chat: () => ({ text: original }) });
  await h.engine.handle(event(1));
  assert.equal(assistantTurns(h)[0].content, original);
  assert.equal(h.registry.lookup(701, `p:${OWNER}`).text, spoken);
  await h.engine.handle(event(2, '你刚才说什么？', OWNER, 701), { dry: true });
  const quoted = `（对方在回你前面说的「${spoken}」）`;
  assert.ok(h.calls.chats.at(-1).messages.at(-1).content.includes(quoted));
  const restarted = h.reopen();
  await restarted.engine.handle(event(3, '你刚才说什么？', OWNER, 701), { dry: true });
  assert.ok(h.calls.chats.at(-1).messages.at(-1).content.includes(quoted));
  assert.equal(h.calls.sends.length, 1);
});

test('factual directReply remains complete through voice delivery and shared memory', async t => {
  const exact = '【B站记录】\n原评论：（第一句。）——第二句！\n发布结果未知，不能说已经发表。';
  const h = harness(t, { context: () => ({ factual: true, directReply: exact }),
    configure(cfg) { cfg.reply.maxChars = 8; cfg.trigger.requireWords = { words: ['好奇心'], everyN: 1, style: 'integrated' }; } });
  const result = await h.engine.handle(event(1, '把评论原文说给我听'));
  assert.equal(h.calls.chats.length, 0);
  assert.deepEqual(result.parts, [exact]);
  assert.equal(h.calls.syntheses[0].text, exact);
  assert.equal(h.calls.syntheses[0].factual, true);
  assert.equal(assistantTurns(h)[0].content, exact);
  assert.equal(h.registry.lookup(701, `p:${OWNER}`).text, exact);
});

test('an uncertain voice send is not retried as text or recorded as an assistant turn', async t => {
  const h = harness(t, { send() { throw new Error('mock timeout after QQ may have accepted the message'); } });
  const result = await h.engine.handle(event(1));
  assert.equal(result.spoke, false);
  assert.equal(result.reason, 'send-error');
  assert.equal(h.calls.sends.length, 1);
  assert.equal(h.calls.sends[0].segments[0].type, 'record');
  assert.equal(assistantTurns(h).length, 0);
  assert.equal(h.calls.replies.length, 0);
  assert.equal(h.registry.lookup(701, `p:${OWNER}`), null);
});

test('synthesis failure sends the original text once and stores that same text', async t => {
  const h = harness(t, { synthesize() { throw new Error('mock synthesis failed'); } });
  const result = await h.engine.handle(event(1));
  assert.equal(result.spoke, true);
  assert.equal(h.calls.sends.length, 1);
  assert.equal(h.calls.sends[0].segments[0].type, 'text');
  assert.equal(h.calls.sends[0].segments[0].data.text, result.parts[0]);
  assert.equal(assistantTurns(h)[0].content, result.parts[0]);
  assert.equal(assistantTurns(h)[0].delivered[0].mode, 'text');
  assert.equal(h.registry.lookup(701, `p:${OWNER}`), null);
});

test('simultaneous private turns wait for voice delivery and preserve the whole conversation order', async t => {
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const answers = ['第一件事已经听到了。', '接着说第二件事吧。'];
  const h = harness(t, { chat: (_args, count) => ({ text: answers[count - 1] }),
    async synthesize(_args, count) { if (count === 1) { entered(); await held; } return { mode: 'voice', audio: Buffer.from('mock') }; } });
  const first = h.engine.handle(event(1, '第一件事'));
  const second = h.engine.handle(event(2, '第二件事'));
  await started;
  assert.equal(h.calls.chats.length, 1);
  assert.deepEqual(h.store.get(`p:${OWNER}`).history.map(turn => turn.content), ['第一件事']);
  release(); await Promise.all([first, second]);
  assert.deepEqual(h.store.get(`p:${OWNER}`).history.map(turn => turn.content), ['第一件事', answers[0], '第二件事', answers[1]]);
  assert.deepEqual(h.calls.syntheses.map(call => call.text), answers);
  assert.ok(h.calls.chats[1].messages.some(message => message.role === 'assistant' && message.content === answers[0]));
  assert.equal(h.calls.sends.length, 2);
});

test('dry run, ignored users, muted groups, silent groups and quiet gates never synthesize or send', async t => {
  const h = harness(t);
  await h.engine.handle(event(1), { dry: true });
  assert.equal(h.calls.chats.length, 1);
  assert.equal(h.calls.syntheses.length, 0);
  assert.equal(h.calls.sends.length, 0);
  assert.equal(assistantTurns(h).length, 0);
  h.calls.chats.length = 0;
  await h.engine.handle(event(2, '哭着说句话', IGNORED, 701));
  await h.engine.handle({ ...event(3), message_type: 'group', group_id: MUTED });
  await h.engine.handle({ ...event(4, '普通聊天没有叫你'), message_type: 'group', group_id: GROUP });
  assert.equal(h.calls.chats.length, 0);
  assert.equal(h.calls.lookups.length, 0);
  assert.equal(h.calls.syntheses.length, 0);
  assert.equal(h.calls.sends.length, 0);
  const quiet = harness(t, { blocked: true });
  await quiet.engine.handle(event(5));
  assert.equal(quiet.calls.gates.length, 1);
  assert.equal(quiet.calls.chats.length + quiet.calls.syntheses.length + quiet.calls.sends.length, 0);
});

test('Bilibili recommendations use forceText and keep the exact clickable URL in the same store', async t => {
  const h = harness(t);
  fs.writeFileSync(path.join(h.root, 'persona.md'), '用一句话说清楚自己的观察。');
  h.cfg.persona.file = 'persona.md';
  const video = { bvid: 'BV1hXbN6VEKV', aid: 10, cid: 20, title: '演奏视频', author: '作者', duration: 50,
    url: 'https://www.bilibili.com/video/BV1hXbN6VEKV?from=shared&test=1' };
  const recommendation = '听到这段时想起你了，这个节奏很有意思。';
  const service = createBilibiliCompanion({ rootDir: h.root, cfg: h.cfg, store: h.store, limits: h.limits,
    transport: h.transport, deliverReply: h.deliverReply,
    client: { status: async () => ({ loggedIn: true, uid: '42', name: '测试账号' }),
      popular: async () => [video], recommendations: async () => [video], search: async () => [video], video: async () => video,
      postComment: async () => { throw new Error('Commenting is disabled in this test'); } },
    analyzer: { analyze: async () => ({ evidenceLevel: 'video', evidenceText: '抽样画面为乐器演奏', coverage: { videoSeconds: 50 } }) },
    llm: { chat: async () => ({ text: JSON.stringify({ score: 9, summary: '乐器演奏节奏清楚。', wantComment: false, comment: '', wantShare: true, recommendation, tags: ['音乐'] }) }) },
    log() {},
  });
  h.cleanup(() => service.stop());
  await service.configure({ ownerQq: OWNER, enabled: true, commentPerDay: 0 });
  await service.runNow({ dryRun: false }); await service.whenIdle();
  const exact = recommendation + '\n' + video.url;
  assert.equal(h.calls.deliveries.length, 1);
  assert.equal(h.calls.deliveries[0].forceText, true);
  assert.equal(h.calls.deliveries[0].source, 'bilibili');
  assert.equal(h.calls.syntheses.length, 0);
  assert.equal(h.calls.sends.length, 1);
  assert.deepEqual(h.calls.sends[0].segments, [{ type: 'text', data: { text: exact } }]);
  assert.equal(assistantTurns(h)[0].content, exact);
  assert.equal(assistantTurns(h)[0].source, 'bilibili');
  assert.equal(new URL(assistantTurns(h)[0].content.split('\n').at(-1)).href, video.url);
});
