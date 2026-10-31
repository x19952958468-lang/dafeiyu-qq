import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../src/config.js';
import { createStore } from '../src/memory.js';
import { createEngine } from '../src/pipeline.js';

async function setup(t, { empty = false, protocolHistory = [] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-chat-'));
  const cfg = structuredClone(DEFAULTS), now = Date.now();
  cfg.persona.activatedAt = now - 1000;
  cfg.reply.typingCharsPerSec = 1000000;
  cfg.whitelist = { groups: ['12345'], friends: [] };
  const store = createStore({ dir, ctx: { maxAgeSec: 600, maxTurns: 20, maxChars: 3000 }, mem: { noteCount: 10, noteMaxChars: 100 } });
  const key = 'p:20000';
  if (!empty) {
    store.append(key, { role: 'user', name: '用户', content: '旧话题我还记得' }, now - 3000);
    store.append(key, { role: 'assistant', content: '旧诊断范例，不要模仿' }, now - 2500);
    store.append(key, { role: 'assistant', source: 'bilibili', content: '视频确实已经分享' }, now - 2000);
    store.append(key, { role: 'assistant', content: '新角色已经说过的话' }, now - 500);
    store.addNote(key, '用户喜欢游戏');
  }
  const calls = [];
  const engine = createEngine({ cfg, persona: '你是亲切自然的聊天助手。', store,
    llm: { async chat({ messages }) { calls.push(messages); return { text: '过来聊一会儿嘛。' }; } },
    limits: { gate: () => ({ ok: true }), spend() {}, noteReply() {} },
    transport: { call: async () => ({ data: { messages: protocolHistory } }), getLoginInfo: async () => ({ data: { user_id: '10000' } }) }, log() {} });
  const event = text => ({ post_type: 'message', message_type: 'private', self_id: '10000', user_id: '20000',
    message_id: 777, sender: { nickname: '用户' }, message: [{ type: 'text', data: { text } }] });
  t.after(async () => { store.flush(); await fs.rm(dir, { recursive: true, force: true }); });
  return { engine, calls, store, event, key, now };
}

test('new persona prompt excludes the prior conversation but keeps facts, notes and raw history', async t => {
  const h = await setup(t);
  await h.engine.handle(h.event('陪我说会儿话'), { dry: true });
  const messages = h.calls[0], all = JSON.stringify(messages);
  assert.ok(!all.includes('旧诊断范例'));
  assert.ok(!all.includes('旧话题我还记得'));
  assert.ok(all.includes('用户喜欢游戏'));
  assert.ok(messages.some(m => m.role === 'assistant' && m.content === '视频确实已经分享'));
  assert.ok(messages.some(m => m.role === 'assistant' && m.content === '新角色已经说过的话'));
  assert.ok(h.store.get(h.key).history.some(m => m.content === '旧诊断范例，不要模仿'));
  assert.ok(h.store.get(h.key).history.some(m => m.content === '旧话题我还记得'));
});

test('looking back can retrieve a prior utterance as labeled evidence, never as an assistant example', async t => {
  const h = await setup(t);
  await h.engine.handle(h.event('你刚才说了什么'), { dry: true });
  const messages = h.calls[0];
  assert.ok(messages[0].content.includes('旧诊断范例'));
  assert.ok(messages[0].content.includes('旧话题我还记得'));
  assert.ok(messages[0].content.includes('不是当前口吻范例'));
  assert.ok(!messages.some(m => m.role === 'assistant' && m.content.includes('旧诊断范例')));
});

test('proactive fallback history applies the same persona boundary', async t => {
  const now = Date.now();
  const message = (uid, content, ts) => ({ time: ts / 1000, sender: { user_id: uid, nickname: uid === '20000' ? '用户' : '大肥鱼' }, message: [{ type: 'text', data: { text: content } }] });
  const h = await setup(t, { empty: true, protocolHistory: [message('10000', '旧诊断范例，不要模仿', now - 4000), message('20000', '旧争执，不要续演', now - 2000), message('20000', '刚赢了一把游戏', now)] });
  await h.engine.poke({ groupId: '12345', qq: '20000', name: '用户', preview: true });
  const all = JSON.stringify(h.calls[0]);
  assert.ok(!all.includes('旧诊断范例'));
  assert.ok(!all.includes('旧争执'));
  assert.ok(all.includes('刚赢了一把游戏'));
});
