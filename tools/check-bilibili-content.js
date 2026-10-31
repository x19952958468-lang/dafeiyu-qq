import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContentAnalyzer, downloadMedia, safeMediaUrl } from '../src/bilibili/content.js';

const video = { bvid: 'BV1xx411c7mD', cid: 1, title: '测试公开影片', description: '测试简介', duration: 20 };
const bytes = new Uint8Array(512).fill(1);
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-content-'));
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('CDN URL validation rejects local addresses, credentials, HTTP and lookalikes', () => {
  assert.equal(safeMediaUrl('https://cn-example.bilivideo.com/upgc/video.m4s'), 'https://cn-example.bilivideo.com/upgc/video.m4s');
  assert.match(safeMediaUrl('https://xy1xy.mcdn.bilivideo.cn:8082/v1/resource/v.m4s'), /:8082/);
  for (const url of ['http://a.bilivideo.com/video', 'https://127.0.0.1/a', 'file:///tmp/a',
    'https://badbilivideo.com/a', 'https://bilivideo.com.attacker.example/a',
    'https://secret@a.bilivideo.com/a', 'https://a.bilivideo.com:9000/a']) {
    assert.throws(() => safeMediaUrl(url));
  }
});

test('redirect targets are validated before fetching or writing bytes', async () => {
  const f = await fixture(); let requests = 0;
  try {
    await assert.rejects(downloadMedia('https://a.bilivideo.com/v', path.join(f.root, 'v'), {
      fetchImpl: async () => { requests++; return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }); },
    }), /Unsupported media source/);
    assert.equal(requests, 1);
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally { await f.cleanup(); }
});

test('chunked downloads enforce byte cap and remove partial files', async () => {
  const f = await fixture();
  try {
    await assert.rejects(downloadMedia('https://a.bilivideo.com/v', path.join(f.root, 'v'), {
      maxBytes: 256, fetchImpl: async () => new Response(bytes),
    }), /download limit/);
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally { await f.cleanup(); }
});

test('failed visual analysis preserves honest transcript evidence and cleans media', async () => {
  const f = await fixture();
  try {
    const analyzer = createContentAnalyzer({ rootDir: f.root, client: {
      subtitles: async () => ({ text: '这是实际的平台字幕。', available: true }),
      playUrl: async () => { throw new Error('not available'); },
    }});
    const r = await analyzer.analyze(video);
    assert.equal(r.evidenceLevel, 'transcript');
    assert.equal(r.framesAnalyzed, 0);
    assert.match(r.evidenceText, /没有成功读取视频画面/);
    assert.equal(r.transcriptSource, 'platform_subtitles');
    assert.deepEqual(await fs.readdir(path.join(f.root, 'data/bilibili/content')), []);
  } finally { await f.cleanup(); }
});

test('metadata-only results never claim to have watched a video', async () => {
  const f = await fixture();
  try {
    const analyzer = createContentAnalyzer({ rootDir: f.root, client: {
      subtitles: async () => ({ available: false }), playUrl: async () => { throw new Error('no media'); },
    }});
    const r = await analyzer.analyze(video);
    assert.equal(r.evidenceLevel, 'metadata');
    assert.equal(r.framesAnalyzed, 0);
    assert.match(r.summary, /尚未确认/);
  } finally { await f.cleanup(); }
});

test('vision uses bounded ordered frames and ASR is labeled as automatic', async () => {
  const f = await fixture(); const requests = []; const commands = [];
  try {
    const analyzer = createContentAnalyzer({ rootDir: f.root, config: { frameCount: 4 }, client: {
      subtitles: async () => ({ available: false }),
      playUrl: async () => ({ videoUrl: 'https://a.bilivideo.com/v', duration: 20 }),
    }, fetchImpl: async () => new Response(bytes), runImpl: async (executable, args) => {
      commands.push(args);
      if (args.includes('--request')) {
        const req = JSON.parse(await fs.readFile(args[args.indexOf('--request') + 1], 'utf8'));
        requests.push(req);
        await fs.writeFile(args[args.indexOf('--output') + 1], JSON.stringify({ text: req.mode === 'vision' ? '画面中是一只猫。' : '这是测试语音。' }));
      } else await fs.writeFile(args.at(-1), bytes);
    }});
    const r = await analyzer.analyze(video);
    assert.equal(r.evidenceLevel, 'video');
    assert.equal(r.framesAnalyzed, 4);
    assert.deepEqual(r.coverage.frameTimes, [2.5, 7.5, 12.5, 17.5]);
    assert.equal(r.transcriptSource, 'automatic_speech_recognition');
    assert.deepEqual(requests.map(r => r.mode), ['vision', 'asr']);
    assert.match(r.evidenceText, /并非完整观看/);
    for (const args of commands.filter(args => !args.includes('--request'))) assert.ok(args.includes('file,pipe'));
    assert.deepEqual(await fs.readdir(path.join(f.root, 'data/bilibili/content')), []);
  } finally { await f.cleanup(); }
});

test('invalid BV and concurrent processing are rejected', async () => {
  const f = await fixture(); let release;
  try {
    const analyzer = createContentAnalyzer({ rootDir: f.root, client: {
      subtitles: () => new Promise(resolve => { release = resolve; }), playUrl: async () => { throw new Error('no media'); },
    }});
    await assert.rejects(analyzer.analyze({ bvid: '../private' }), /Invalid/);
    const first = analyzer.analyze(video);
    await assert.rejects(analyzer.analyze(video), /busy/);
    while (!release) await new Promise(resolve => setTimeout(resolve, 1));
    release({ available: false });
    await first;
  } finally { await f.cleanup(); }
});
