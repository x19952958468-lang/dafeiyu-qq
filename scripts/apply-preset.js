import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../src/paths.js';
import { validateSpeechConfig } from '../src/speech/index.js';

const REFERENCES = ['speech.wav', 'sad.wav', 'singing.wav'];
const EMOTIONS = ['happy', 'sad', 'annoyed', 'gentle', 'playful', 'surprised'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

/** Resolve fixed repository paths without following a local symlink outside the checkout. */
function localFile(root, relative) {
  const file = path.resolve(root, relative);
  requireValue(file.startsWith(root + path.sep), 'Preset target must stay inside the checkout');
  let cursor = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    cursor = path.join(cursor, part);
    try { requireValue(!fs.lstatSync(cursor).isSymbolicLink(), `Symlink is not allowed: ${relative}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return file;
}
function readFile(file, maxBytes = 1024 * 1024) {
  const stat = fs.lstatSync(file);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes, 'Invalid or oversized preset file');
  return fs.readFileSync(file);
}
function readJson(file) {
  const value = JSON.parse(readFile(file).toString('utf8'));
  requireValue(plain(value), 'Preset JSON must contain an object');
  return value;
}

/** Install local persona/parameters. No API calls, inference, or service restarts. */
export function applyPreset({ rootDir = REPO_ROOT, referencesDir, personaFile, now = Date.now, log = console.log } = {}) {
  const root = fs.realpathSync(rootDir);
  const preset = name => localFile(root, `presets/current/${name}`);
  let persona = null;
  try { persona = readFile(personaFile ? path.resolve(personaFile) : preset('persona.local.md'), 128 * 1024); }
  catch (error) { if (error.code !== 'ENOENT' || personaFile) throw error; }
  if (persona) requireValue(persona.length > 0 && !persona.includes(0), 'Persona must be nonempty text');
  const style = readJson(preset('persona-settings.json'));
  requireValue(Object.keys(style).every(key => ['selfName', 'naturalAddress', 'llmTemperature'].includes(key)) &&
    typeof style.selfName === 'string' && style.selfName.trim() && style.selfName.length <= 100 &&
    typeof style.naturalAddress === 'boolean' && Number.isFinite(style.llmTemperature) && style.llmTemperature >= 0 && style.llmTemperature <= 2,
  'Invalid persona settings');
  const manifest = readJson(preset('references.json'));
  requireValue(Array.isArray(manifest.files) && manifest.files.length === REFERENCES.length &&
    new Set(manifest.files.map(entry => entry?.file)).size === REFERENCES.length, 'Invalid reference manifest');
  for (const item of manifest.files) requireValue(plain(item) && REFERENCES.includes(item.file) &&
    /^[a-f0-9]{64}$/.test(item.sha256) && Number.isInteger(item.bytes) && item.bytes > 0 && item.bytes <= 20 * 1024 * 1024 &&
    Number.isFinite(item.durationSeconds) && item.durationSeconds > 0, 'Invalid reference manifest entry');
  const source = referencesDir ? fs.realpathSync(path.resolve(referencesDir)) : localFile(root, 'presets/current/references');
  const audio = new Map(), missing = [];
  for (const item of manifest.files) {
    const file = path.join(source, item.file);
    let content;
    try { content = readFile(file, 20 * 1024 * 1024); }
    catch (error) { if (error.code === 'ENOENT') { missing.push(item.file); continue; } throw error; }
    requireValue(content.length === item.bytes && sha(content) === item.sha256, `Reference checksum mismatch: ${item.file}`);
    audio.set(item.file, content);
  }
  const refTarget = name => localFile(root, `data/references/current/${name}`);
  const speechInput = readJson(preset('speech.json'));
  requireValue(speechInput.referenceAudio === 'speech.wav', 'Invalid speech reference name');
  const speech = validateSpeechConfig({ ...speechInput, enabled: false, referenceAudio: refTarget('speech.wav') });
  const profiles = readJson(preset('emotion-profiles.json'));
  requireValue(Object.keys(profiles).length === EMOTIONS.length && EMOTIONS.every(key => plain(profiles[key])), 'Invalid emotion profiles');
  for (const profile of Object.values(profiles)) {
    requireValue(Object.keys(profile).every(key => ['referenceAudio', 'referenceText', 'cfgScale', 'instruction', 'variant', 'vocalization'].includes(key)) &&
      ['speech.wav', 'sad.wav'].includes(profile.referenceAudio) && typeof profile.referenceText === 'string' &&
      profile.referenceText.trim() && profile.referenceText.length <= 10000 && typeof profile.instruction === 'string' && profile.instruction.length <= 2000 &&
      Number.isFinite(profile.cfgScale) && profile.cfgScale >= 0 && profile.cfgScale <= 5 &&
      ['8bit', 'mixed'].includes(profile.variant) && (profile.vocalization === undefined || profile.vocalization === 'sob'), 'Invalid emotion profile');
    profile.referenceAudio = refTarget(profile.referenceAudio);
  }
  const singingInput = readJson(preset('singing.json'));
  const ranges = { steps: [1, 200], pitch_shift: [-24, 24], inference_cfg_rate: [0, 5], vocal_highpass_hz: [0, 20000],
    vocal_lowpass_hz: [0, 22050], output_lufs: [-60, 0], target_seconds: [1, 600], inference_timeout_sec: [1, 3600] };
  requireValue(singingInput.reference === 'singing.wav' && Object.keys(singingInput).every(key => key === 'reference' || key in ranges || ['python', 'seed_root', 'data_root', 'ffmpeg', 'runtime_log', 'env'].includes(key)) &&
    Object.entries(ranges).every(([key, [min, max]]) => Number.isFinite(singingInput[key]) && singingInput[key] >= min && singingInput[key] <= max), 'Invalid singing preset');
  const singingFile = localFile(root, 'integrations/singing/settings.local.json');
  const singing = { ...readJson(fs.existsSync(singingFile) ? singingFile : localFile(root, 'integrations/singing/settings.example.json')),
    ...Object.fromEntries(Object.keys(ranges).map(key => [key, singingInput[key]])), reference: 'data/references/current/singing.wav' };
  const timestamp = now();
  requireValue(Number.isSafeInteger(timestamp) && timestamp > 0, 'Invalid timestamp');
  const targets = new Map([
    ['data/speech/config.json', json(speech)], ['data/speech/emotion-profiles.json', json(profiles)],
    ['integrations/singing/settings.local.json', json(singing)],
  ]);
  if (persona) {
    const configFile = ['config.json', 'config.local.json', 'config.example.json'].map(name => localFile(root, name)).find(fs.existsSync);
    requireValue(configFile, 'Run npm run setup or provide config.example.json first');
    const config = readJson(configFile);
    requireValue((config.persona === undefined || plain(config.persona)) && (config.llm === undefined || plain(config.llm)), 'Invalid local configuration');
    config.persona = { ...config.persona, file: 'persona/dafeiyu.md', selfName: style.selfName,
      naturalAddress: style.naturalAddress, activatedAt: timestamp };
    config.llm = { ...config.llm, temperature: style.llmTemperature };
    targets.set('persona/dafeiyu.md', persona);
    targets.set('config.json', json(config));
  }
  if (!missing.length) for (const [name, content] of audio) targets.set(`data/references/current/${name}`, content);
  // Validate every destination and capture old bytes before creating anything.
  const old = new Map();
  for (const name of targets.keys()) {
    const destination = localFile(root, name);
    old.set(name, fs.existsSync(destination) ? readFile(destination, 20 * 1024 * 1024) : null);
  }
  const backupRelative = `data/preset-backups/${timestamp}-${crypto.randomUUID()}`;
  const backup = localFile(root, backupRelative);
  const staged = new Map(), written = [];
  try {
    // Keep recoverable originals before any target is replaced.
    for (const [name, previous] of old) if (previous !== null) {
      const file = path.join(backup, name);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, previous, { flag: 'wx', mode: 0o600 });
    }
    for (const [name, content] of targets) {
      const file = localFile(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      staged.set(name, temporary);
      fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    }
    for (const [name, temporary] of staged) { fs.renameSync(temporary, localFile(root, name)); written.push(name); }
  } catch (error) {
    for (const name of written.reverse()) {
      const file = localFile(root, name), previous = old.get(name);
      try { previous === null ? fs.rmSync(file, { force: true }) : fs.writeFileSync(file, previous, { mode: 0o600 }); }
      catch { /* Any original is still retained in the backup directory. */ }
    }
    throw new Error(`Preset installation failed; originals, if any, are in ${backupRelative}`, { cause: error });
  } finally { for (const file of staged.values()) fs.rmSync(file, { force: true }); }
  log('Applied voice parameters. Speech remains disabled; no services were started.');
  log(persona ? 'Applied the supplied local persona.' : 'No local persona supplied; current persona and root configuration were preserved.');
  if (missing.length) log(`Missing references: ${missing.join(', ')}. No reference audio was copied.`);
  else log('Validated and installed all three reference files.');
  if ([...old.values()].some(value => value !== null)) log(`Previous files backed up under ${backupRelative}`);
  return { personaImported: !!persona, missing, installedReferences: missing.length ? [] : [...audio.keys()], backupDir: backup,
    writtenFiles: [...targets.keys()] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  try {
    requireValue(args.length % 2 === 0, 'Expected an option value');
    for (let index = 0; index < args.length; index += 2) {
      const option = args[index], value = args[index + 1];
      requireValue(['--references', '--persona'].includes(option) && value && !Object.hasOwn(options, option), 'Invalid or repeated option');
      options[option] = value;
    }
    applyPreset({ referencesDir: options['--references'], personaFile: options['--persona'] });
  } catch (error) {
    console.error(error.message);
    console.error('Usage: node scripts/apply-preset.js [--references /path/to/reference-directory] [--persona /path/to/persona.md]');
    process.exitCode = 1;
  }
}
