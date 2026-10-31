/**
 * 主动搭话调度，两类：
 *   1. 重点用户（trigger.focusUsers）—— 到点就去 @ 指定的人
 *   2. 群友（proactiveAt）—— 隔一会儿从「最近在群里说过话的人」里挑一个 @，叫他哥哥/姐姐
 * 两类都要过一堆闸门，防止变刷屏。
 */
import { isIgnoredUser } from './user-policy.js';

function plainText(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message
    .filter((s) => s.type === 'text')
    .map((s) => s.data?.text ?? '')
    .join('')
    .trim();
}

/** 昵称像女生就叫姐姐，看不出来就叫哥哥（小妹妹见谁都这么叫）。可以在 config 里整组换掉。 */
function guessAddress(name, pa) {
  const female = /姐|妹|女|妈|姨|娘|姑|嫂|girl|小仙女/i.test(String(name));
  const ov = pa?.addressOverride ?? {};
  if (female && ov.female) return ov.female;
  if (!female && ov.male) return ov.male;
  if (ov.default) return ov.default;
  return female ? '姐姐' : '哥哥';
}

export function createPoker({ cfg, engine, limits, transport, log = console.log }) {
  const list = (cfg.trigger.focusUsers ?? []).filter((u) => u.qq && u.group && u.pokeEverySec > 0 && !isIgnoredUser(cfg, u.qq));
  const pa = cfg.proactiveAt ?? {};
  const paGroups = (pa.groups ?? []).filter((g) => g && (cfg.whitelist.groups ?? []).includes(String(g)));

  const lastPoke = new Map(); // qq -> ts（重点用户）
  const lastPersonAt = new Map(); // qq -> ts（群友，同一个人多久内不重复 @）
  const paHour = new Map(); // `${groupId}:${hourBucket}` -> 次数
  // 启动后先等一小会儿（150 秒）再主动开口，但不要等满一整个周期——
  // 之前是等满 everySec，重启一次就把「下次主动搭话」往后推 10 分钟，
  // 群里没人 @ 它的时候看起来就是「它不说话了」。
  const paEvery = (pa.everySec ?? 600) * 1000;
  let paLastAt = Date.now() - Math.max(0, paEvery - 150_000);
  let paLastTarget = '';
  let timer = null;

  function inQuietNow() {
    const q = cfg.limits.quietHours ?? [];
    if (!q.length) return false;
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    for (const range of q) {
      const [a, b] = String(range).split('-');
      if (!a || !b) continue;
      const [ah, am] = a.split(':').map(Number);
      const [bh, bm] = b.split(':').map(Number);
      const from = ah * 60 + (am || 0);
      const to = bh * 60 + (bm || 0);
      if (from <= to ? cur >= from && cur < to : cur >= from || cur < to) return true;
    }
    return false;
  }

  /** 从群历史里挑一个「刚说过话、不重复、不是机器人」的人 */
  async function pickCandidate(groupId) {
    const r = await transport.call('get_group_msg_history', { group_id: Number(groupId), count: 30 });
    if (!r.ok) return null;
    const info = await transport.getLoginInfo();
    const self = String(info?.data?.user_id ?? '');
    const since = Date.now() - (pa.onlyRecentSec ?? 900) * 1000;
    const ignore = new Set(cfg.trigger.ignoreSenderNames ?? []);
    const coolMs = (pa.personCooldownSec ?? 1800) * 1000;

    const seen = new Map();
    const selfAts = new Map(); // 我们自己最近 @ 过谁 —— 进程重启后冷却就忘了，用群历史补回来
    for (const m of r.data?.messages ?? []) {
      const uid = String(m.sender?.user_id ?? '');
      const t = Number(m.time) ? Number(m.time) * 1000 : 0;

      if (uid && uid === self) {
        for (const s of Array.isArray(m.message) ? m.message : []) {
          if (s.type !== 'at') continue;
          const q = String(s.data?.qq ?? '');
          if (!q || q === 'all') continue;
          if (t && (!selfAts.has(q) || t > selfAts.get(q))) selfAts.set(q, t);
        }
        continue;
      }

      if (!uid) continue;
      if (isIgnoredUser(cfg, uid)) continue;
      const targets = pa.targetUsersByGroup?.[String(groupId)];
      if (targets?.length && !targets.map(String).includes(uid)) continue;
      const text = plainText(m.message);
      if (!text) continue;
      const name = m.sender?.card || m.sender?.nickname || uid;
      if (ignore.has(name)) continue;
      if (!t || Date.now() - t > (pa.onlyRecentSec ?? 900) * 1000) continue;
      if (Date.now() - (lastPersonAt.get(uid) ?? 0) < coolMs) continue;
      if (Date.now() - (selfAts.get(uid) ?? 0) < coolMs) continue;
      seen.set(uid, { qq: uid, name, ts: t, text, address: guessAddress(name, pa) });
    }
    const cands = [...seen.values()].filter((c) => c.qq !== paLastTarget);
    if (!cands.length) return null;
    cands.sort((a, b) => b.ts - a.ts);
    // 在看得到的最近三个人里随便挑一个，别总盯着同一个
    return cands[Math.floor(Math.random() * Math.min(3, cands.length))];
  }

  async function tickProactive(now) {
    if (!paGroups.length) return;
    if (now - paLastAt < (pa.everySec ?? 600) * 1000) return;

    for (const groupId of paGroups) {
      if (now - engine.stats(groupId).lastReplyAt < (pa.minGapAfterBotSec ?? 120) * 1000) continue;

      const bucket = `${groupId}:${Math.floor(now / 3600000)}`;
      if ((paHour.get(bucket) ?? 0) >= (pa.maxPerHour ?? 6)) continue;

      const g = limits.gate({ groupId });
      if (!g.ok) {
        log(`[proactive] 跳过（${g.reason}）`);
        continue;
      }

      const pick = await pickCandidate(groupId).catch(() => null);
      if (!pick) continue;

      paLastAt = now;
      paLastTarget = pick.qq;
      lastPersonAt.set(pick.qq, now);
      paHour.set(bucket, (paHour.get(bucket) ?? 0) + 1);
      log(`[proactive] 群${groupId} 挑到 ${pick.name}（叫${pick.address}）`);
      await engine
        .poke({ groupId, qq: pick.qq, name: pick.name, address: pick.address, goal: pa.goal })
        .catch((e) => log(`[proactive] 异常：${e.message}`));
    }
  }

  async function tick() {
    if (inQuietNow()) return;
    const now = Date.now();

    // 1. 重点用户
    for (const u of list) {
      const every = (u.pokeEverySec ?? 0) * 1000;
      const sincePoke = now - (lastPoke.get(u.qq) ?? 0);
      // 刚启动时不要立刻扑上去，先等一个周期
      if (!lastPoke.has(u.qq)) {
        lastPoke.set(u.qq, now);
        continue;
      }
      if (sincePoke < every) continue;

      // 机器人自己刚说过话就先等等，别紧接着又来一句
      const minAfterBot = (u.pokeMinGapAfterBotSec ?? 180) * 1000;
      if (now - engine.stats(u.group).lastReplyAt < minAfterBot) continue;

      const g = limits.gate({ groupId: u.group });
      if (!g.ok) {
        log(`[poke] 跳过（${g.reason}）`);
        continue;
      }

      lastPoke.set(u.qq, now);
      log(`[poke] 到点了，去 @${u.name || u.qq}`);
      await engine
        .poke({ groupId: u.group, qq: u.qq, name: u.name || String(u.qq), address: u.address || guessAddress(u.name, pa) })
        .catch((e) => {
          log(`[poke] 异常：${e.message}`);
        });
    }

    // 2. 群友（叫他哥哥/姐姐）
    await tickProactive(now);
  }

  function start(intervalSec = 45) {
    const parts = [];
    if (list.length) {
      parts.push(
        ...list.map((u) => `@${u.name || u.qq}（群${u.group}，每 ${Math.round(u.pokeEverySec / 60)} 分钟）`),
      );
    }
    if (paGroups.length) {
      const who = pa.addressOverride?.default ?? '哥哥姐姐';
      parts.push(`群友（群${paGroups.join(',')}，每 ${Math.round((pa.everySec ?? 600) / 60)} 分钟，叫${who}）`);
    }
    if (!parts.length) return false;

    timer = setInterval(() => {
      tick().catch((e) => log(`[poke] tick 异常：${e.message}`));
    }, intervalSec * 1000);
    log(`  主动搭话  ${parts.join('、')}`);
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick };
}
