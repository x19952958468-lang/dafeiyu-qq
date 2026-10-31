import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../src/config.js';
import { createLimits } from '../src/limits.js';
import { createEngine } from '../src/pipeline.js';

const GROUP = '70116';
function config() {
  const cfg = structuredClone(DEFAULTS);
  cfg.trigger.groupOverrides = { [GROUP]: { onlyReplyWhenMentioned: true, interjectRate: 0, enforceRateLimits: true, replyCooldownSec: 180, maxRepliesPerHour: 6, singleReply: true } };
  return cfg;
}
async function limiter(t, cfg) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dafeiyu-rate-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return createLimits({ dir, cfg });
}
test('group cooldown applies even to a direct @ while other groups retain their behavior', async t => {
  const limits = await limiter(t, config());
  assert.equal(limits.gate({ groupId: GROUP, bypassCooldown: true }).ok, true);
  limits.noteReply({ groupId: Number(GROUP) });
  assert.equal(limits.gate({ groupId: GROUP, bypassCooldown: true }).ok, false);
  limits.noteReply({ groupId: '70118' });
  assert.equal(limits.gate({ groupId: '70118', bypassCooldown: true }).ok, true);
});
test('hourly cap cannot be bypassed by @ requests', async t => {
  const cfg = config(); cfg.trigger.groupOverrides[GROUP].replyCooldownSec = 0;
  const limits = await limiter(t, cfg);
  for (let i = 0; i < 6; i++) {
    assert.equal(limits.gate({ groupId: GROUP, bypassCooldown: true }).ok, true);
    limits.noteReply({ groupId: GROUP });
  }
  assert.equal(limits.gate({ groupId: GROUP, bypassCooldown: true }).ok, false);
});
function event(id, at = false) {
  return { post_type: 'message', message_type: 'group', self_id: '123', user_id: '456', group_id: GROUP, message_id: id,
    sender: { nickname: 'other' }, message: [...(at ? [{ type: 'at', data: { qq: '123' } }] : []), { type: 'text', data: { text: '肥鱼，聊聊天' } }] };
}
function engine(cfg, chat) {
  return createEngine({ cfg, persona: '', llm: { chat }, store: { append() {}, context: () => ({ history: [], notes: [] }) }, transport: {}, limits: { gate: () => ({ ok: true }), spend() {}, noteReply() {} }, log() {} });
}
test('keywords and quoted replies do not start an unmentioned bot conversation', async () => {
  const cfg = config(); cfg.trigger.keywordWake = ['肥鱼'];
  let called = 0;
  const e = engine(cfg, async () => { called++; return { text: '你好' }; });
  e.rememberSelf('self-message', '你好', '大肥鱼', `g:${GROUP}`);
  const msg = event(1); msg.message.unshift({ type: 'reply', data: { id: 'self-message' } });
  await e.handle(msg, { dry: true });
  assert.equal(called, 0);
});
test('concurrent mentions have only one in-flight response and use one message', async () => {
  let release, calls = 0;
  const waiting = new Promise(r => { release = r; });
  const e = engine(config(), async () => { calls++; await waiting; return { text: `你好${calls}。\n今天聊什么？` }; });
  const first = e.handle(event(1, true), { dry: true });
  await e.handle(event(2, true), { dry: true });
  release();
  const result = await first;
  assert.equal(calls, 1); assert.equal(result.parts.length, 1);
  assert.equal((await e.handle(event(3, true), { dry: true }))?.spoke, true);
});
