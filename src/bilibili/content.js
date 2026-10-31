import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { WORK_DIR, BILI_PYTHON, FFMPEG, REPO_ROOT } from '../paths.js';
const WORK = path.join(WORK_DIR, 'bilibili-video');
const MEDIA_DOMAINS = ['bilivideo.com', 'bilivideo.cn', 'bilivideo.net', 'hdslb.com'];

export function safeMediaUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const allowedPort = !url.port || url.port === '443' || (url.port === '8082' && host.endsWith('.mcdn.bilivideo.cn'));
  if (url.protocol !== 'https:' || url.username || url.password || !allowedPort ||
      !MEDIA_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`))) {
    throw new Error('Unsupported media source');
  }
  return url.href;
}

export async function downloadMedia(url, destination, { maxBytes = 120 * 1024 * 1024, timeoutMs = 90000, fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let current = safeMediaUrl(url);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetchImpl(current, {
        redirect: 'manual', signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 3) throw new Error('Media redirect failed');
        current = safeMediaUrl(new URL(location, current).href);
        continue;
      }
      if (!response.ok || !response.body) throw new Error(`Media download HTTP ${response.status}`);
      const size = Number(response.headers.get('content-length') || 0);
      if (size > maxBytes) { await response.body.cancel(); throw new Error('Media exceeds download limit'); }
      const output = await fs.open(destination, 'wx', 0o600);
      let count = 0;
      try {
        for await (const chunk of response.body) {
          count += chunk.length;
          if (count > maxBytes) { ctrl.abort(); throw new Error('Media exceeds download limit'); }
          await output.write(chunk);
        }
      } finally { await output.close(); }
      if (count < 128) throw new Error('Media is empty');
      return { bytes: count };
    }
  } catch (error) {
    await fs.rm(destination, { force: true });
    throw error;
  } finally { clearTimeout(timer); }
}

export function runLocal(executable, args, { timeoutMs = 240000, maxOutputBytes = 65536 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' } });
    let bytes = 0, timedOut = false, excessive = false, forceTimer;
    const terminate = () => { child.kill('SIGTERM'); forceTimer = setTimeout(() => child.kill('SIGKILL'), 2000); forceTimer.unref(); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes && !excessive) { excessive = true; terminate(); }
    });
    child.on('error', error => { clearTimeout(timer); clearTimeout(forceTimer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(forceTimer);
      if (code === 0 && !timedOut && !excessive) resolve();
      else reject(new Error(timedOut ? 'Local content analysis timed out' : excessive ? 'Local content output exceeded limit' : `Local content analysis exited ${code}`));
    });
  });
}

export function createContentAnalyzer({ rootDir, client, config = {}, log = () => {}, fetchImpl = fetch, runImpl = runLocal, acquireHeavy } = {}) {
  const python = config.contentPython || BILI_PYTHON;
  const worker = config.contentWorker || path.join(REPO_ROOT, 'integrations/bilibili-video/analyze_local.py');
  const visionModel = config.visionModel || path.join(WORK, 'models/qwen-vl');
  const asrModel = config.asrModel || path.join(WORK, 'models/whisper-small');
  const cacheDir = config.contentCacheDir || path.join(rootDir, 'data/bilibili/content');
  const ffmpeg = config.ffmpeg || FFMPEG;
  const durationLimit = Math.min(300, Math.max(10, Number(config.maxVideoSeconds) || 300));
  const maxBytes = Math.min(150 * 1024 * 1024, Math.max(1024, Number(config.maxDownloadBytes) || 120 * 1024 * 1024));
  const frameCount = Math.min(6, Math.max(1, Math.round(Number(config.frameCount) || 4)));
  const timeoutMs = Math.min(300000, Math.max(1000, Number(config.contentTimeoutMs) || 240000));
  let active = false;

  async function infer(folder, mode, data) {
    const request = path.join(folder, `${mode}-request.json`);
    const output = path.join(folder, `${mode}-result.json`);
    await fs.writeFile(request, JSON.stringify({ mode, ...data }), { mode: 0o600 });
    const release = await acquireHeavy?.({ kind: 'bilibili', timeoutMs: 300000 });
    try { await runImpl(python, [worker, '--request', request, '--output', output], { timeoutMs }); }
    finally { await release?.(); }
    const stat = await fs.stat(output);
    if (stat.size > 128000) throw new Error('Local inference result is too large');
    const result = JSON.parse(await fs.readFile(output, 'utf8'));
    if (typeof result.text !== 'string') throw new Error('Local inference result has no text');
    return result;
  }

  async function analyze(video) {
    if (!/^BV[0-9A-Za-z]{10}$/.test(video?.bvid || '')) throw new Error('Invalid Bilibili video ID');
    if (active) throw new Error('Content analyzer is busy');
    active = true;
    const result = { bvid: video.bvid, title: String(video.title || '').slice(0, 500),
      url: `https://www.bilibili.com/video/${video.bvid}`, evidenceLevel: 'metadata',
      framesAnalyzed: 0, transcript: '', warnings: [], coverage: { videoSeconds: 0, frameTimes: [] } };
    let folder;
    try {
      await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
      folder = path.join(cacheDir, `${video.bvid}-${randomUUID()}`);
      await fs.mkdir(folder, { mode: 0o700 });
      let subtitle;
      try { subtitle = await client.subtitles(video.bvid, video.cid); }
      catch { result.warnings.push('平台字幕暂不可用'); }
      if (subtitle?.available && typeof subtitle.text === 'string' && subtitle.text.trim()) {
        result.transcript = subtitle.text.slice(0, 14000);
        result.transcriptSource = 'platform_subtitles';
        result.evidenceLevel = 'transcript';
      }
      let media, source;
      try {
        media = await client.playUrl(video.bvid, video.cid);
        const seconds = Math.min(durationLimit, Math.max(1, Number(video.duration || media.duration) || durationLimit));
        result.coverage.videoSeconds = seconds;
        source = path.join(folder, 'video.media');
        await downloadMedia(media.videoUrl, source, { maxBytes, fetchImpl });
        const frames = [];
        for (let i = 0; i < frameCount; i++) {
          const time = Math.max(0, seconds * (i + .5) / frameCount);
          const frame = path.join(folder, `frame-${i}.jpg`);
          await runImpl(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
            '-protocol_whitelist', 'file,pipe', '-ss', time.toFixed(3), '-i', source,
            '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", '-q:v', '3', frame], { timeoutMs: 30000 });
          await fs.access(frame);
          frames.push(frame); result.coverage.frameTimes.push(Number(time.toFixed(3)));
        }
        const vision = await infer(folder, 'vision', { model: visionModel, frames });
        result.visualDescription = vision.text.slice(0, 2500);
        result.framesAnalyzed = frames.length;
        result.evidenceLevel = 'video';
        result.warnings.push('画面描述由本地模型生成，细节和文字可能识别错误');
      } catch (error) {
        result.warnings.push('视频画面未能完成分析');
        log(`[bilibili] ${video.bvid}: visual analysis unavailable (${error.message?.slice(0, 120) || 'unknown'})`);
      }
      if (!result.transcript && source) {
        try {
          let audioSource = source;
          if (media?.audioUrl) {
            audioSource = path.join(folder, 'audio.media');
            await downloadMedia(media.audioUrl, audioSource, { maxBytes: Math.min(maxBytes, 25 * 1024 * 1024), fetchImpl });
          }
          const audio = path.join(folder, 'audio.wav');
          await runImpl(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
            '-protocol_whitelist', 'file,pipe', '-i', audioSource, '-t', String(durationLimit),
            '-vn', '-ac', '1', '-ar', '16000', audio], { timeoutMs: 45000 });
          const asr = await infer(folder, 'asr', { model: asrModel, audio });
          if (asr.text.trim()) {
            result.transcript = asr.text.slice(0, 14000);
            result.transcriptSource = 'automatic_speech_recognition';
            if (result.evidenceLevel === 'metadata') result.evidenceLevel = 'transcript';
            result.warnings.push('语音转写可能有误，不能作为精确引语');
          } else result.warnings.push('未识别出清晰语音，音乐或歌声可能无法转写');
        } catch { result.warnings.push('无可用字幕或语音转写'); }
      }
      result.summary = result.visualDescription || result.transcript.slice(0, 1500) || '只有标题与简介，尚未确认视频实际内容。';
      result.evidenceText = [
        `证据等级：${result.evidenceLevel}。标题：${result.title}`,
        `简介（作者提供，非观看结论）：${String(video.description || '').slice(0, 1800)}`,
        result.visualDescription ? `画面抽样（仅前 ${result.coverage.videoSeconds} 秒的 ${result.framesAnalyzed} 帧，并非完整观看）：${result.visualDescription}` : '没有成功读取视频画面。',
        result.transcript ? `${result.transcriptSource === 'platform_subtitles' ? '平台字幕' : `前至多 ${durationLimit} 秒自动语音转写`}：\n${result.transcript}` : '没有字幕或语音证据。',
        result.warnings.join('；'),
      ].filter(Boolean).join('\n');
      return result;
    } finally {
      active = false;
      if (folder) await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { analyze };
}
