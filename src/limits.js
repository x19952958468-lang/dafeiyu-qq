import fs from 'node:fs';
import path from 'node:path';
import { ymd, inQuietHours } from './util.js';

/**
 * 限流与预算。
 * 原则：宁可闭嘴，不要刷屏，不要烧钱。
 */
export function createLimits({ dir, cfg }) {
  const usageFile = path.join(dir, 'usage.json');
  let usage = { day: ymd(), dayCost: 0, totalCost: 0, calls: 0, replies: 0 };
  try {
    if (fs.existsSync(usageFile)) {
      const raw = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
      usage = { ...usage, ...raw };
      if (usage.day !== ymd()) usage = { ...usage, day: ymd(), dayCost: 0, replies: 0 };
    }
  } catch {
    /* 忽略损坏 */
  }

  const lastGroupReply = new Map(); // groupId -> ts
  const hourly = new Map(); // groupId -> { hour, n }

  let lastErr = 0;
  function persist() {
    try {
      fs.writeFileSync(usageFile, JSON.stringify(usage, null, 2));
    } catch (e) {
      // 同类错误 60 秒只报一次，别让日志被刷屏盖掉 [reply]/[skip]
      const now = Date.now();
      if (now - lastErr > 60000) {
        lastErr = now;
        console.error('[limits] 用量写入失败（预算统计仅本进程内有效）', e.message);
      }
    }
  }

  function hourBucket(groupId) {
    const h = Math.floor(Date.now() / 3600000);
    const b = hourly.get(groupId);
    if (!b || b.hour !== h) {
      const fresh = { hour: h, n: 0 };
      hourly.set(groupId, fresh);
      return fresh;
    }
    return b;
  }

  /** 发言前的总闸门 */
  function gate({ groupId, bypassCooldown = false }) {
    if (groupId != null) groupId = String(groupId);
    if (groupId && (cfg.mutedGroups ?? []).map(String).includes(String(groupId))) return { ok: false, reason: '该群已暂停发言' };
    if (inQuietHours(cfg.limits.quietHours)) return { ok: false, reason: '静默时段' };
    if (usage.dayCost >= cfg.limits.dailyBudgetCny) return { ok: false, reason: '今日预算已用完' };
    if (usage.totalCost >= cfg.limits.totalBudgetCny) return { ok: false, reason: '总预算已用完' };
    if (groupId) {
      const ov = cfg.trigger.groupOverrides?.[groupId] ?? {};
      const enforce = !bypassCooldown || ov.enforceRateLimits === true;
      const cooldown = ov.replyCooldownSec ?? cfg.limits.groupCooldownSec;
      const maxPerHour = ov.maxRepliesPerHour ?? cfg.limits.maxRepliesPerGroupPerHour;
      // 群内冷却只对「主动插话 / 关键词」生效；
      // 被 @ 或被引用回复（bypassCooldown）时不冷却，否则会把话憋回去。
      // 关键词不豁免：群里聊到大肥鱼时满屏都是「肥鱼」，一豁免就变成刷屏。
      const last = lastGroupReply.get(groupId) ?? 0;
      if (enforce && Date.now() - last < cooldown * 1000) {
        return { ok: false, reason: '群内冷却中' };
      }
      // 每小时上限也只管「主动插话」。被 @ / 被引用回复时不能因为撞了上限就装死，
      // 不然群里正好聊得热的那一个小时，它会彻底不应人。
      if (enforce && hourBucket(groupId).n >= maxPerHour) {
        return { ok: false, reason: `本群每小时发言上限（${maxPerHour} 条/小时）` };
      }
    }
    return { ok: true };
  }

  function noteReply({ groupId }) {
    if (groupId != null) groupId = String(groupId);
    usage.replies += 1;
    if (groupId) {
      lastGroupReply.set(groupId, Date.now());
      hourBucket(groupId).n += 1;
    }
    persist();
  }

  function spend(cost) {
    if (!Number.isFinite(cost) || cost <= 0) return;
    usage.dayCost = Number((usage.dayCost + cost).toFixed(6));
    usage.totalCost = Number((usage.totalCost + cost).toFixed(6));
    usage.calls += 1;
    persist();
  }

  function snapshot() {
    return { ...usage };
  }

  return { gate, noteReply, spend, snapshot, flush: persist };
}
