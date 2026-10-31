import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSinger } from '../src/singing.js';
import { createHeavyCompute } from '../src/heavy-compute.js';
import { DEFAULTS } from '../src/config.js';

// The independent worker is represented only by disposable request/status files.
// No worker is launched and both QQ transport functions are in-memory mocks.
const songEvent = { post_type: 'message', message_type: 'private', self_id: 12345, user_id: 23456,
  message_id: 1, message: [{ type: 'text', data: { text: '唱稻香' } }] };
async function waitFor(check, message = 'condition', timeoutMs = 2500) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(10);
  }
  assert.fail(`Timed out waiting for ${message}`);
}
async function fixture(t, settings = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-coordination-'));
  const jobs = path.join(root, 'jobs');
  await fs.mkdir(jobs);
  await fs.writeFile(path.join(root, 'heartbeat.json'), JSON.stringify({ ready: true, time: Date.now() / 1000 }));
  const cfg = structuredClone(DEFAULTS);
  cfg.singing = { ...cfg.singing, enabled: true, dataDir: root, timeoutSec: 5, maxRequestAgeSec: 5, ...settings };
  const compute = createHeavyCompute(), sent = [], releases = [], pending = [];
  const transport = {
    async sendPrivate(id, segments) { sent.push({ id, segments }); return { ok: true }; },
    async sendGroup() { throw new Error('No group send expected'); },
  };
  const singer = createSinger({ rootDir: root, cfg, transport, acquireHeavy: compute.acquire, log() {} });
  const track = promise => { pending.push(promise); promise.catch(() => {}); return promise; };
  const acquire = kind => track(compute.acquire({ kind, timeoutMs: 5000 }).then(release => { releases.push(release); return release; }));
  async function terminal(folder, state = 'error') {
    await fs.writeFile(path.join(folder, 'status.json'), JSON.stringify({ state, message: '测试终止' }));
  }
  t.after(async () => {
    compute.stop();
    await fs.writeFile(path.join(root, 'heartbeat.json'), JSON.stringify({ ready: false, time: Date.now() / 1000 }));
    for (const item of await fs.readdir(jobs, { withFileTypes: true })) if (item.isDirectory()) await terminal(path.join(jobs, item.name));
    for (const release of releases) await release();
    await Promise.allSettled(pending);
    await waitFor(() => compute.status().active === null, 'recovery lease cleanup');
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, jobs, cfg, compute, sent, singer, track, acquire, terminal,
    async nextJob() {
      return waitFor(async () => {
        for (const name of await fs.readdir(jobs)) {
          const folder = path.join(jobs, name);
          try { await fs.access(path.join(folder, 'request.json')); return folder; } catch { /* wait for atomic request rename */ }
        }
      }, 'singer request.json');
    },
  };
}

test('restart recovery owns compute until all unfinished singing jobs reach terminal status', async t => {
  const h = await fixture(t);
  const folders = [];
  for (const name of ['pending-one', 'pending-two', 'already-done', 'already-finished']) {
    const folder = path.join(h.jobs, name); folders.push(folder);
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'request.json'), JSON.stringify({ song: '测试歌曲' }));
  }
  await h.terminal(folders[2], 'done');
  await fs.writeFile(path.join(folders[3], 'finished'), '');
  await h.singer.start();
  assert.equal(h.compute.status().active, 'singing-recovery');
  let biliGranted = false, speechGranted = false;
  const bili = h.acquire('bilibili').then(release => { biliGranted = true; return release; });
  const speech = h.acquire('speech').then(release => { speechGranted = true; return release; });
  assert.deepEqual(h.compute.status().waiting, ['bilibili', 'speech']);
  await h.terminal(folders[0], 'done');
  await sleep(550); // Allow a full recovery polling cycle while the second job remains active.
  assert.equal(biliGranted, false); assert.equal(speechGranted, false);
  assert.equal(h.compute.status().active, 'singing-recovery');
  await h.terminal(folders[1], 'error');
  const releaseBili = await bili;
  assert.equal(h.compute.status().active, 'bilibili');
  assert.equal(speechGranted, false);
  await releaseBili();
  const releaseSpeech = await speech;
  assert.equal(h.compute.status().active, 'speech');
  await releaseSpeech();
  assert.equal(h.compute.status().active, null);
  assert.equal(h.sent.length, 0);
});

test('a normal singing request releases compute only after terminal audio completion', async t => {
  const h = await fixture(t);
  const task = h.track(h.singer.handle(songEvent));
  const folder = await h.nextJob();
  assert.equal(h.compute.status().active, 'singing');
  let speechGranted = false;
  const next = h.acquire('speech').then(release => { speechGranted = true; return release; });
  await sleep(30);
  assert.equal(speechGranted, false);
  assert.equal(h.sent.length, 1, 'Only the mocked acknowledgement exists before completion');
  assert.equal(h.sent[0].segments[0].type, 'text');
  await fs.writeFile(path.join(folder, 'result.mp3'), Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1200, 1)]));
  await h.terminal(folder, 'done');
  const result = await task;
  assert.equal(result.audio, true);
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].segments[0].type, 'record');
  await fs.access(path.join(folder, 'finished'));
  const release = await next;
  assert.equal(h.compute.status().active, 'speech');
  await release();
  assert.equal(h.compute.status().active, null);
});

test('user-facing singing timeout keeps compute reserved until the live worker terminates', async t => {
  const h = await fixture(t, { timeoutSec: 0.05, maxRequestAgeSec: 0.05 });
  let settled = false, videoGranted = false;
  const task = h.track(h.singer.handle(songEvent).then(result => { settled = true; return result; }));
  const folder = await h.nextJob();
  const next = h.acquire('bilibili').then(release => { videoGranted = true; return release; });
  await waitFor(() => h.sent.some(item => item.segments[0].data.text?.includes('生成超时')), 'user-facing timeout');
  assert.equal(settled, false, 'The worker still owns the model after the chat timeout');
  assert.equal(videoGranted, false);
  assert.equal(h.compute.status().active, 'singing');
  await assert.rejects(fs.access(path.join(folder, 'finished')));
  await h.terminal(folder, 'error');
  const result = await task;
  assert.equal(result.audio, false);
  assert.ok(h.sent.every(item => item.segments[0].type === 'text'));
  const release = await next;
  assert.equal(h.compute.status().active, 'bilibili');
  await fs.access(path.join(folder, 'finished'));
  await release();
  assert.equal(h.compute.status().active, null);
});
