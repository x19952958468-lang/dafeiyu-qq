/**
 * 调 OneBot 接口看群列表 / 好友列表。
 *   node tools/groups.js          → 群列表
 *   node tools/groups.js friends  → 好友列表
 */
import { loadConfig } from '../src/config.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(ROOT);
const { ws, accessToken } = cfg.onebot;
const url = accessToken ? `${ws}${ws.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}` : ws;

const action = process.argv[2] === 'friends' ? 'get_friend_list' : 'get_group_list';

const sock = new WebSocket(url);
const timer = setTimeout(() => {
  console.log('超时：协议端没响应');
  process.exit(1);
}, 15000);

sock.addEventListener('open', () => {
  sock.send(JSON.stringify({ action, params: {}, echo: 'q1' }));
});

sock.addEventListener('message', (e) => {
  let m;
  try {
    m = JSON.parse(typeof e.data === 'string' ? e.data : '');
  } catch {
    return;
  }
  if (m.echo !== 'q1') return;
  clearTimeout(timer);
  const list = m.data ?? [];
  if (!list.length) {
    console.log('列表为空');
  } else if (action === 'get_group_list') {
    console.log(`\n  共 ${list.length} 个群\n`);
    for (const g of list) {
      console.log(`  群号 ${String(g.group_id).padEnd(12)} ${g.group_name}`);
    }
    console.log('');
  } else {
    console.log(`\n  共 ${list.length} 个好友\n`);
    for (const f of list) {
      console.log(`  QQ ${String(f.user_id).padEnd(12)} ${f.remark || f.nickname}`);
    }
    console.log('');
  }
  sock.close();
  process.exit(0);
});

sock.addEventListener('error', (e) => {
  clearTimeout(timer);
  console.log('连接失败', e.message ?? '');
  process.exit(1);
});
