/**
 * 拉取群聊最近历史，看清谁在跟谁说话、有没有引用回复。
 *   node tools/history.js 70118 20
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createTransport } from '../src/onebot.js';
import { sleep } from '../src/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(ROOT);

const groupId = process.argv[2] || cfg.whitelist.groups[0];
const count = Number(process.argv[3] || 20);

const transport = createTransport({ cfg, log: () => {} });
transport.connect();
await sleep(1200);

const info = await transport.getLoginInfo();
const self = String(info?.data?.user_id ?? '');

const r = await transport.call('get_group_msg_history', { group_id: Number(groupId), count });
if (!r.ok) {
  console.log('拉取失败：', r.error);
  transport.close();
  process.exit(1);
}

const msgs = r.data?.messages || r.data || [];
const plain = (m) =>
  (Array.isArray(m) ? m : [])
    .filter((s) => s.type === 'text')
    .map((s) => s.data?.text ?? '')
    .join('');
const ats = (m) =>
  (Array.isArray(m) ? m : []).filter((s) => s.type === 'at').map((s) => String(s.data?.qq ?? ''));
const replyTo = (m) => (Array.isArray(m) ? m : []).find((s) => s.type === 'reply')?.data?.id;

const byId = new Map(msgs.map((m) => [String(m.message_id), m]));
const clock = (t) => new Date((t || 0) * 1000).toTimeString().slice(0, 8);

console.log(`\n  群 ${groupId} · 最近 ${msgs.length} 条（我是 ${self}）`);
console.log('  ─────────────────────────────');
for (const m of msgs) {
  const uid = String(m.sender?.user_id ?? m.user_id ?? '');
  const name = m.sender?.card || m.sender?.nickname || uid;
  const isSelf = uid === self;
  const rid = replyTo(m.message);
  const quoted = rid ? byId.get(String(rid)) : null;
  const q = rid ? ` ↳回复(${rid}${quoted ? ` ${quoted.sender?.card || quoted.sender?.nickname}: ${plain(quoted.message).slice(0, 20)}` : ''})` : '';
  const at = ats(m.message);
  const atTag = at.length ? ` @${at.map((a) => (a === self ? '我' : a)).join(',')}` : '';
  console.log(
    `  ${clock(m.time)} ${isSelf ? '【我】' : ''}${name}${atTag}${q}: ${plain(m.message)}   #${m.message_id}`,
  );
}
console.log('  ─────────────────────────────\n');
transport.close();
process.exit(0);
