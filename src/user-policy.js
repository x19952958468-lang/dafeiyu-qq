export function isIgnoredUser(cfg, userId) {
  return (cfg.trigger.ignoreUserIds ?? []).map(String).includes(String(userId));
}

export function focusUser(cfg, groupId, userId) {
  if (groupId == null || isIgnoredUser(cfg, userId)) return null;
  return (cfg.trigger.focusUsers ?? []).find(u =>
    String(u.qq) === String(userId) && (!u.group || String(u.group) === String(groupId)));
}
