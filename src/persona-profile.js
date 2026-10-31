// Restore only persona style settings; membership, focus users and singing stay current.
export function applyPersonaProfile(raw, profile) {
  if (profile.version !== 1 || !Array.isArray(profile.settings)) throw new Error('人设配置格式不正确');
  for (const entry of profile.settings) {
    const keys = entry.path;
    if (!Array.isArray(keys) || !keys.length || keys.some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) {
      throw new Error('人设配置路径不正确');
    }
    let target = raw;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    if (entry.present) target[keys.at(-1)] = structuredClone(entry.value);
    else delete target[keys.at(-1)];
  }
  return raw;
}
