/**
 * 盯着目标群：机器人一进群，就写进白名单并提示重启当前引擎。
 *   python3 tools/daemon.py data/watch.log node tools/watch-join.js 70118
 *
 * 用法：node tools/watch-join.js <群号> [轮询间隔秒，默认 8]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
const interval = Number(process.argv[3] || 8);
if (!target) {
  console.log('用法: node tools/watch-join.js <群号> [间隔秒]');
  process.exit(1);
}

const ts = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log(`[${ts()}]`, ...a);

function callOneBot(action) {
  const cfg = loadConfig(ROOT);
  const { ws, accessToken } = cfg.onebot;
  const url = accessToken
    ? `${ws}${ws.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}`
    : ws;

  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {}
      resolve(v);
    };
    const sock = new WebSocket(url);
    const timer = setTimeout(() => finish(null), 12000);
    sock.addEventListener('open', () => {
      sock.send(JSON.stringify({ action, params: {}, echo: 'w1' }));
    });
    sock.addEventListener('message', (e) => {
      let m;
      try {
        m = JSON.parse(typeof e.data === 'string' ? e.data : '');
      } catch {
        return;
      }
      if (m.echo !== 'w1') return;
      clearTimeout(timer);
      finish(m.data ?? null);
    });
    sock.addEventListener('error', () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

function patchWhitelist(groupId) {
  const p = path.join(ROOT, 'config.json');
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  d.whitelist ??= {};
  const list = new Set((d.whitelist.groups ?? []).map(String));
  if (list.has(String(groupId))) return false;
  list.add(String(groupId));
  d.whitelist.groups = [...list].filter((g) => g !== '__PENDING__');
  fs.writeFileSync(p, JSON.stringify(d, null, 2));
  return true;
}

log(`开始盯群 ${target}（每 ${interval}s 查一次）`);

let rounds = 0;
for (;;) {
  rounds += 1;
  const groups = await callOneBot('get_group_list');
  if (Array.isArray(groups)) {
    const hit = groups.find((g) => String(g.group_id) === String(target));
    if (hit) {
      log(`✓ 已进群：${hit.group_name || target}`);
      const changed = patchWhitelist(target);
      log(changed ? '✓ 白名单已更新' : '· 白名单里本来就有');
      log('请在运行机器人的终端按 Ctrl+C，然后执行 npm start 以加载更新；本工具不会终止其他进程。');
      process.exit(0);
    }
    if (rounds % 10 === 0) log(`… 还没进群（当前 ${groups.length} 个群）`);
  } else if (rounds % 10 === 0) {
    log('… 协议端没响应，继续等');
  }
  await new Promise((r) => setTimeout(r, interval * 1000));
}
