import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../src/config.js';
import { createStore } from '../src/memory.js';
import { createEngine } from '../src/pipeline.js';
import { createReplyDelivery } from '../src/speech/reply-delivery.js';

// Real engine/delivery, disposable local memory, mocked LLM/TTS/QQ only.
const OWNER = '20000', SELF = '10000', GROUP = '30000';
const OLD = '旧角色唯一标记：用旧角色语气回复。';
const NEW = '新角色唯一标记：用新的自然语气回复。';
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const message = (id, text = '来聊一会儿') => ({ post_type: 'message', message_type: 'private', self_id: SELF,
  user_id: OWNER, message_id: id, sender: { nickname: '测试用户' }, message: [{ type: 'text', data: { text } }] });

async function fixture(t, { chat, synthesize, configure } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-hot-reload-'));
  const cfg = structuredClone(DEFAULTS);
  cfg.whitelist = { friends: [OWNER], groups: [GROUP] };
  cfg.trigger.interjectRate = 0;
  cfg.reply = { maxChars: 150, maxSegments: 1, typingCharsPerSec: 1e6, segmentGapMs: [0, 0] };
  cfg.context.maxChars = 10000;
  configure?.(cfg);
  const store = createStore({ dir, ctx: cfg.context, mem: cfg.memory });
  const calls = { chats: [], syntheses: [], sends: [], remembered: [], replies: [] };
  const transport = {
    async sendPrivate(userId, segments) { calls.sends.push({ userId, segments }); return { ok: true, data: { message_id: calls.sends.length + 700 } }; },
    async sendGroup(groupId, segments) { calls.sends.push({ groupId, segments }); return { ok: true, data: { message_id: calls.sends.length + 700 } }; },
    async call() { return { ok: true, data: { messages: [] } }; },
    async getLoginInfo() { return { ok: true, data: { user_id: SELF } }; },
  };
  const speech = {
    config: () => ({ enabled: true }),
    async synthesize(args) { calls.syntheses.push(args); return synthesize ? synthesize(args, calls.syntheses.length) : { mode: 'text' }; },
    remember(...args) { calls.remembered.push(args); },
  };
  const engine = createEngine({ cfg, persona: OLD, store, transport, speech,
    deliverReply: createReplyDelivery({ speech, transport }),
    limits: { gate: () => ({ ok: true }), spend() {}, noteReply(value) { calls.replies.push(value); } },
    llm: { async chat(args) { calls.chats.push(args); return chat ? chat(args, calls.chats.length) : { text: '今天的晚风很舒服。' }; } }, log() {},
  });
  t.after(async () => { store.flush(); await fs.rm(dir, { recursive: true, force: true }); });
  return { cfg, store, calls, engine,
    switchPersona(text = NEW) {
      // Mirrors the editor's profile reset before its onApply callback.
      delete cfg.trigger.requireWords;
      cfg.trigger.watchWords = [];
      cfg.persona.activatedAt = Date.now();
      engine.updatePersona(text);
    },
    assistantTurns: () => store.get(`p:${OWNER}`).history.filter(turn => turn.role === 'assistant'),
  };
}

test('next prompt uses new persona and clears old required words, style and history examples without deleting memory', async t => {
  const h = await fixture(t, {
    configure(cfg) { cfg.trigger.requireWords = { words: ['旧标签'], everyN: 1, style: 'integrated' }; cfg.trigger.watchWords = ['旧口头禅']; },
    chat: (_args, count) => ({ text: count === 1 ? '旧标签，旧口头禅就说到这里。' : '今天的晚风很舒服。' }),
  });
  await h.engine.handle(message(1), { dry: true });
  assert.match(h.calls.chats[0].messages[0].content, /旧标签/);
  h.store.append(`p:${OWNER}`, { role: 'assistant', content: '以前的旧标签口吻' }, Date.now() - 2000);
  h.store.addNote(`p:${OWNER}`, '用户喜欢音乐');
  h.switchPersona();
  await h.engine.handle(message(2, '今天想聊点音乐'), { dry: true });
  const messages = h.calls.chats.at(-1).messages;
  assert.match(messages[0].content, /新角色唯一标记/);
  assert.doesNotMatch(JSON.stringify(messages), /旧角色唯一标记|旧标签|旧口头禅|心理术语合计最多一个/);
  assert.match(messages[0].content, /用户喜欢音乐/);
  assert.equal(h.calls.chats.length, 2, 'No retry may reintroduce the cached old required words');
  assert.ok(h.assistantTurns().some(turn => turn.content === '以前的旧标签口吻'));
});

test('switching while the LLM is pending cancels the old reply before synthesis, send or assistant history', async t => {
  const entered = deferred(), held = deferred();
  const h = await fixture(t, { async chat(_args, count) { if (count === 1) { entered.resolve(); return held.promise; } return { text: '新角色现在接话。' }; } });
  const pending = h.engine.handle(message(1));
  await entered.promise;
  h.switchPersona();
  held.resolve({ text: '旧角色生成完成。' });
  assert.deepEqual(await pending, { spoke: false, reason: 'persona-changed' });
  assert.equal(h.calls.sends.length + h.calls.syntheses.length + h.calls.replies.length, 0);
  assert.equal(h.assistantTurns().length, 0);
  await h.engine.handle(message(2), { dry: true });
  assert.match(h.calls.chats.at(-1).messages[0].content, /新角色唯一标记/);
});

test('switching during pending speech discards old audio and the queued next reply uses the new persona', async t => {
  const entered = deferred(), held = deferred();
  const h = await fixture(t, {
    chat: (_args, count) => ({ text: count === 1 ? '旧角色正在合成。' : '新角色现在接话。' }),
    async synthesize(_args, count) { if (count === 1) { entered.resolve(); return held.promise; } return { mode: 'voice', audio: Buffer.from('new-audio') }; },
  });
  const first = h.engine.handle(message(1));
  await entered.promise;
  h.switchPersona();
  const second = h.engine.handle(message(2, '新的人设来接话'));
  held.resolve({ mode: 'voice', audio: Buffer.from('stale-audio') });
  assert.deepEqual(await first, { spoke: false, reason: 'persona-changed' });
  assert.equal((await second).spoke, true);
  assert.equal(h.calls.sends.length, 1);
  assert.deepEqual(h.calls.sends[0].segments, [{ type: 'record', data: { file: 'base64://' + Buffer.from('new-audio').toString('base64') } }]);
  assert.match(h.calls.chats[1].messages[0].content, /新角色唯一标记/);
  assert.deepEqual(h.assistantTurns().map(turn => turn.content), ['新角色现在接话。']);
  assert.equal(h.calls.remembered.length, 1);
  assert.equal(h.calls.remembered[0][1], '新角色现在接话。');
  assert.equal(h.calls.replies.length, 1);
});

test('speech failure after a persona switch cannot fall back to sending stale text', async t => {
  const entered = deferred(), held = deferred();
  const h = await fixture(t, { async synthesize() { entered.resolve(); return held.promise; } });
  const pending = h.engine.handle(message(1));
  await entered.promise;
  h.switchPersona();
  held.reject(new Error('mock synthesis failed after switch'));
  assert.deepEqual(await pending, { spoke: false, reason: 'persona-changed' });
  assert.equal(h.calls.sends.length, 0);
  assert.equal(h.calls.remembered.length, 0);
  assert.equal(h.assistantTurns().length, 0);
});

test('proactive LLM reply is also cancelled if the persona changes before delivery', async t => {
  const entered = deferred(), held = deferred();
  const h = await fixture(t, { async chat() { entered.resolve(); return held.promise; } });
  const pending = h.engine.poke({ groupId: GROUP, qq: OWNER, name: '测试用户' });
  await entered.promise;
  h.switchPersona();
  held.resolve({ text: '旧角色的主动发言。' });
  assert.deepEqual(await pending, { spoke: false, reason: 'persona-changed' });
  assert.equal(h.calls.sends.length + h.calls.syntheses.length + h.calls.replies.length, 0);
  assert.equal(h.store.get(`g:${GROUP}`).history.filter(turn => turn.role === 'assistant').length, 0);
});
