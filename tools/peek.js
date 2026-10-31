/**
 * 旁观模式：连上 OneBot WS，只打印进来的事件，不发任何消息。
 * 用来确认「消息到底有没有到引擎」。
 *   node tools/peek.js 30     # 听 30 秒
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createTransport } from '../src/onebot.js';
import { sleep } from '../src/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(ROOT);
const secs = Number(process.argv[2] || 30);

const plain = (m) =>
  (Array.isArray(m) ? m : [])
    .filter((s) => s.type === 'text')
    .map((s) => s.data?.text ?? '')
    .join('')
    .trim();
const segs = (m) => (Array.isArray(m) ? m.map((s) => s.type).join('+') : typeof m);

const transport = createTransport({ cfg, log: (s) => console.log(s) });
transport.setEventHandler((e) => {
  if (e.post_type !== 'message') {
    console.log(`[${e.post_type}] ${e.notice_type || e.request_type || ''}`);
    return;
  }
  const gid = String(e.group_id ?? '');
  const name = e.sender?.card || e.sender?.nickname || e.sender?.user_id;
  const wl = (cfg.whitelist.groups || []).map(String);
  const tag = e.message_type === 'group' ? (wl.length && !wl.includes(gid) ? '不在白名单' : '白名单内') : '私聊';
  console.log(
    `${new Date().toTimeString().slice(0, 8)} ${e.message_type} 群${gid} [${tag}] ${name}（${segs(e.message)}）: ${plain(e.message)}`,
  );
});

transport.connect();
console.log(`\n  旁观 ${secs} 秒，只打印不发言…\n`);
await sleep(secs * 1000);
transport.close();
console.log('\n  结束。\n');
process.exit(0);
