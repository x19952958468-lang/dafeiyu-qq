import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { applyPreset } from './apply-preset.js';
import { REPO_ROOT } from '../src/paths.js';

const names = ['speech.wav', 'sad.wav', 'singing.wav'];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const read = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
function put(root, file, value) {
  const location = path.join(root, file);
  fs.mkdirSync(path.dirname(location), { recursive: true });
  fs.writeFileSync(location, typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value));
}
function snapshot(root, relative = '') {
  return Object.fromEntries(fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(item => {
    const file = path.join(relative, item.name);
    return item.isDirectory() ? Object.entries(snapshot(root, file)) : [[file, item.isSymbolicLink() ? 'symlink' : hash(fs.readFileSync(path.join(root, file)))]];
  }));
}
function fixture(t, { withPersona = true, withAudio = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'preset-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { persona: { file: 'persona/custom.md', selfName: 'Local name', naturalAddress: false },
    llm: { apiKey: 'FAKE_LOCAL_API_KEY', temperature: .2, model: 'local-model' },
    whitelist: { groups: ['12345'], friends: ['23456'] }, singing: { enabled: false }, onebot: { accessToken: 'FAKE_TOKEN' } };
  put(root, 'config.json', config);
  put(root, 'persona/dafeiyu.md', 'Previous local persona.\n');
  put(root, 'persona/custom.md', 'Custom active file.\n');
  put(root, 'presets/current/persona-settings.json', { selfName: 'Demo', naturalAddress: true, llmTemperature: .85 });
  const persona = Buffer.from('  A neutral supplied persona.\nKeep formatting.\n');
  if (withPersona) put(root, 'presets/current/persona.local.md', persona);
  put(root, 'presets/current/speech.json', { enabled: true, mode: 'auto', autoRate: .7, intensity: .85,
    referenceAudio: 'speech.wav', referenceText: 'Reference transcript.', ffmpeg: 'ffmpeg', cfgScale: 4, seed: 42 });
  const emotions = Object.fromEntries(['happy', 'sad', 'annoyed', 'gentle', 'playful', 'surprised'].map(key => [key,
    { referenceAudio: key === 'sad' ? 'sad.wav' : 'speech.wav', referenceText: 'Reference transcript.',
      cfgScale: key === 'sad' ? 2 : 4, instruction: 'Speak naturally.', variant: 'mixed', ...(key === 'sad' ? { vocalization: 'sob' } : {}) }]));
  put(root, 'presets/current/emotion-profiles.json', emotions);
  const singing = { python: 'work/singing-venv/bin/python', seed_root: 'work/seed-vc', data_root: 'data/singing',
    reference: 'singing.wav', ffmpeg: 'ffmpeg', runtime_log: 'data/singing/worker.log', env: { PYTORCH_ENABLE_MPS_FALLBACK: '1' },
    steps: 50, pitch_shift: 12, inference_cfg_rate: .7, vocal_highpass_hz: 70, vocal_lowpass_hz: 8000,
    output_lufs: -18, target_seconds: 20, inference_timeout_sec: 300 };
  put(root, 'presets/current/singing.json', singing);
  put(root, 'integrations/singing/settings.example.json', { ...singing, reference: 'data/singing/reference.wav' });
  const audio = Object.fromEntries(names.map(name => [name, Buffer.from(`Synthetic fixture ${name}`)]));
  put(root, 'presets/current/references.json', { files: names.map(file => ({ file, sha256: hash(audio[file]), bytes: audio[file].length,
    durationSeconds: 1, sourceUrl: 'https://example.test/reference' })), redistribution: { permission: 'test-fixture' } });
  if (withAudio) for (const [name, value] of Object.entries(audio)) put(root, `presets/current/references/${name}`, value);
  const logs = [];
  const run = extra => applyPreset({ rootDir: root, now: () => 1793450000000, log: line => logs.push(line), ...extra });
  return { root, run, config, persona, audio, logs };
}

test('imports exact opaque persona and verified refs, preserving account settings and backups', t => {
  const f = fixture(t);
  put(f.root, 'data/speech/config.json', { enabled: true, referenceAudio: 'old.wav' });
  put(f.root, 'integrations/singing/settings.local.json', { ...read(f.root, 'integrations/singing/settings.example.json'), python: 'custom/python', data_root: 'data/custom-singing' });
  const previousConfig = fs.readFileSync(path.join(f.root, 'config.json'));
  const result = f.run();
  assert.deepEqual(result.missing, []);
  assert.equal(result.personaImported, true);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'persona/dafeiyu.md')), f.persona);
  const after = read(f.root, 'config.json');
  assert.deepEqual(after.whitelist, f.config.whitelist);
  assert.deepEqual(after.onebot, f.config.onebot);
  assert.deepEqual(after.singing, f.config.singing);
  assert.equal(after.llm.apiKey, f.config.llm.apiKey);
  assert.equal(after.llm.temperature, .85);
  assert.equal(after.persona.file, 'persona/dafeiyu.md');
  assert.equal(after.persona.activatedAt, 1793450000000);
  assert.deepEqual(fs.readFileSync(path.join(result.backupDir, 'config.json')), previousConfig);
  assert.equal(fs.readFileSync(path.join(result.backupDir, 'persona/dafeiyu.md'), 'utf8'), 'Previous local persona.\n');
  const speech = read(f.root, 'data/speech/config.json');
  assert.equal(speech.enabled, false);
  assert.equal(speech.referenceAudio, path.join(f.root, 'data/references/current/speech.wav'));
  assert.equal(read(f.root, 'data/speech/emotion-profiles.json').sad.referenceAudio, path.join(f.root, 'data/references/current/sad.wav'));
  const singing = read(f.root, 'integrations/singing/settings.local.json');
  assert.equal(singing.reference, 'data/references/current/singing.wav');
  assert.equal(singing.python, 'custom/python');
  assert.equal(singing.data_root, 'data/custom-singing');
  for (const name of names) assert.deepEqual(fs.readFileSync(path.join(f.root, 'data/references/current', name)), f.audio[name]);
  assert.ok(!f.logs.join('\n').includes('FAKE_LOCAL_API_KEY'));
  assert.ok(!f.logs.join('\n').includes(f.persona.toString()));
});

test('no local persona preserves root config and active files byte-for-byte while importing voices', t => {
  const f = fixture(t, { withPersona: false });
  const original = fs.readFileSync(path.join(f.root, 'config.json'));
  const result = f.run();
  assert.equal(result.personaImported, false);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'config.json')), original);
  assert.equal(fs.readFileSync(path.join(f.root, 'persona/custom.md'), 'utf8'), 'Custom active file.\n');
  assert.equal(fs.readFileSync(path.join(f.root, 'persona/dafeiyu.md'), 'utf8'), 'Previous local persona.\n');
  assert.deepEqual(result.installedReferences.sort(), names.slice().sort());
  assert.equal(read(f.root, 'data/speech/config.json').enabled, false);
});

test('missing references still imports parameters and persona without copying partial audio', t => {
  const f = fixture(t, { withAudio: false });
  put(f.root, 'presets/current/references/speech.wav', f.audio['speech.wav']);
  const result = f.run();
  assert.deepEqual(result.missing, ['sad.wav', 'singing.wav']);
  assert.deepEqual(result.installedReferences, []);
  assert.equal(fs.existsSync(path.join(f.root, 'data/references/current/speech.wav')), false);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'persona/dafeiyu.md')), f.persona);
  assert.equal(read(f.root, 'data/speech/config.json').enabled, false);
});

test('explicit private bundle paths work, and a repeat run retains recoverable previous files', t => {
  const f = fixture(t, { withAudio: false, withPersona: false });
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'private-bundle-test-'));
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  for (const name of names) put(bundle, `references/${name}`, f.audio[name]);
  put(bundle, 'persona.md', f.persona);
  const options = { personaFile: path.join(bundle, 'persona.md'), referencesDir: path.join(bundle, 'references') };
  const first = f.run(options), second = f.run(options);
  assert.notEqual(first.backupDir, second.backupDir);
  assert.deepEqual(fs.readFileSync(path.join(second.backupDir, 'persona/dafeiyu.md')), f.persona);
  assert.deepEqual(fs.readFileSync(path.join(second.backupDir, 'data/references/current/speech.wav')), f.audio['speech.wav']);
  assert.equal(read(f.root, 'config.json').llm.apiKey, f.config.llm.apiKey);
});

for (const [name, corrupt] of [
  ['checksum mismatch', f => put(f.root, 'presets/current/references/sad.wav', 'corrupt')],
  ['path traversal manifest', f => { const m = read(f.root, 'presets/current/references.json'); m.files[0].file = '../speech.wav'; put(f.root, 'presets/current/references.json', m); }],
  ['unknown speech setting', f => { const s = read(f.root, 'presets/current/speech.json'); s.apiKey = 'invalid'; put(f.root, 'presets/current/speech.json', s); }],
  ['malformed parameters', f => put(f.root, 'presets/current/singing.json', '{')],
]) test(`${name} fails before any target mutation`, t => {
  const f = fixture(t); corrupt(f);
  const before = snapshot(f.root);
  assert.throws(() => f.run());
  assert.deepEqual(snapshot(f.root), before);
});

test('symlink destination is rejected before writing outside the checkout', t => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-preset-test-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(f.root, 'data'), 'dir');
  const before = snapshot(f.root);
  assert.throws(() => f.run(), /Symlink/);
  assert.deepEqual(snapshot(f.root), before);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('explicit missing persona is an error rather than a silent partial import', t => {
  const f = fixture(t, { withPersona: false });
  const before = snapshot(f.root);
  assert.throws(() => f.run({ personaFile: path.join(f.root, 'missing-persona.md') }));
  assert.deepEqual(snapshot(f.root), before);
});


test('published voice preset installs in an isolated checkout without a private persona', t => {
  const f = fixture(t, { withPersona: false });
  const files = ['persona-settings.json', 'speech.json', 'emotion-profiles.json', 'singing.json', 'references.json',
    ...names.map(name => `references/${name}`)];
  for (const file of files) put(f.root, `presets/current/${file}`, fs.readFileSync(path.join(REPO_ROOT, 'presets/current', file)));
  const original = fs.readFileSync(path.join(f.root, 'config.json'));
  const result = f.run();
  assert.equal(result.personaImported, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'config.json')), original);
  assert.equal(read(f.root, 'data/speech/config.json').enabled, false);
});
