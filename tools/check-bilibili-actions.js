import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBilibiliCompanion } from '../src/bilibili/service.js';

// Every external dependency is a fake. No QQ, Bilibili, or model connections.
const OWNER = '20000', SELF = '10000';
const VIDEO = { bvid: 'BV1234567890', title: '测试演奏', author: '测试作者',
  duration: 40, url: 'https://www.bilibili.com/video/BV1234567890' };
const event = overrides => ({ post_type: 'message', message_type: 'private', self_id: SELF,
  user_id: OWNER, message: 'B站状态', ...overrides });

async function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-actions-'));
  fs.writeFileSync(path.join(root, 'persona.md'), '简短友善地聊天。');
  const cfg = { persona: { file: 'persona.md' }, trigger: { ignoreUserIds: [] }, whitelist: { friends: [OWNER] } };
  const calls = { posts: 0, sends: [], chats: [], video: [], analyze: 0, history: [], accounts: 0 };
  let loggedIn = true;
  const service = createBilibiliCompanion({ rootDir: root, cfg,
    now: () => Date.parse('2026-10-30T04:00:00Z'), setTimer: () => 1, clearTimer() {},
    limits: { gate: () => options.blocked ? { ok: false, reason: '测试预算不足' } : { ok: true }, spend() {}, noteReply() {} },
    singingBusy: async () => !!options.singing,
    client: {
      async status() { calls.accounts++; return loggedIn ? { loggedIn: true, name: '测试账号', uid: '42' } : { loggedIn: false }; },
      async video(bvid) { calls.video.push(bvid); return { ...VIDEO, bvid }; },
      async popular() { return [VIDEO]; }, async recommendations() { return [VIDEO]; }, async search() { return [VIDEO]; },
      async postComment() { calls.posts++; return { ok: true, rpid: '123' }; },
    },
    analyzer: { async analyze() { calls.analyze++; if (options.analysisError) throw options.analysisError;
      if (options.waitAnalysis) await options.waitAnalysis;
      return { evidenceLevel: options.metadata ? 'metadata' : 'video', evidenceText: '抽样画面中正在演奏。', coverage: { sampledFrames: 4 } }; } },
    llm: { async chat(args) { calls.chats.push(args); return { text: args.messages[0].content.includes('只输出JSON')
      ? JSON.stringify({ score: 9, summary: '抽样画面中有演奏。', wantComment: true, comment: '这一段演奏的节奏处理很有意思。',
        wantShare: true, recommendation: '这段演奏很有意思。', tags: ['音乐'] }) : '抽样画面里有人演奏；只覆盖了部分片段。', cost: 0 }; } },
    transport: {
      async call() { return { ok: true, data: [{ user_id: OWNER, nickname: '测试主人' }] }; },
      async sendPrivate(user, content) { calls.sends.push({ user, content }); return { ok: !options.sendFailure, data: { message_id: '99' } }; },
    },
    store: { append(key, entry) { calls.history.push({ key, ...entry }); } },
  });
  service.start();
  await service.configure({ ownerQq: OWNER, enabled: options.enabled ?? true });
  t.after(async () => { await service.whenIdle().catch(() => {}); await service.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, cfg, service, calls, setLoggedIn(value) { loggedIn = value; } };
}

test('actions reject non-owner, group, self, ignored and non-whitelisted senders before any dependency call', async t => {
  const cases = [
    { evt: event({ user_id: '30000' }) }, { evt: event({ message_type: 'group', group_id: '40000' }) },
    { evt: event({ self_id: OWNER }) }, { evt: event({ post_type: 'notice' }) },
    { evt: event(), mutate: cfg => { cfg.trigger.ignoreUserIds = [OWNER]; } },
    { evt: event(), mutate: cfg => { cfg.whitelist.friends = ['30000']; } },
  ];
  for (const item of cases) {
    const h = await harness(t); item.mutate?.(h.cfg); const priorAccounts = h.calls.accounts;
    const result = await h.service.executeAction(item.evt, { type: 'bili_pause' });
    assert.equal(result.state, 'failed'); assert.equal(h.service.getConfig().enabled, true);
    assert.equal(h.calls.accounts, priorAccounts); assert.equal(h.calls.sends.length + h.calls.chats.length, 0);
  }
});

test('status, pause, resume and interests execute without sending QQ and retain validation', async t => {
  const h = await harness(t);
  assert.match((await h.service.executeAction(event(), { type: 'bili_status' })).summary, /今天看了0条/);
  assert.equal((await h.service.executeAction(event(), { type: 'bili_pause' })).state, 'completed');
  assert.equal(h.service.getConfig().enabled, false);
  assert.equal((await h.service.executeAction(event(), { type: 'bili_resume' })).state, 'completed');
  assert.equal(h.service.getConfig().enabled, true);
  assert.equal((await h.service.executeAction(event(), { type: 'bili_interests', keywords: ['音乐', '游戏'] })).state, 'completed');
  assert.deepEqual(h.service.getConfig().keywords, ['音乐', '游戏']);
  assert.equal((await h.service.executeAction(event(), { type: 'bili_interests' })).state, 'failed');
  assert.equal(h.calls.sends.length + h.calls.posts, 0);
  await h.service.executeAction(event(), { type: 'bili_pause' }); h.setLoggedIn(false);
  assert.equal((await h.service.executeAction(event(), { type: 'bili_resume' })).state, 'failed');
  assert.equal(h.service.getConfig().enabled, false);
});

test('settings permits frequencies and keywords only, persists normalized values, and rejects invalid values atomically', async t => {
  const h = await harness(t);
  const settings = { watchPerDay: 12, commentPerDay: 50, sharePerDay: 4, intervalMinutes: .5,
    shareGapMinutes: 15, commentGapMinutes: 0, keywords: '音乐，游戏' };
  const result = await h.service.executeAction(event(), { type: 'bili_settings', settings });
  assert.equal(result.state, 'completed'); assert.match(result.summary, /每天评论上限：50/);
  assert.equal(h.service.getConfig().intervalMinutes, .5); assert.deepEqual(h.service.getConfig().keywords, ['音乐', '游戏']);
  const saved = JSON.parse(fs.readFileSync(path.join(h.root, 'data/bilibili/config.json'), 'utf8'));
  assert.equal(saved.commentPerDay, 50);
  for (const bad of [{ ownerQq: '30000' }, { enabled: false }, { minScore: 1 }, { callbackUrl: 'https://invalid.example' }, {}, [],
    { commentPerDay: -1 }, { intervalMinutes: Infinity }, { keywords: [] }]) {
    const before = structuredClone(h.service.getConfig());
    assert.equal((await h.service.executeAction(event(), { type: 'bili_settings', settings: bad })).state, 'failed');
    assert.deepEqual(h.service.getConfig(), before);
  }
  assert.equal(h.calls.sends.length + h.calls.posts, 0);
  const inherited = Object.assign(Object.create({ ownerQq: '30000', enabled: false }), { intervalMinutes: 2 });
  assert.equal((await h.service.executeAction(event(), { type: 'bili_settings', settings: inherited })).state, 'completed');
  assert.equal(h.service.getConfig().ownerQq, OWNER); assert.equal(h.service.getConfig().enabled, true);
});

test('watch acknowledges acceptance before analysis completes, then uses the existing comment and share ledgers', async t => {
  let release; const waitAnalysis = new Promise(resolve => { release = resolve; });
  const h = await harness(t, { waitAnalysis });
  const result = await h.service.executeAction(event(), { type: 'bili_watch', bvid: VIDEO.bvid });
  assert.equal(result.state, 'accepted'); assert.equal(h.calls.sends.length + h.calls.posts, 0);
  assert.doesNotMatch(result.summary, /已看完|已评论|已推荐/);
  release(); await h.service.whenIdle(); assert.equal(h.calls.posts, 1); assert.equal(h.calls.sends.length, 1);
  await h.service.executeAction(event(), { type: 'bili_watch', bvid: VIDEO.bvid }); await h.service.whenIdle();
  assert.equal(h.calls.posts, 1); assert.equal(h.calls.sends.length, 1);
});

test('inspect works while automatic activity is paused and never calls the public action pipeline', async t => {
  const h = await harness(t, { enabled: false });
  const result = await h.service.executeAction(event(), { type: 'bili_inspect', bvid: VIDEO.bvid });
  assert.equal(result.state, 'completed'); assert.match(result.summary, /抽样画面/);
  assert.equal(h.calls.posts + h.calls.sends.length, 0); assert.equal(h.calls.analyze, 1);
  assert.equal((await h.service.status()).stats.todayWatched, 0);
  assert.equal(h.service.getConfig().enabled, false);
  assert.equal(h.calls.chats.length, 1); assert.doesNotMatch(h.calls.chats[0].messages[0].content, /简短友善地聊天/);
  const saved = JSON.parse(fs.readFileSync(path.join(h.root, 'data/bilibili/state.json'), 'utf8'));
  assert.deepEqual(saved.watched, {}); assert.deepEqual(saved.comments, {}); assert.deepEqual(saved.shares, {});
});

test('inspect metadata is honest, and invalid IDs cannot silently browse another video', async t => {
  const h = await harness(t, { metadata: true });
  const result = await h.service.executeAction(event(), { type: 'bili_inspect', bvid: VIDEO.bvid });
  assert.equal(result.state, 'completed'); assert.match(result.summary, /无法判断/); assert.equal(h.calls.chats.length, 0);
  for (const type of ['bili_inspect', 'bili_watch']) for (const bvid of ['', 'https://invalid.example', 3, null]) {
    assert.equal((await h.service.executeAction(event(), { type, bvid })).state, 'failed');
  }
  assert.equal(h.calls.analyze, 1); assert.equal(h.calls.posts + h.calls.sends.length, 0);
});

test('inspect holds the shared busy flag and resumes normal scheduling on completion', async t => {
  let release; const waitAnalysis = new Promise(resolve => { release = resolve; });
  const h = await harness(t, { waitAnalysis });
  const pending = h.service.executeAction(event(), { type: 'bili_inspect', bvid: VIDEO.bvid });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.service.status()).stats.busy, true);
  assert.equal((await h.service.executeAction(event(), { type: 'bili_watch' })).state, 'failed');
  release(); assert.equal((await pending).state, 'completed');
  assert.equal((await h.service.status()).stats.busy, false);
});

test('inspect failures release busy state and never expose raw backend errors or send messages', async t => {
  const h = await harness(t, { analysisError: new Error('private-token=DO_NOT_PRINT') });
  const result = await h.service.executeAction(event(), { type: 'bili_inspect', bvid: VIDEO.bvid });
  assert.equal(result.state, 'failed'); assert.doesNotMatch(result.summary, /DO_NOT_PRINT/);
  assert.equal((await h.service.status()).stats.busy, false);
  assert.equal(h.calls.posts + h.calls.sends.length + h.calls.chats.length, 0);
});

test('legacy commands reuse actions and append factual results only after successful QQ delivery', async t => {
  for (const sendFailure of [false, true]) {
    const h = await harness(t, { sendFailure });
    assert.equal(await h.service.handleEvent(event({ message: 'B站暂停' })), true);
    assert.equal(h.service.getConfig().enabled, false); assert.equal(h.calls.sends.length, 1);
    assert.equal(h.calls.history.length, sendFailure ? 0 : 1);
    if (!sendFailure) assert.deepEqual(h.calls.history[0], { key: `p:${OWNER}`, role: 'assistant', content: 'B站活动已暂停。',
      source: 'bilibili', factual: true, action: 'bili_pause', actionState: 'completed', messageId: '99' });
    assert.equal(await h.service.handleEvent(event({ self_id: OWNER, message: 'B站继续' })), false);
    assert.equal(await h.service.handleEvent(event({ message: '普通聊天' })), false);
  }
});
