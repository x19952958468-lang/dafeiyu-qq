import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSinger, parseSong } from '../src/singing.js';
import { createEngine } from '../src/pipeline.js';
import { DEFAULTS } from '../src/config.js';

const event = (text = '唱稻香', at = '123') => ({
  post_type: 'message', message_type: 'group', self_id: 123, user_id: 456,
  group_id: 789, message_id: 1, sender: { nickname: 'test' },
  message: [...(at ? [{ type: 'at', data: { qq: at } }] : []), { type: 'text', data: { text } }],
});

const privateEvent = (text = '唱稻香') => {
  const { group_id, ...evt } = event(text, null);
  return { ...evt, message_type: 'private' };
};

function testWav(seconds = 10) {
  const wav = Buffer.alloc(44 + 24000 * 2 * seconds);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  return wav;
}

async function waitFor(check) {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(10);
  }
  throw new Error('Timed out waiting for a queued request');
}

async function setup(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dafeiyu-sing-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cfg = structuredClone(DEFAULTS);
  cfg.singing = { ...cfg.singing, enabled: true, dataDir: root };
  const sent = [];
  const transport = {
    sendGroup: async (id, segments) => { sent.push({ kind: 'group', id, segments }); return { ok: true }; },
    sendPrivate: async (id, segments) => { sent.push({ kind: 'private', id, segments }); return { ok: true }; },
  };
  const singer = createSinger({ rootDir: root, cfg, transport, log: () => {}, ...extra });
  const ready = () => fs.writeFile(path.join(root, 'heartbeat.json'), JSON.stringify({ ready: true, time: Date.now() / 1000 }));
  const respond = async (failure = false) => {
    let folders = [];
    while (!folders.length) { folders = await fs.readdir(path.join(root, 'jobs')).catch(() => []); await sleep(10); }
    const folder = path.join(root, 'jobs', folders[0]);
    let request;
    while (!request) { try { request = JSON.parse(await fs.readFile(path.join(folder, 'request.json'), 'utf8')); } catch { await sleep(10); } }
    assert.equal(request.song, '稻香');
    assert.equal(request.mode, 'complete_section');
    assert.equal(request.target_seconds, 20);
    assert.equal(request.duration, undefined);
    if (!failure) {
      await fs.writeFile(path.join(folder, 'result.wav'), testWav());
    }
    await fs.writeFile(path.join(folder, 'status.json'), JSON.stringify(failure ? { state: 'error', message: '找不到音源' } : { state: 'done' }));
  };
  return { root, cfg, sent, singer, ready, respond };
}

test('parse song titles and reject non-requests', () => {
  for (const [input, expected] of [['唱朋友的酒', '朋友的酒'], ['唱“朋友的酒”', '朋友的酒'], ['请唱一首《稻香》吧', '稻香'], ['唱 稻香 周杰伦', '稻香 周杰伦']]) assert.equal(parseSong(input), expected);
  for (const input of ['不要唱朋友的酒', '你好', '唱歌', '唱一首歌', '唱朋友的酒\n其他命令']) assert.equal(parseSong(input), null);
});

test('only explicit group @self requests pass', async t => {
  const { singer } = await setup(t);
  assert.equal(singer.match(event()), '稻香');
  for (const e of [event('你好'), event('唱稻香', null), event('唱稻香', 'all'), event('唱稻香', '999'), { ...event(), user_id: 123 }]) assert.equal(singer.match(e), null);
});

test('private requests need no @ and accept segment or plain-text messages', async t => {
  const { singer, cfg } = await setup(t);
  cfg.whitelist.groups = ['999']; // Private requests do not use the group allowlist.
  assert.equal(singer.match(privateEvent()), '稻香');
  assert.equal(singer.match({ ...privateEvent(), message: '唱《晴天》' }), '晴天');
  for (const e of [privateEvent('你好'), { ...privateEvent(), user_id: 123 }, { ...privateEvent(), user_id: undefined, sender: {} }]) assert.equal(singer.match(e), null);
});

test('private allowlist, ignored users and muted groups remain enforced', async t => {
  const { singer, cfg } = await setup(t);
  cfg.whitelist.friends = ['999'];
  assert.equal(singer.match(privateEvent()), null);
  cfg.whitelist.friends = [456];
  assert.equal(singer.match(privateEvent()), '稻香');
  cfg.trigger.ignoreUserIds = ['456'];
  assert.equal(singer.match(privateEvent()), null);
  assert.equal(singer.match(event()), null);
  cfg.trigger.ignoreUserIds = [];
  cfg.mutedGroups = ['789'];
  assert.equal(singer.match(event()), null);
  assert.equal(singer.match(privateEvent()), '稻香');
});

test('group allowlist remains enforced', async t => {
  const { singer, cfg } = await setup(t);
  cfg.whitelist.groups = ['999'];
  assert.equal(singer.match(event()), null);
});

test('offline engine returns a clear handled failure', async t => {
  const { singer, sent } = await setup(t);
  const result = await singer.handle(event());
  assert.equal(result.handled, true); assert.equal(result.audio, false);
  assert.match(sent[0].segments[0].data.text, /还没准备好/);
});

test('queue result becomes an actual OneBot record segment', async t => {
  const { singer, sent, ready, respond } = await setup(t);
  await ready();
  const task = respond();
  const result = await singer.handle(event()); await task;
  assert.equal(result.audio, true); assert.equal(sent.length, 2);
  assert.equal(sent[1].segments[0].type, 'record');
  const data = sent[1].segments[0].data.file;
  assert.ok(data.startsWith('base64://'));
  assert.equal(Buffer.from(data.slice(9), 'base64').toString('ascii', 0, 4), 'RIFF');
});

test('private acknowledgement and full audio go only to the requesting private chat', async t => {
  const { singer, sent, ready, respond } = await setup(t);
  await ready();
  const worker = respond();
  const result = await singer.handle(privateEvent()); await worker;
  assert.equal(result.audio, true); assert.equal(sent.length, 2);
  assert.ok(sent.every(x => x.kind === 'private' && x.id === 456));
  assert.match(sent[0].segments[0].data.text, /约20秒/);
  assert.equal(sent[1].segments[0].type, 'record');
  assert.deepEqual(Buffer.from(sent[1].segments[0].data.file.slice(9), 'base64'), testWav());
});

test('private backend failures are reported privately', async t => {
  const { singer, sent, ready, respond } = await setup(t);
  await ready(); const worker = respond(true);
  const result = await singer.handle(privateEvent()); await worker;
  assert.equal(result.audio, false);
  assert.ok(sent.every(x => x.kind === 'private' && x.id === 456));
  assert.equal(sent.at(-1).segments[0].data.text, '找不到音源');
});

test('backend error is surfaced without generating chat text', async t => {
  const { singer, sent, ready, respond } = await setup(t);
  await ready(); const task = respond(true);
  const result = await singer.handle(event()); await task;
  assert.equal(result.audio, false); assert.equal(sent.at(-1).segments[0].data.text, '找不到音源');
});

test('fresh worker heartbeats cannot renew a request beyond its total age limit', async t => {
  const { root, cfg, singer, sent, ready } = await setup(t);
  const startedAt = Date.now();
  let now = startedAt;
  t.mock.method(Date, 'now', () => now);
  cfg.singing.timeoutSec = 60;
  cfg.singing.maxRequestAgeSec = 90;
  await ready();
  let settled = false;
  const task = singer.handle(event()).then(result => { settled = true; return result; });
  let folder;
  try {
    await waitFor(() => sent.length);
    folder = path.join(root, 'jobs', (await fs.readdir(path.join(root, 'jobs')))[0]);
    const readRequest = async () => JSON.parse(await fs.readFile(path.join(folder, 'request.json'), 'utf8'));
    const request = await readRequest();
    const hardDeadline = request.created_at + 90;
    assert.equal(request.deadline, request.created_at + 60);

    now = startedAt + 31000;
    await ready();
    await waitFor(async () => (await readRequest()).deadline === hardDeadline);
    assert.equal((await readRequest()).created_at, request.created_at);

    now = startedAt + 90001;
    await ready();
    const result = await Promise.race([
      task,
      sleep(1500).then(() => assert.fail('Request kept waiting after its total age limit')),
    ]);
    assert.equal(result.audio, false);
    assert.equal(sent.at(-1).segments[0].data.text, '这首生成超时了，这次先不唱了。');
    assert.equal((await readRequest()).deadline, hardDeadline);
    await fs.access(path.join(folder, 'finished'));
  } finally {
    // Ensure a failed regression assertion also releases the active polling loop.
    if (!settled && folder) {
      await fs.writeFile(path.join(folder, 'status.json'), JSON.stringify({ state: 'error' }));
      await task;
    }
  }
});

test('existing pipeline routes singing before LLM and honors quiet gate', async t => {
  const { singer, cfg } = await setup(t);
  let llmCalls = 0, singingCalls = 0;
  const makeEngine = gate => createEngine({
    cfg, persona: '', singer: { match: e => singer.match(e), handle: async () => { singingCalls++; return {}; } },
    store: { append() {} }, limits: { gate: () => ({ ok: gate }), noteReply() {} },
    llm: { chat: async () => { llmCalls++; return { text: '' }; } }, transport: {}, log() {},
  });
  await makeEngine(true).handle(event());
  assert.equal(singingCalls, 1); assert.equal(llmCalls, 0);
  await makeEngine(false).handle(event());
  assert.equal(singingCalls, 1); assert.equal(llmCalls, 0);
  cfg.whitelist.groups = ['999'];
  await makeEngine(true).handle(event());
  assert.equal(singingCalls, 1);
  await makeEngine(true).handle(privateEvent());
  assert.equal(singingCalls, 2); assert.equal(llmCalls, 0);
  await makeEngine(false).handle(privateEvent());
  assert.equal(singingCalls, 2);
  cfg.whitelist.friends = ['999'];
  await makeEngine(true).handle(privateEvent());
  assert.equal(singingCalls, 2); assert.equal(llmCalls, 0);
});

test('private and group requests from the same person queue independently and keep their destinations', async t => {
  const { root, singer, sent, ready } = await setup(t);
  await ready();
  const first = singer.handle(event());
  await waitFor(() => sent.length === 1);
  const second = singer.handle(privateEvent('唱晴天'));
  await waitFor(() => sent.length === 2);
  const jobs = await fs.readdir(path.join(root, 'jobs'));
  assert.equal(jobs.length, 2);
  for (const name of jobs) {
    const folder = path.join(root, 'jobs', name);
    const request = JSON.parse(await fs.readFile(path.join(folder, 'request.json'), 'utf8'));
    const audio = testWav(request.song === '稻香' ? 11 : 12);
    await fs.writeFile(path.join(folder, 'result.wav'), audio);
    await fs.writeFile(path.join(folder, 'status.json'), JSON.stringify({ state: 'done' }));
  }
  assert.ok((await Promise.all([first, second])).every(r => r.audio));
  for (const [kind, id, seconds] of [['group',789,11],['private',456,12]]) {
    const audio = sent.find(x => x.kind === kind && x.id === id && x.segments[0].type === 'record');
    assert.ok(audio);
    assert.deepEqual(Buffer.from(audio.segments[0].data.file.slice(9), 'base64'), testWav(seconds));
  }
  const before = (await fs.readdir(path.join(root, 'jobs'))).length;
  const cooled = await singer.handle(privateEvent('唱稻香'));
  assert.equal(cooled.audio, false);
  assert.equal(sent.at(-1).kind, 'private');
  assert.match(sent.at(-1).segments[0].data.text, /歇一会/);
  assert.equal((await fs.readdir(path.join(root, 'jobs'))).length, before);
});

test('two people in one group queue different songs and both get audio', async t => {
  const { root, singer, sent, ready } = await setup(t);
  await ready();
  const first = singer.handle(event());
  await waitFor(() => sent.length);
  const second = singer.handle({ ...event('唱晴天'), user_id: 457 });
  await waitFor(() => sent.some(item => item.segments[0].data.text?.includes('已加入点歌队列')));
  const folders = await fs.readdir(path.join(root, 'jobs'));
  assert.equal(folders.length, 2);
  const titles = [];
  for (const name of folders) {
    const folder = path.join(root, 'jobs', name);
    titles.push(JSON.parse(await fs.readFile(path.join(folder, 'request.json'), 'utf8')).song);
    await fs.writeFile(path.join(folder, 'result.wav'), testWav());
    await fs.writeFile(path.join(folder, 'status.json'), JSON.stringify({ state: 'done' }));
  }
  const results = await Promise.all([first, second]);
  assert.deepEqual(titles.sort(), ['晴天', '稻香'].sort());
  assert.ok(results.every(result => result.audio));
  assert.equal(sent.filter(item => item.segments[0].type === 'record').length, 2);
});

test('another requester is not blocked by the first requester cooldown', async t => {
  const { root, singer, sent, ready, respond } = await setup(t);
  await ready(); let worker = respond();
  assert.equal((await singer.handle(event())).audio, true); await worker;
  const second = singer.handle({ ...event('唱晴天'), user_id: 457 });
  await waitFor(() => sent.filter(item => item.segments[0].data.text?.includes('我给你唱')).length === 2);
  const folders = await fs.readdir(path.join(root, 'jobs'));
  for (const name of folders) {
    const folder = path.join(root, 'jobs', name);
    if (JSON.parse(await fs.readFile(path.join(folder, 'request.json'), 'utf8')).song !== '晴天') continue;
    await fs.writeFile(path.join(folder, 'result.wav'), testWav());
    await fs.writeFile(path.join(folder, 'status.json'), JSON.stringify({ state: 'done' }));
  }
  assert.equal((await second).audio, true);
});

test('one requester cannot fill the queue with repeated pending requests', async t => {
  const { singer, sent, ready, respond } = await setup(t);
  await ready();
  const first = singer.handle(event());
  await waitFor(() => sent.length);
  const duplicate = await singer.handle(event('唱晴天'));
  assert.equal(duplicate.audio, false);
  assert.match(sent.at(-1).segments[0].data.text, /你上一首/);
  await respond();
  assert.equal((await first).audio, true);
});

test('complete section longer than the old four-megabyte limit is sent intact', async t => {
  const { root, singer, sent, ready } = await setup(t);
  await ready();
  const result = singer.handle(event());
  await waitFor(() => sent.length);
  const folder = path.join(root, 'jobs', (await fs.readdir(path.join(root, 'jobs')))[0]);
  const audio = testWav(100);
  assert.ok(audio.length > 4*1024*1024);
  await fs.writeFile(path.join(folder, 'result.wav'), audio);
  await fs.writeFile(path.join(folder, 'status.json'), JSON.stringify({state:'done'}));
  assert.equal((await result).audio, true);
  const delivered = Buffer.from(sent.at(-1).segments[0].data.file.slice(9), 'base64');
  assert.deepEqual(delivered, audio);
});

test('compressed complete-section audio is preferred for QQ delivery', async t => {
  const { root, singer, sent, ready } = await setup(t);
  await ready();
  const result = singer.handle(event());
  await waitFor(() => sent.length);
  const folder = path.join(root, 'jobs', (await fs.readdir(path.join(root, 'jobs')))[0]);
  const mp3 = Buffer.alloc(2048);mp3.write('ID3');
  await fs.writeFile(path.join(folder, 'result.mp3'), mp3);
  await fs.writeFile(path.join(folder, 'status.json'), JSON.stringify({state:'done'}));
  assert.equal((await result).audio, true);
  assert.deepEqual(Buffer.from(sent.at(-1).segments[0].data.file.slice(9), 'base64'), mp3);
});


test('natural requests resolve song names but quotations, negation and discussion do not execute', () => {
  for (const [input, song] of [
    ['我想听你唱朋友的酒', '朋友的酒'], ['你能唱朋友的酒吗', '朋友的酒'],
    ['换一首稻香', '稻香'], ['请帮我唱《晴天》', '晴天'], ['能不能唱一下《晴天》给我听', '晴天'],
    ['换成《稻香》吧', '稻香'], ['想听你唱稻香这首歌', '稻香'], ['唱《歌剧魅影》', '歌剧魅影'],
  ]) assert.equal(parseSong(input), song, input);
  for (const input of [
    '不要唱朋友的酒', '你不要唱朋友的酒', '请别唱稻香', '我不想听你唱稻香',
    '他说“唱稻香”', '“唱稻香”', '请解释“唱稻香”', '你会唱稻香吗',
    '唱稻香的人是谁', '唱稻香好听吗', '唱稻香还是晴天', '再唱一遍',
    '唱歌是一件开心的事', '唱稻香需要多久',
    '换成文字', '换成语音', '换成稻香', '唱晴天然后暂停B站',
    '唱《晴天》然后暂停B站', '唱晴天并暂停B站', '唱晴天再去看视频',
  ]) assert.equal(parseSong(input), null, input);
});

test('structured song requests reuse access checks independently of sentence matching', async t => {
  const { singer, cfg, sent } = await setup(t);
  assert.equal((await singer.request(privateEvent('换个方式表达的指令'), { song: '稻香', dry: true })).handled, true);
  for (const song of ['', null, '歌', 'x'.repeat(101), '稻香\n换歌', '[CQ:at,qq=all]']) {
    assert.equal((await singer.request(privateEvent(), { song, dry: true })).handled, false);
  }
  const denied = [event('点歌', null), event('点歌', 'all'), { ...privateEvent(), user_id: 123 },
    { ...privateEvent(), post_type: 'notice' }];
  for (const evt of denied) assert.equal((await singer.request(evt, { song: '稻香', dry: true })).handled, false);
  cfg.trigger.ignoreUserIds = ['456'];
  assert.equal((await singer.request(privateEvent(), { song: '稻香', dry: true })).handled, false);
  cfg.trigger.ignoreUserIds = [];
  cfg.whitelist.friends = ['999'];
  assert.equal((await singer.request(privateEvent(), { song: '稻香', dry: true })).handled, false);
  cfg.mutedGroups = ['789'];
  assert.equal((await singer.request(event(), { song: '稻香', dry: true })).handled, false);
  cfg.mutedGroups = [];
  cfg.whitelist.groups = ['999'];
  assert.equal((await singer.request(event(), { song: '稻香', dry: true })).handled, false);
  assert.equal(sent.length, 0);
});

test('structured request produces the same actual audio and remembers only its requester song', async t => {
  const { singer, ready, respond } = await setup(t);
  await ready();
  const worker = respond();
  const result = await singer.request(privateEvent('刚才点的那首'), { song: '稻香' });
  await worker;
  assert.equal(result.audio, true);
  assert.deepEqual(singer.status(privateEvent('到哪了')), { pending: [], lastSong: '稻香' });
  assert.deepEqual(singer.status(event('到哪了')), { pending: [], lastSong: null });
  assert.deepEqual(singer.status({ ...privateEvent('到哪了'), user_id: 457 }), { pending: [], lastSong: null });
});

test('status stays available during processing and cannot reveal another conversation or user', async t => {
  let unlock;
  const lock = new Promise(resolve => { unlock = resolve; });
  const { singer, cfg, ready, respond, sent } = await setup(t, { acquireHeavy: async () => { await lock; return async () => {}; } });
  await ready();
  const task = singer.request(event('换个表达'), { song: '稻香' });
  await waitFor(() => sent.length);
  const queued = singer.status(event('进度'));
  assert.equal(queued.pending.length, 1);
  assert.equal(queued.pending[0].song, '稻香');
  assert.equal(queued.pending[0].phase, 'queue');
  assert.ok(Number.isInteger(queued.pending[0].elapsedSec));
  assert.deepEqual(singer.status({ ...event('进度'), user_id: 457 }), { pending: [], lastSong: null });
  assert.deepEqual(singer.status(privateEvent('进度')), { pending: [], lastSong: null });
  assert.deepEqual(singer.status({ ...event('进度'), group_id: 790 }), { pending: [], lastSong: null });
  assert.deepEqual(singer.status(event('进度', null)), { pending: [], lastSong: null });
  cfg.trigger.ignoreUserIds = ['456'];
  assert.deepEqual(singer.status(event('进度')), { pending: [], lastSong: null });
  cfg.trigger.ignoreUserIds = [];
  unlock();
  await waitFor(() => singer.status(event()).pending[0]?.phase === 'processing');
  await respond();
  assert.equal((await task).audio, true);
  assert.deepEqual(singer.status(event()), { pending: [], lastSong: '稻香' });
});
