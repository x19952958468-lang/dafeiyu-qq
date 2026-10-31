import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createLoginServer } from '../src/bilibili/server.js';
import { createPersonaEditor } from '../src/persona-editor.js';

const SECRET = 'PRIVATE_CONFIG_KEY_NOT_FOR_HTML';
const EXCEPTION = 'PRIVATE_ENGINE_EXCEPTION_NOT_FOR_HTML';
const ORIGINAL = '\n\n原来的人设\r\n原样保留。\n';
const decodeHtml = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[name]));
function input(html, name) {
  const tag = html.match(new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`, 'i'))?.[0];
  assert.ok(tag, `Missing form field ${name}`);
  return decodeHtml(tag.match(/\bvalue="([^"]*)"/i)?.[1] ?? '');
}
async function fixture(t, { broken = false, saveResult } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-form-'));
  fs.mkdirSync(path.join(rootDir, 'persona'));
  const activeFile = path.join(rootDir, 'persona/active.md');
  fs.writeFileSync(activeFile, ORIGINAL);
  const cfg = { persona: { file: 'persona/active.md' }, trigger: {}, llm: { apiKey: SECRET }, singing: { version: 'd' }, bilibili: { enabled: false } };
  const configFile = path.join(rootDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(cfg));
  const applied = [], actions = [], logs = [];
  const editor = createPersonaEditor({ rootDir, cfg, onApply: value => applied.push(value.text) });
  const personaEditor = saveResult ? { ...editor, save: saveResult } : broken ? { ...editor, save() { throw new Error(EXCEPTION); } } : editor;
  const companion = Object.fromEntries(['status', 'friends', 'configure', 'createQr', 'pollQr', 'runNow'].map(name => [name, async () => { actions.push(name); return {}; }]));
  const server = createLoginServer({ companion, personaEditor, port: 0, log: message => logs.push(message) });
  const address = await server.start();
  t.after(async () => { await server.stop(); fs.rmSync(rootDir, { recursive: true, force: true }); });
  const response = await fetch(address.url + '/persona/editor'), html = await response.text();
  const csrf = input(html, 'csrf');
  const fields = (text, revision = editor.state().revision) => ({ csrf, revision, textJson: JSON.stringify(text) });
  const post = (form, { headers = {}, route = '/persona/save-form', raw = false } = {}) => fetch(address.url + route, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', ...headers },
    body: raw ? form : new URLSearchParams(form).toString(),
  });
  return { ...address, rootDir, editor, activeFile, configFile, applied, actions, logs, html, response, csrf, fields, post };
}
function noExternalActions(f) { assert.deepEqual(f.actions, []); }
function assertHtml(response) { assert.match(response.headers.get('content-type'), /^text\/html/); }

test('native editor GET renders actual persona read-only and only its CSP permits same-origin forms', async t => {
  const f = await fixture(t), originalRevision = f.editor.state().revision;
  assert.equal(f.response.status, 200);
  assertHtml(f.response);
  assert.equal(JSON.parse(input(f.html, 'textJson')), ORIGINAL);
  assert.equal(input(f.html, 'revision'), originalRevision);
  assert.match(f.html, /target="_blank"/);
  assert.ok(f.html.includes(`action="${f.url}/persona/save-form"`));
  assert.ok(f.html.includes(`href="${f.url}/?editor=2#persona"`));
  assert.match(f.response.headers.get('content-security-policy'), /form-action 'self'/);
  assert.equal(f.response.headers.get('referrer-policy'), 'same-origin');
  for (const route of ['/', '/api/persona']) {
    const response = await fetch(f.url + route);
    assert.match(response.headers.get('content-security-policy'), /form-action 'none'/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
  const forwarded = await fetch(f.url + '/persona/editor', { headers: { Forwarded: 'host=attacker.invalid', 'X-Forwarded-Host': 'attacker.invalid' } });
  const forwardedHtml = await forwarded.text();
  assert.ok(forwardedHtml.includes(`action="${f.url}/persona/save-form"`));
  assert.ok(!forwardedHtml.includes('attacker.invalid'));
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), ORIGINAL);
  assert.deepEqual(f.editor.state().backups, []);
  assert.deepEqual(f.applied, []);
  noExternalActions(f);
});

test('native POST saves Unicode, newlines, HTML and placeholder literals exactly once without injection', async t => {
  const f = await fixture(t);
  const text = '\n\n\r\n中英文😀 & " \' </textarea><script>alert("FORM_XSS")</script>\n' +
    '__CSRF_NONCE__ __SCRIPT_NONCE__ __PERSONA_TEXT__ __PERSONA_TEXT_JSON__ __PERSONA_REVISION__ __PERSONA_STATUS__ __PERSONA_STATUS_CLASS__ __PERSONA_FORM_ACTION__ __MANAGER_URL__\r\n 末尾空格  ';
  const response = await f.post(f.fields(text)), html = await response.text();
  assert.equal(response.status, 200);
  assertHtml(response);
  assert.match(response.headers.get('x-request-id'), /^[a-f0-9]{16}$/);
  assert.match(html, /已保存并生效/);
  assert.equal(JSON.parse(input(html, 'textJson')), text);
  assert.equal(input(html, 'revision'), f.editor.state().revision);
  assert.equal(input(html, 'csrf'), f.csrf);
  assert.ok(html.includes('&lt;/textarea&gt;&lt;script&gt;'));
  assert.ok(!html.includes('</textarea><script>alert'));
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), text);
  assert.deepEqual(f.applied, [text]);
  assert.equal(f.editor.state().backups.length, 1);
  assert.ok(f.logs.some(line => /path=\/persona\/save-form stage=finish phase=save status=200 /.test(line)));
  for (const privateValue of [SECRET, 'FORM_XSS', text, f.csrf, f.rootDir]) assert.ok(!f.logs.join('\n').includes(privateValue));
  noExternalActions(f);
});

test('stale revision returns HTML 409 with the submitted draft and old revision intact', async t => {
  const f = await fixture(t), oldRevision = f.editor.state().revision;
  const first = await f.post(f.fields('先保存的另一个版本', oldRevision));
  assert.equal(first.status, 200);
  const config = fs.readFileSync(f.configFile);
  const draft = '</textarea><script>别执行我</script> __PERSONA_STATUS__';
  const response = await f.post(f.fields(draft, oldRevision)), html = await response.text();
  assert.equal(response.status, 409);
  assertHtml(response);
  assert.equal(JSON.parse(input(html, 'textJson')), draft);
  assert.equal(input(html, 'revision'), oldRevision);
  assert.match(html, /草稿已保留/);
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), '先保存的另一个版本');
  assert.deepEqual(fs.readFileSync(f.configFile), config);
  assert.deepEqual(f.applied, ['先保存的另一个版本']);
  noExternalActions(f);
});

test('form CSRF failure retains draft while Host and Origin are rejected before reading or saving', async t => {
  const f = await fixture(t), before = f.editor.state(), config = fs.readFileSync(f.configFile);
  const draft = '验证失败仍保留草稿 & "';
  const badToken = await f.post({ ...f.fields(draft), csrf: 'incorrect' }), tokenHtml = await badToken.text();
  assert.equal(badToken.status, 403);
  assertHtml(badToken);
  assert.equal(JSON.parse(input(tokenHtml, 'textJson')), draft);
  assert.equal(input(tokenHtml, 'revision'), before.revision);
  assert.equal(input(tokenHtml, 'csrf'), f.csrf);
  assert.equal((await f.post(f.fields(draft), { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await f.post(f.fields(draft), { headers: { Origin: 'null' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const body = new URLSearchParams(f.fields(draft)).toString();
    const request = http.request({ hostname: '127.0.0.1', port: f.port, path: '/persona/save-form', method: 'POST',
      headers: { Host: `attacker.invalid:${f.port}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end(body);
  });
  assert.equal(badHostStatus, 403);
  assert.equal(f.editor.state().revision, before.revision);
  assert.deepEqual(fs.readFileSync(f.configFile), config);
  assert.deepEqual(f.applied, []);
  noExternalActions(f);
});

test('unknown, missing, duplicate, malformed and unsupported form fields never call save', async t => {
  const f = await fixture(t), before = f.editor.state(), valid = f.fields('草稿'), config = fs.readFileSync(f.configFile);
  const cases = [
    [{ ...valid, file: '/tmp/elsewhere' }, {}, 400],
    [{ csrf: f.csrf, textJson: valid.textJson }, {}, 400],
    [[...Object.entries(valid), ['csrf', f.csrf]], {}, 400],
    [[...Object.entries(valid), ['revision', before.revision]], {}, 400],
    [[...Object.entries(valid), ['textJson', JSON.stringify('别的正文')]], {}, 400],
    [{ ...valid, textJson: 'not json' }, {}, 400],
    [{ ...valid, textJson: '{}' }, {}, 400],
    [{ ...valid, revision: 'bad' }, {}, 400],
    [f.fields(''), {}, 400],
    [f.fields('含\0空字符'), {}, 400],
    [`csrf=${f.csrf}&revision=${before.revision}&textJson=%FF`, { raw: true }, 400],
    [valid, { headers: { 'Content-Type': 'application/json' } }, 415],
  ];
  for (const [body, options, expected] of cases) {
    const response = await f.post(body, options);
    assert.equal(response.status, expected);
    assertHtml(response);
    await response.text();
  }
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), before.text);
  assert.deepEqual(fs.readFileSync(f.configFile), config);
  assert.deepEqual(f.applied, []);
  assert.deepEqual(f.editor.state().backups, []);
  noExternalActions(f);
});

test('encoded form bound accepts worst-case valid 128 KiB text and rejects oversized decoded or encoded data', async t => {
  const f = await fixture(t);
  const text = 'x' + '\u0001'.repeat(128 * 1024 - 1);
  const body = f.fields(text);
  assert.ok(Buffer.byteLength(new URLSearchParams(body).toString()) < 128 * 1024 * 8 + 4096);
  const ok = await f.post(body);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(input(await ok.text(), 'textJson')), text);
  const before = f.editor.state(), config = fs.readFileSync(f.configFile);
  const tooLong = await f.post(f.fields('x'.repeat(128 * 1024 + 1))), longHtml = await tooLong.text();
  assert.equal(tooLong.status, 413);
  assertHtml(tooLong);
  assert.equal(JSON.parse(input(longHtml, 'textJson')).length, 128 * 1024 + 1);
  const tooEncoded = await f.post('x'.repeat(128 * 1024 * 8 + 4097), { raw: true });
  assert.equal(tooEncoded.status, 413);
  assertHtml(tooEncoded);
  await tooEncoded.text();
  assert.equal(f.editor.state().revision, before.revision);
  assert.deepEqual(fs.readFileSync(f.configFile), config);
  assert.deepEqual(f.applied, [text]);
  noExternalActions(f);
});

test('GET cannot write and a store failure returns sanitized HTML with recoverable draft', async t => {
  const f = await fixture(t, { broken: true }), before = f.editor.state(), config = fs.readFileSync(f.configFile);
  const get = await fetch(f.url + '/persona/save-form?' + new URLSearchParams(f.fields('不得写入')));
  assert.equal(get.status, 405);
  assertHtml(get);
  const draft = '服务失败时保留我 < & __PERSONA_REVISION__';
  const response = await f.post(f.fields(draft)), html = await response.text();
  assert.equal(response.status, 503);
  assertHtml(response);
  assert.equal(JSON.parse(input(html, 'textJson')), draft);
  assert.equal(input(html, 'revision'), before.revision);
  assert.ok(!html.includes(SECRET) && !html.includes(EXCEPTION) && !html.includes(f.rootDir));
  assert.equal(fs.readFileSync(f.activeFile, 'utf8'), before.text);
  assert.deepEqual(fs.readFileSync(f.configFile), config);
  assert.deepEqual(f.applied, []);
  assert.ok(!f.logs.join('\n').includes(EXCEPTION));
  noExternalActions(f);
});

test('JSON persona API remains available with its original JSON contract and strict CSP', async t => {
  const f = await fixture(t);
  const response = await fetch(f.url + '/api/persona', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': f.csrf },
    body: JSON.stringify({ text: '原JSON接口仍可用', revision: f.editor.state().revision }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.match(response.headers.get('content-security-policy'), /form-action 'none'/);
  assert.equal((await response.json()).text, '原JSON接口仍可用');
  assert.deepEqual(f.applied, ['原JSON接口仍可用']);
  noExternalActions(f);
});

test('an inconsistent manager result cannot claim form success and preserves the submitted draft', async t => {
  for (const mismatch of [
    result => ({ ...result, text: '返回了不一致的正文' }),
    result => ({ ...result, appliedRevision: '1'.repeat(64) }),
    result => ({ ...result, needsApply: true }),
  ]) {
    const f = await fixture(t, { saveResult: ({ text, revision }) => mismatch({ text, revision, appliedRevision: revision, needsApply: false }) });
    const before = f.editor.state(), draft = '我的提交草稿 < __PERSONA_STATUS__';
    const response = await f.post(f.fields(draft)), html = await response.text();
    assert.equal(response.status, 503);
    assertHtml(response);
    assert.match(html, /尚未确认生效/);
    assert.equal(JSON.parse(input(html, 'textJson')), draft);
    assert.equal(input(html, 'revision'), before.revision);
    assert.equal(fs.readFileSync(f.activeFile, 'utf8'), before.text);
    assert.deepEqual(f.applied, []);
    noExternalActions(f);
  }
});
