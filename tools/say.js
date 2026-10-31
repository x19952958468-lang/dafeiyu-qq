/**
 * 往群里发一条消息（测试发送链路用）。
 *   node tools/say.js <群号> <内容>
 */
import { loadConfig } from '../src/config.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(ROOT);
const { ws, accessToken } = cfg.onebot;
const url = accessToken ? `${ws}${ws.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}` : ws;

const [groupId, ...rest] = process.argv.slice(2);
const text = rest.join(' ');
if (!groupId || !text) {
  console.log('用法: node tools/say.js <群号> <内容>');
  process.exit(1);
}

const sock = new WebSocket(url);
const timer = setTimeout(() => {
  console.log('超时：协议端没响应');
  process.exit(1);
}, 20000);

sock.addEventListener('open', () => {
  sock.send(
    JSON.stringify({
      action: 'send_group_msg',
      params: { group_id: Number(groupId), message: [{ type: 'text', data: { text } }] },
      echo: 's1',
    }),
  );
});

sock.addEventListener('message', (e) => {
  let m;
  try {
    m = JSON.parse(typeof e.data === 'string' ? e.data : '');
  } catch {
    return;
  }
  if (m.echo !== 's1') return;
  clearTimeout(timer);
  if (m.status === 'ok' || m.retcode === 0) {
    console.log('✓ 发送成功，message_id =', m.data?.message_id);
  } else {
    console.log('✗ 发送失败：', m.wording || m.message || JSON.stringify(m));
  }
  sock.close();
  process.exit(0);
});

sock.addEventListener('error', () => {
  clearTimeout(timer);
  console.log('✗ 连接失败');
  process.exit(1);
});
