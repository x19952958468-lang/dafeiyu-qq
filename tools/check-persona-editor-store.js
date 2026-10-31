import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createPersonaEditor, MAX_PERSONA_BYTES } from '../src/persona-editor.js';
import { applyPersonaProfile } from '../src/persona-profile.js';

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const STAMP = 1793390400000;
const ORIGINAL = '# 旧人设\n逐字保留：空格、标点和换行。\n';
const NEXT = '  自己填写的新设定\n“按我的措辞” 😀\n保留末尾空格  ';
const STYLE_PATHS = [
  ['llm', 'temperature'], ['trigger', 'requireWords'], ['trigger', 'watchWords'],
  ['proactiveAt', 'goal'], ['persona', 'naturalAddress'],
];

function fixture(t, options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-store-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const activeFile = path.join(rootDir, 'persona/active.md');
  const configFile = path.join(rootDir, 'config.json');
  const backupDir = path.join(rootDir, 'data/persona/backups');
  const raw = {
    persona: { file: 'persona/active.md', activatedAt: 1500, selfName: '大肥鱼', naturalAddress: false },
    llm: { model: 'local-model', temperature: 0.82, apiKey: 'TEST_PRIVATE_KEY_NOT_FOR_BACKUP' },
    onebot: { token: 'TEST_ONEBOT_TOKEN_NOT_FOR_BACKUP', port: 6196 },
    trigger: {
      requireWords: ['旧口癖'], watchWords: ['旧关键词'], ignoreUserIds: ['ignored'],
      focusUsers: [{ qq: 'owner', mode: 'always' }],
      groupOverrides: {
        '70121': { personaHint: '旧人设风格与游戏内容', probability: 0.3, enabled: true },
        'other': { personaHint: '另一个群的独立设定', enabled: false },
      },
    },
    proactiveAt: { goal: '旧人设主动说话风格', enabled: true, minSeconds: 60 },
    mutedGroups: ['70116'], whitelist: { groups: ['70112'] },
    singing: { enabled: true, version: 'd', duration: 20 },
    speech: { engine: 'breeze', enabled: true },
    bilibili: { comments: { maxPerDay: 17 }, apiKey: 'TEST_BILI_KEY_NOT_FOR_BACKUP' },
    extraUserSetting: { any: ['untouched'] },
  };
  fs.mkdirSync(path.join(rootDir, 'persona/variants'), { recursive: true });
  fs.writeFileSync(activeFile, options.text ?? ORIGINAL, { mode: 0o640 });
  fs.writeFileSync(path.join(rootDir, 'persona/variants/previous.md'), '永久历史版本');
  fs.writeFileSync(configFile, JSON.stringify(raw, null, 4) + '\n', { mode: 0o600 });
  const cfg = options.cfg ? options.cfg(configFile) : { ...structuredClone(raw), __file: configFile, __problems: [] };
  const applied = [];
  const editor = createPersonaEditor({
    rootDir, cfg, now: options.now ?? (() => STAMP), io: options.io ?? fs,
    onApply: options.onApply ?? (entry => applied.push({ ...entry, snapshot: structuredClone(entry.cfg) })),
  });
  return { rootDir, activeFile, configFile, backupDir, raw, cfg, editor, applied,
    config: () => JSON.parse(fs.readFileSync(configFile, 'utf8')) };
}

function expectError(fn, code, status) {
  assert.throws(fn, error => {
    assert.equal(error.code, code);
    assert.equal(error.httpStatus, status);
    assert.equal(error.status, status);
    assert.equal(error.publicMessage, error.message);
    assert.ok(!error.message.includes('/Users/') && !error.message.includes('TEST_PRIVATE'));
    return true;
  });
}

test('state reads the active file without exposing config, paths, or keys', t => {
  const f = fixture(t), state = f.editor.state();
  assert.deepEqual(Object.keys(state).sort(), ['appliedRevision', 'available', 'backups', 'needsApply', 'revision', 'text', 'updatedAt']);
  assert.equal(state.text, ORIGINAL);
  assert.equal(state.revision, hash(ORIGINAL));
  assert.equal(state.appliedRevision, state.revision);
  assert.equal(state.needsApply, false);
  assert.deepEqual(state.backups, []);
  assert.ok(Number.isFinite(Date.parse(state.updatedAt)));
  assert.ok(!JSON.stringify(state).includes(f.rootDir));
  assert.ok(!JSON.stringify(state).includes('TEST_PRIVATE'));
  fs.writeFileSync(f.activeFile, '外部编辑器更新');
  assert.equal(f.editor.state().text, '外部编辑器更新');
  assert.equal(f.editor.state().needsApply, true);
});

test('save is exact, backs up only old text/style, and preserves every unrelated setting', t => {
  const f = fixture(t), cfgReference = f.cfg, oldCfg = structuredClone(f.cfg);
  const saved = f.editor.save({ text: NEXT, revision: f.editor.state().revision });
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), NEXT);
  assert.equal(saved.text, NEXT);
  assert.equal(saved.revision, hash(NEXT));
  assert.equal(saved.appliedRevision, saved.revision);
  assert.equal(saved.needsApply, false);
  assert.equal(f.cfg, cfgReference);
  assert.equal(f.cfg.__file, f.configFile);
  const after = f.config(), expected = structuredClone(f.raw);
  delete expected.trigger.requireWords;
  expected.trigger.watchWords = [];
  expected.proactiveAt.goal = after.proactiveAt.goal;
  expected.persona.naturalAddress = true;
  expected.persona.activatedAt = STAMP;
  assert.match(after.proactiveAt.goal, /^按当前人设/);
  assert.deepEqual(after.trigger.groupOverrides, f.raw.trigger.groupOverrides, 'User-defined group hints are preserved');
  assert.deepEqual(after, expected);
  assert.deepEqual(f.cfg, { ...expected, __file: f.configFile, __problems: oldCfg.__problems });
  assert.equal(f.applied.length, 1);
  assert.equal(f.applied[0].text, NEXT);
  assert.equal(f.applied[0].activatedAt, STAMP);
  assert.equal(f.applied[0].rollback, false);
  assert.equal(f.applied[0].snapshot.persona.activatedAt, STAMP);
  assert.equal(saved.backups.length, 1);
  assert.deepEqual(Object.keys(saved.backups[0]).sort(), ['createdAt', 'id', 'label']);
  const backupFile = path.join(f.backupDir, `${saved.backups[0].id}.json`);
  const bytes = fs.readFileSync(backupFile, 'utf8'), backup = JSON.parse(bytes);
  assert.equal(backup.text, ORIGINAL);
  assert.deepEqual(backup.profile.settings.map(entry => entry.path), STYLE_PATHS);
  assert.doesNotMatch(bytes, /TEST_.*(?:KEY|TOKEN)|apiKey|__file|singing|bilibili|mutedGroups/);
  const restoredStyle = applyPersonaProfile(structuredClone(after), backup.profile);
  const oldExceptActivation = structuredClone(f.raw);
  oldExceptActivation.persona.activatedAt = STAMP;
  assert.deepEqual(restoredStyle, oldExceptActivation);
  assert.deepEqual(f.editor.backup(saved.backups[0].id), { text: ORIGINAL });
  assert.equal(fs.statSync(f.activeFile).mode & 0o777, 0o640);
  assert.equal(fs.statSync(f.configFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(backupFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(f.rootDir, 'persona/variants/previous.md'), 'utf8'), '永久历史版本');
});

test('merge uses latest disk config and does not reset other runtime settings', t => {
  const f = fixture(t), latest = f.config();
  latest.bilibili.comments.maxPerDay = 48;
  latest.singing.duration = 21;
  latest.mutedGroups.push('new-muted');
  latest.newField = { userAdded: true };
  fs.writeFileSync(f.configFile, JSON.stringify(latest));
  f.editor.save({ text: NEXT, revision: f.editor.state().revision });
  const after = f.config();
  assert.deepEqual(after.bilibili, latest.bilibili);
  assert.deepEqual(after.singing, latest.singing);
  assert.deepEqual(after.mutedGroups, latest.mutedGroups);
  assert.deepEqual(after.newField, latest.newField);
  assert.deepEqual(f.cfg.singing, f.raw.singing);
  assert.equal(f.cfg.__file, f.configFile);
});

test('unmodified text is a no-op without backup, timestamp, writes, or callback', t => {
  const f = fixture(t, { now: () => { throw new Error('Clock must not be touched'); } });
  const bytes = fs.readFileSync(f.configFile), modified = fs.statSync(f.activeFile).mtimeMs;
  const state = f.editor.save({ text: ORIGINAL, revision: f.editor.state().revision });
  assert.deepEqual(fs.readFileSync(f.configFile), bytes);
  assert.equal(fs.statSync(f.activeFile).mtimeMs, modified);
  assert.deepEqual(state.backups, []);
  assert.equal(f.applied.length, 0);
});

test('saving externally changed text unchanged still applies it and persists context boundary', t => {
  const f = fixture(t);
  fs.writeFileSync(f.activeFile, NEXT);
  const modified = fs.statSync(f.activeFile).mtimeMs;
  const before = f.editor.state();
  assert.equal(before.needsApply, true);
  assert.equal(before.appliedRevision, hash(ORIGINAL));
  const saved = f.editor.save({ text: NEXT, revision: before.revision });
  assert.equal(f.applied.length, 1);
  assert.equal(f.applied[0].text, NEXT);
  assert.equal(f.config().persona.activatedAt, STAMP);
  assert.equal(saved.needsApply, false);
  assert.equal(fs.statSync(f.activeFile).mtimeMs, modified);
  assert.deepEqual(f.editor.backup(saved.backups[0].id), { text: NEXT });
});

test('stale revision conflicts preserve external file edits and config', t => {
  const f = fixture(t), old = f.editor.state(), config = fs.readFileSync(f.configFile);
  fs.writeFileSync(f.activeFile, '外部新内容');
  expectError(() => f.editor.save({ text: NEXT, revision: old.revision }), 'PERSONA_CONFLICT', 409);
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), '外部新内容');
  assert.deepEqual(fs.readFileSync(f.configFile), config);
  assert.equal(f.applied.length, 0);
  assert.deepEqual(f.editor.state().backups, []);
});

test('changed active path in config is a conflict and is not overwritten', t => {
  const f = fixture(t), raw = f.config();
  raw.persona.file = 'persona/new.md';
  fs.writeFileSync(f.configFile, JSON.stringify(raw));
  const bytes = fs.readFileSync(f.configFile);
  expectError(() => f.editor.save({ text: NEXT, revision: f.editor.state().revision }), 'PERSONA_CONFLICT', 409);
  assert.deepEqual(fs.readFileSync(f.configFile), bytes);
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), ORIGINAL);
});

test('blank, NUL, nonstring, oversized UTF-8 and invalid revisions cannot save', t => {
  const f = fixture(t), revision = f.editor.state().revision, config = fs.readFileSync(f.configFile);
  for (const text of ['', ' \n\t', null, 123, '\0', 'a\0b']) {
    expectError(() => f.editor.save({ text, revision }), 'INVALID_PERSONA', 400);
  }
  expectError(() => f.editor.save({ text: '中'.repeat(Math.floor(MAX_PERSONA_BYTES / 3) + 1), revision }), 'PERSONA_TOO_LARGE', 413);
  for (const invalid of [null, '', 'x', 'a'.repeat(63), '../x', 22]) {
    expectError(() => f.editor.save({ text: NEXT, revision: invalid }), 'INVALID_REVISION', 400);
  }
  assert.deepEqual(fs.readFileSync(f.configFile), config);
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), ORIGINAL);
  assert.equal(f.applied.length, 0);
  assert.deepEqual(f.editor.state().backups, []);
});

test('maximum-size text with dense JSON escapes can be backed up and read exactly', t => {
  const text = 'x' + '\u0001'.repeat(MAX_PERSONA_BYTES - 1);
  const f = fixture(t, { text });
  const saved = f.editor.save({ text: NEXT, revision: f.editor.state().revision });
  assert.equal(saved.backups.length, 1);
  assert.deepEqual(f.editor.backup(saved.backups[0].id), { text });
  const savedAgain = f.editor.save({ text, revision: saved.revision });
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), text);
  assert.equal(savedAgain.backups.length, 2);
});

test('backup traversal, unknown ids, symlink files, and corrupt records are rejected', t => {
  const f = fixture(t), state = f.editor.save({ text: NEXT, revision: f.editor.state().revision });
  const realId = state.backups[0].id;
  for (const id of ['../../config', '/', `${realId}.json`, '..\\config', null, realId.toUpperCase(), '0-' + 'a'.repeat(32)]) {
    expectError(() => f.editor.backup(id), 'BACKUP_NOT_FOUND', 404);
  }
  const corruptId = '0-' + 'c'.repeat(32), symlinkId = '0-' + 'd'.repeat(32);
  fs.writeFileSync(path.join(f.backupDir, `${corruptId}.json`), '{');
  fs.symlinkSync(path.join(f.backupDir, `${realId}.json`), path.join(f.backupDir, `${symlinkId}.json`));
  expectError(() => f.editor.backup(corruptId), 'BACKUP_NOT_FOUND', 404);
  expectError(() => f.editor.backup(symlinkId), 'BACKUP_NOT_FOUND', 404);
  assert.deepEqual(f.editor.state().backups, state.backups);
});

for (const target of ['backup', 'active', 'config']) {
  test(`${target} write failure rolls back files and preserves runtime state`, t => {
    let failOnce = true;
    const io = { ...fs, renameSync(source, destination) {
      const matches = target === 'backup' ? destination.includes('/data/persona/backups/')
        : target === 'active' ? destination.endsWith('/persona/active.md') : destination.endsWith('/config.json');
      if (matches && failOnce) { failOnce = false; throw Object.assign(new Error('Injected rename failure'), { code: 'EIO' }); }
      return fs.renameSync(source, destination);
    } };
    const f = fixture(t, { io }), beforeCfg = structuredClone(f.cfg), beforeConfig = fs.readFileSync(f.configFile);
    expectError(() => f.editor.save({ text: NEXT, revision: f.editor.state().revision }), 'SAVE_FAILED', 503);
    assert.equal(fs.readFileSync(f.activeFile, 'utf8'), ORIGINAL);
    assert.deepEqual(fs.readFileSync(f.configFile), beforeConfig);
    assert.deepEqual(f.cfg, beforeCfg);
    assert.equal(f.applied.length, 0);
    assert.equal(f.editor.state().appliedRevision, hash(ORIGINAL));
    for (const directory of [path.join(f.rootDir, 'persona'), f.rootDir, f.backupDir]) {
      if (fs.existsSync(directory)) assert.ok(!fs.readdirSync(directory).some(file => file.endsWith('.tmp')));
    }
  });
}

test('callback failure restores exact config bytes, sparse runtime state and applied text', t => {
  const callbacks = [];
  const f = fixture(t, {
    cfg: configFile => ({ __file: configFile, __problems: [], persona: { file: 'persona/active.md' }, unrelated: { keep: true } }),
    onApply(entry) {
      callbacks.push({ text: entry.text, rollback: entry.rollback, cfg: structuredClone(entry.cfg) });
      if (!entry.rollback) throw new Error('Injected hot reload failure');
    },
  });
  const originalCfg = structuredClone(f.cfg), configBytes = fs.readFileSync(f.configFile);
  expectError(() => f.editor.save({ text: NEXT, revision: f.editor.state().revision }), 'SAVE_FAILED', 503);
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), ORIGINAL);
  assert.deepEqual(fs.readFileSync(f.configFile), configBytes);
  assert.deepEqual(f.cfg, originalCfg);
  assert.deepEqual(callbacks.map(x => ({ text: x.text, rollback: x.rollback })), [{ text: NEXT, rollback: false }, { text: ORIGINAL, rollback: true }]);
  assert.deepEqual(callbacks[1].cfg, originalCfg);
  assert.equal(f.editor.state().appliedRevision, hash(ORIGINAL));
  assert.equal(f.editor.state().backups.length, 1);
});

test('failed activation of an external edit rolls engine back to last applied text but keeps external file', t => {
  const callbacks = [];
  const f = fixture(t, { onApply(entry) { callbacks.push({ text: entry.text, rollback: entry.rollback }); if (!entry.rollback) throw new Error('Failure'); } });
  fs.writeFileSync(f.activeFile, NEXT);
  const state = f.editor.state(), bytes = fs.readFileSync(f.configFile);
  expectError(() => f.editor.save({ text: NEXT, revision: state.revision }), 'SAVE_FAILED', 503);
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), NEXT);
  assert.deepEqual(fs.readFileSync(f.configFile), bytes);
  assert.deepEqual(callbacks, [{ text: NEXT, rollback: false }, { text: ORIGINAL, rollback: true }]);
  assert.equal(f.editor.state().needsApply, true);
  assert.equal(f.editor.state().appliedRevision, hash(ORIGINAL));
});

test('a failure during rollback is reported distinctly and keeps a recoverable old backup', t => {
  const f = fixture(t, { onApply() { throw new Error('Persistent engine failure'); } });
  expectError(() => f.editor.save({ text: NEXT, revision: f.editor.state().revision }), 'ROLLBACK_FAILED', 503);
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), ORIGINAL);
  assert.equal(f.editor.state().backups.length, 1);
  assert.equal(f.editor.backup(f.editor.state().backups[0].id).text, ORIGINAL);
});

test('external config change during backup is caught before committing either active file', t => {
  let mutate = true;
  const io = { ...fs, renameSync(source, destination) {
    fs.renameSync(source, destination);
    if (mutate && destination.includes('/data/persona/backups/')) {
      mutate = false;
      const root = destination.slice(0, destination.indexOf('/data/persona/backups/'));
      const configFile = path.join(root, 'config.json'), raw = JSON.parse(fs.readFileSync(configFile));
      raw.bilibili.comments.maxPerDay = 99;
      fs.writeFileSync(configFile, JSON.stringify(raw));
    }
  } };
  const f = fixture(t, { io });
  expectError(() => f.editor.save({ text: NEXT, revision: f.editor.state().revision }), 'PERSONA_CONFLICT', 409);
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), ORIGINAL);
  assert.equal(f.config().bilibili.comments.maxPerDay, 99);
  assert.equal(f.applied.length, 0);
});

test('malformed disk config and invalid clocks never change active text', t => {
  const f = fixture(t);
  fs.writeFileSync(f.configFile, '{');
  expectError(() => f.editor.save({ text: NEXT, revision: f.editor.state().revision }), 'PERSONA_UNAVAILABLE', 503);
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), ORIGINAL);
  const badTime = fixture(t, { now: () => -1 });
  expectError(() => badTime.editor.save({ text: NEXT, revision: badTime.editor.state().revision }), 'SAVE_FAILED', 503);
  assert.equal(fs.readFileSync(badTime.activeFile, 'utf8'), ORIGINAL);
  assert.deepEqual(badTime.editor.state().backups, []);
});

test('a custom save does not invent missing group overrides', t => {
  const f = fixture(t), raw = f.config();
  delete raw.trigger.groupOverrides['70121'];
  delete f.cfg.trigger.groupOverrides['70121'];
  fs.writeFileSync(f.configFile, JSON.stringify(raw));
  f.editor.save({ text: NEXT, revision: f.editor.state().revision });
  assert.equal(Object.hasOwn(f.config().trigger.groupOverrides, '70121'), false);
  assert.equal(Object.hasOwn(f.cfg.trigger.groupOverrides, '70121'), false);
});
