import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoginServer } from '../src/bilibili/server.js';
import { createPersonaEditor } from '../src/persona-editor.js';

const SECRET = 'DO_NOT_EXPOSE_CONFIG_SECRET';
async function fixture(t, { editorOverride } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-api-'));
  fs.mkdirSync(path.join(rootDir, 'persona'));
  const file = path.join(rootDir, 'persona/active.md');
  fs.writeFileSync(file, '# 原来的人设\n认真听人说话。\n');
  const cfg = { persona: { file: 'persona/active.md' }, trigger: {}, llm: { apiKey: SECRET } };
  fs.writeFileSync(path.join(rootDir, 'config.json'), JSON.stringify(cfg));
  const applied = [];
  const editor = createPersonaEditor({ rootDir, cfg, onApply: value => applied.push(value.text) });
  const actions = [];
  const companion = Object.fromEntries(['status', 'friends', 'configure', 'createQr', 'pollQr', 'runNow'].map(name => [name, async () => { actions.push(name); return {}; }]));
  const server = createLoginServer({ companion, personaEditor: editorOverride === undefined ? editor : editorOverride, port: 0 });
  const { url } = await server.start();
  t.after(async () => { await server.stop(); fs.rmSync(rootDir, { recursive: true, force: true }); });
  const html = await (await fetch(url)).text();
  const token = html.match(/name="csrf-token" content="([^"]+)"/)[1];
  const get = async route => fetch(url + route);
  const post = (body, { route = '/api/persona', headers = {} } = {}) => fetch(url + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, ...headers }, body: JSON.stringify(body),
  });
  return { get, post, editor, file, cfg, applied, actions, rootDir };
}

test('API saves full Unicode text verbatim, applies it and serves a read-only backup', async t => {
  const f = await fixture(t);
  const before = await (await f.get('/api/persona')).json();
  assert.equal(before.available, true);
  assert.equal(before.needsApply, false);
  const text = '# 我自己填写的人设\n' + '她喜欢音乐，也愿意认真回答问题。\n'.repeat(1500) + '保留结尾空行。\n\n';
  assert.ok(Buffer.byteLength(text) > 16384);
  const response = await f.post({ text, revision: before.revision });
  assert.equal(response.status, 200);
  const after = await response.json();
  assert.equal(after.text, text);
  assert.equal(after.appliedRevision, after.revision);
  assert.equal(fs.readFileSync(f.file, 'utf8'), text);
  assert.deepEqual(f.applied, [text]);
  assert.equal(after.backups.length, 1);
  const backup = await (await f.get('/api/persona/backup?id=' + after.backups[0].id)).json();
  assert.equal(backup.text, before.text);
  assert.equal(fs.readFileSync(f.file, 'utf8'), text);
  assert.ok(!JSON.stringify(after).includes(SECRET));
  assert.ok(!JSON.stringify(after).includes(f.rootDir));
  assert.ok(!JSON.stringify(backup).includes(SECRET));
  assert.equal(backup.profile, undefined);
  assert.deepEqual(f.actions, []);
});

test('stale revisions return 409 without overwriting either saved text or configuration', async t => {
  const f = await fixture(t), before = f.editor.state();
  assert.equal((await f.post({ text: '先保存的新版本', revision: before.revision })).status, 200);
  const conflict = await f.post({ text: '另一个页面的旧草稿', revision: before.revision });
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error, /草稿已保留/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '先保存的新版本');
  assert.deepEqual(f.applied, ['先保存的新版本']);
});

test('external edit can be applied through API even when the loaded text is unchanged', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.file, '在文件里填写的新版本\n');
  const before = await (await f.get('/api/persona')).json();
  assert.equal(before.needsApply, true);
  const after = await (await f.post({ text: before.text, revision: before.revision })).json();
  assert.equal(after.needsApply, false);
  assert.deepEqual(f.applied, [before.text]);
});

test('invalid, cross-origin and arbitrary-path requests cause no writes or callbacks', async t => {
  const f = await fixture(t), before = f.editor.state();
  const data = { text: '测试人设', revision: before.revision };
  for (const body of [{ ...data, path: '/tmp/elsewhere' }, { ...data, revision: 'bad' }, { ...data, text: '' }, { ...data, text: '含\0空字符' }]) assert.equal((await f.post(body)).status, 400);
  assert.equal((await f.post({ ...data, text: 'x'.repeat(128 * 1024 + 1) })).status, 413);
  assert.equal((await f.post({ ...data, text: 'x'.repeat(800000) })).status, 413);
  assert.equal((await f.post(data, { headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await f.post(data, { headers: { Origin: 'https://elsewhere.invalid' } })).status, 403);
  assert.equal((await f.get('/api/persona/backup?id=../../config.json')).status, 404);
  assert.equal((await f.post({ keywords: ['x'.repeat(17000)] }, { route: '/api/config' })).status, 413);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before.text);
  assert.deepEqual(f.applied, []);
  assert.deepEqual(f.actions, []);
});

test('unavailable or failed editor returns clear errors without exposing internal data', async t => {
  const disabled = await fixture(t, { editorOverride: null });
  assert.deepEqual(await (await disabled.get('/api/persona')).json(), { available: false });
  const broken = await fixture(t, { editorOverride: {
    state() { throw new Error(SECRET); }, save() { throw new Error(SECRET); }, backup() { throw new Error(SECRET); },
  } });
  for (const route of ['/api/persona', '/api/persona/backup?id=test']) {
    const response = await broken.get(route);
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes(SECRET));
  }
});
