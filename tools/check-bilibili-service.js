import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBilibiliCompanion, validateSettings, parseEvaluation, safePublicComment } from '../src/bilibili/service.js';

const OWNER = '70105';
const video = { bvid: 'BV1hXbN6VEKV', aid: 10, cid: 20, title: '音乐演奏', author: '公开作者', duration: 50, url: 'https://www.bilibili.com/video/BV1hXbN6VEKV' };
function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-service-'));
  fs.writeFileSync(path.join(root, 'persona.md'), '用一句话表达细腻的观察。');
  const cfg = { persona: { file: 'persona.md' }, trigger: { ignoreUserIds: [] }, whitelist: { friends: [] } };
  const calls = { analyzes: 0, posts: 0, sends: 0, spends: 0, chats: 0 };
  let loggedIn = options.loggedIn ?? true;
  let clock = Date.parse('2026-10-30T02:00:00Z');
  const timers = new Map();
  let timerId = 0;
  const setTimer = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: clock + delay }); return id; };
  const clearTimer = id => timers.delete(id);
  const videos = options.videos || [video];
  const candidates = async () => options.noCandidates ? [] : videos;
  const result = { score: 9, summary: '抽样画面为乐器演奏。', wantComment: true, comment: '这一段的节奏处理很有层次。', wantShare: true, recommendation: '这段演奏挺有意思，想分享给你。', tags: ['音乐'] };
  const client = { status: async () => loggedIn ? { loggedIn: true, uid: '42', name: 'test' } : { loggedIn: false },
    createQr: async () => ({}), pollQr: async () => ({ status: 'waiting' }),
    popular: candidates, recommendations: candidates, search: candidates,
    video: async bvid => videos.find(v => v.bvid === bvid) || video,
    postComment: async () => { calls.posts++; return options.postResult || { ok: true, rpid: '123' }; } };
  const analyzer = { analyze: async () => { calls.analyzes++; if (options.waitAnalysis) await options.waitAnalysis;
    return { evidenceLevel: options.metadata ? 'metadata' : 'video', evidenceText: '仅抽样四帧，公开演奏视频。', coverage: { videoSeconds: 50 } }; } };
  const transport = { call: async () => ({ ok: true, data: [{ user_id: OWNER, nickname: '主人' }, { user_id: '70102', nickname: '朋友' }] }),
    sendPrivate: async (id, content) => { calls.sends++; assert.equal(id, OWNER); assert.ok(content[0].data.text); return { ok: true }; } };
  const limits = { gate: () => options.blocked ? { ok: false, reason: 'quiet' } : { ok: true },
    spend: () => { calls.spends++; }, noteReply: () => {} };
  const llm = { chat: async ({ messages }) => { calls.chats++; assert.ok(messages[0].content.includes('不可信')); return { text: options.invalidJson ? 'invalid' : JSON.stringify(result), cost: .01 }; } };
  const make = () => createBilibiliCompanion({ rootDir: root, cfg, client, analyzer, transport, limits, llm, now: () => clock, singingBusy: async () => !!options.singing, setTimer, clearTimer });
  const service = make(); service.start();
  t.after(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, calls, root, cfg, make, result, setLoggedIn: x => { loggedIn = x; },
    advance: (ms = 3 * 3600000) => { clock += ms; }, now: () => clock,
    scheduled: () => [...timers.values()].map(v => v.at - clock),
    async fireNext(waitForIdle = true) {
      const [id, item] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0] || [];
      assert.ok(item, 'expected a scheduled timer'); timers.delete(id); clock = Math.max(clock, item.at);
      await item.callback(); if (waitForIdle) await service.whenIdle();
    } };
}
async function enable(h) { await h.service.configure({ ownerQq: OWNER, enabled: true }); }

test('no account cannot enable or write', async t => {
  const h = harness(t, { loggedIn: false });
  await assert.rejects(h.service.configure({ ownerQq: OWNER, enabled: true }));
  await h.service.tick();
  assert.equal(h.calls.posts + h.calls.sends + h.calls.analyzes, 0);
});
test('dry run analyzes locally but sends nothing and does not consume watch quota', async t => {
  const h = harness(t); await enable(h);
  await h.service.runNow({ dryRun: true }); await h.service.whenIdle();
  assert.equal(h.calls.analyzes, 1); assert.equal(h.calls.posts + h.calls.sends, 0);
  assert.equal((await h.service.status()).stats.todayWatched, 0);
});
test('eligible video delivers once and persists both action ledgers', async t => {
  const h = harness(t); await enable(h);
  await h.service.runNow({ dryRun: false }); await h.service.whenIdle();
  assert.equal(h.calls.posts, 1); assert.equal(h.calls.sends, 1); assert.equal(h.calls.spends, 1);
  h.advance(); await h.service.runNow({ dryRun: false, bvid: video.bvid }); await h.service.whenIdle();
  assert.equal(h.calls.posts, 1); assert.equal(h.calls.sends, 1);
});
test('unknown comment is not retried across restart', async t => {
  const h = harness(t, { postResult: { ok: false, unknown: true } }); await enable(h);
  await h.service.runNow({ dryRun: false }); await h.service.whenIdle(); await h.service.stop();
  h.advance(); const restarted = h.make(); restarted.start();
  await restarted.runNow({ dryRun: false, bvid: video.bvid }); await restarted.whenIdle(); await restarted.stop();
  assert.equal(h.calls.posts, 1);
  const state = JSON.parse(fs.readFileSync(path.join(h.root, 'data/bilibili/state.json')));
  assert.equal(state.comments[video.bvid].status, 'unknown');
});
test('pause during analysis prevents both external writes', async t => {
  let release; const waitAnalysis = new Promise(r => { release = r; });
  const h = harness(t, { waitAnalysis }); await enable(h);
  await h.service.runNow({ dryRun: false });
  await h.service.configure({ enabled: false }); release(); await h.service.whenIdle();
  assert.equal(h.calls.posts + h.calls.sends, 0);
});
test('metadata alone never invokes model or comments or recommends', async t => {
  const h = harness(t, { metadata: true }); await enable(h);
  await h.service.runNow({ dryRun: false }); await h.service.whenIdle();
  assert.equal(h.calls.chats + h.calls.posts + h.calls.sends, 0);
});
test('quiet/budget gate blocks automatic analysis', async t => {
  const h = harness(t, { blocked: true }); await enable(h); h.advance(); await h.service.tick();
  assert.equal(h.calls.analyzes, 0);
});
test('singing workload defers video analysis without writes', async t => {
  const h = harness(t, { singing: true }); await enable(h);
  await h.service.runNow({ dryRun: false }); await h.service.whenIdle();
  assert.equal(h.calls.analyzes + h.calls.posts + h.calls.sends, 0);
});
test('zero comment and share allowances keep watching without writing', async t => {
  const h = harness(t); await enable(h); await h.service.configure({ commentPerDay: 0, sharePerDay: 0 });
  await h.service.runNow({ dryRun: false }); await h.service.whenIdle();
  assert.equal(h.calls.analyzes, 1); assert.equal(h.calls.posts + h.calls.sends, 0);
});
test('invalid model JSON cannot cause an external action', async t => {
  const h = harness(t, { invalidJson: true }); await enable(h);
  await h.service.runNow({ dryRun: false }); await h.service.whenIdle();
  assert.equal(h.calls.posts + h.calls.sends, 0);
});
test('commands are restricted to owner private messages', async t => {
  const h = harness(t); await enable(h);
  assert.equal(await h.service.handleEvent({ post_type: 'message', message_type: 'group', user_id: OWNER, message: 'B站暂停' }), false);
  assert.equal(await h.service.handleEvent({ post_type: 'message', message_type: 'private', user_id: '70102', message: 'B站暂停' }), false);
  assert.equal(h.calls.sends, 0);
  assert.equal(await h.service.handleEvent({ post_type: 'message', message_type: 'private', user_id: OWNER, message: 'B站暂停' }), true);
  assert.equal(h.service.getConfig().enabled, false);
});
test('invalid configuration and unsafe public text rejected', () => {
  assert.throws(() => validateSettings({ ownerQq: 'invalid' }));
  assert.throws(() => validateSettings({ callbackUrl: 'https://elsewhere' }));
  assert.throws(() => validateSettings({ commentPerDay: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => parseEvaluation('{"score":99,"summary":"x"}'));
  assert.equal(safePublicComment('作者你这是人格障碍的表现'), false);
  assert.equal(safePublicComment('来访问https://untrusted.example'), false);
  assert.equal(safePublicComment('这一段的节奏处理很有层次。'), true);
});

test('comment allowance has no fixed cap and intervals accept zero and fractions', () => {
  const settings = validateSettings({ commentPerDay: 10000, intervalMinutes: 0, commentGapMinutes: .5 });
  assert.equal(settings.commentPerDay, 10000);
  assert.equal(settings.intervalMinutes, 0);
  assert.equal(settings.commentGapMinutes, .5);
  assert.equal(validateSettings({ intervalMinutes: .25, commentGapMinutes: 0 }).intervalMinutes, .25);
  for (const value of [-1, .5, Infinity, NaN, '20']) assert.throws(() => validateSettings({ commentPerDay: value }));
  for (const key of ['intervalMinutes', 'commentGapMinutes']) {
    for (const value of [-1, 1441, Infinity, NaN, '0']) assert.throws(() => validateSettings({ [key]: value }));
  }
});

test('zero interval continues on a new timer after completion and remains serial', async t => {
  let release; const waitAnalysis = new Promise(r => { release = r; });
  const videos = [video, { ...video, bvid: 'BV1eFs96uE3K', aid: 11 }];
  const h = harness(t, { videos, waitAnalysis });
  await h.service.configure({ ownerQq: OWNER, enabled: true, watchPerDay: 2,
    intervalMinutes: 0, commentPerDay: 20, commentGapMinutes: 0, sharePerDay: 0 });
  assert.deepEqual(h.scheduled(), [0]);
  await h.fireNext(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.analyzes, 1);
  assert.equal((await h.service.status()).stats.busy, true);
  assert.deepEqual(h.scheduled(), []);
  await h.service.tick();
  assert.equal(h.calls.analyzes, 1);
  release(); await h.service.whenIdle();
  assert.equal(h.calls.posts, 1);
  assert.deepEqual(h.scheduled(), [0]);
  await h.fireNext();
  assert.equal(h.calls.analyzes, 2); assert.equal(h.calls.posts, 2);
  assert.deepEqual(h.scheduled(), [60000]);
  await h.fireNext();
  assert.equal(h.calls.analyzes, 2);
});

test('changing interval immediately replaces old deadline including fractional minutes', async t => {
  const h = harness(t); await enable(h);
  await h.service.runNow({ dryRun: false }); await h.service.whenIdle();
  assert.deepEqual(h.scheduled(), [90 * 60000]);
  h.advance(10000);
  await h.service.configure({ intervalMinutes: .5 });
  assert.deepEqual(h.scheduled(), [20000]);
  assert.equal((await h.service.status()).stats.nextRunAt, h.now() + 20000);
  await h.service.configure({ commentPerDay: 100 });
  assert.deepEqual(h.scheduled(), [20000]);
  await h.service.configure({ intervalMinutes: 0 });
  assert.deepEqual(h.scheduled(), [0]);
  assert.equal((await h.service.status()).stats.nextRunAt, h.now());
});

test('fractional interval applies to initial scheduling and stop clears it', async t => {
  const h = harness(t);
  await h.service.configure({ ownerQq: OWNER, enabled: true, intervalMinutes: .25 });
  assert.deepEqual(h.scheduled(), [15000]);
  await h.service.stop();
  assert.deepEqual(h.scheduled(), []);
});

test('zero interval backs off after failure, no candidates, or expired login', async t => {
  for (const options of [{ invalidJson: true }, { noCandidates: true }, { expireLogin: true }]) {
    const h = harness(t, options);
    await h.service.configure({ ownerQq: OWNER, enabled: true, intervalMinutes: 0 });
    if (options.expireLogin) h.setLoggedIn(false);
    await h.fireNext();
    assert.equal(h.calls.posts + h.calls.sends, 0);
    assert.deepEqual(h.scheduled(), [60000]);
    assert.equal((await h.service.status()).stats.nextRunAt, h.now() + 60000);
  }
});

test('zero interval preserves five minute singing deferral and pause gate', async t => {
  const h = harness(t, { singing: true });
  await h.service.configure({ ownerQq: OWNER, enabled: true, intervalMinutes: 0 });
  await h.fireNext();
  assert.deepEqual(h.scheduled(), [300000]);
  await h.service.configure({ enabled: false });
  await h.fireNext();
  assert.equal(h.calls.analyzes + h.calls.posts + h.calls.sends, 0);
});
