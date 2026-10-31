import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const html = await fs.readFile(new URL('../src/bilibili/persona-form.html', import.meta.url), 'utf8');
const script = html.match(/<script nonce="__SCRIPT_NONCE__">([\s\S]*?)<\/script>/)[1];

function fixture(text = '目前的人设\n  保留空白  \n') {
  const elements = new Map();
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) elements.set(id, { value: '', textContent: '', disabled: false,
    listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
  const get = id => elements.get(id);
  get('personaFormText').value = text;
  get('personaFormTextJson').value = JSON.stringify(text);
  get('personaFormCsrf').value = 'test-csrf';
  get('personaFormRevision').value = 'a'.repeat(64);
  get('personaFormSave').disabled = true;
  const context = vm.createContext({ document: { getElementById: get },
    fetch() { throw new Error('Native form UI must not use fetch'); },
    XMLHttpRequest() { throw new Error('Native form UI must not use XHR'); },
    setTimeout() { throw new Error('Native form UI must not auto-retry'); },
    setInterval() { throw new Error('Native form UI must not poll'); },
  });
  new vm.Script(script).runInContext(context);
  return { get, submit() {
    let cancelled = false;
    get('personaForm').listeners.submit({ preventDefault() { cancelled = true; } });
    assert.equal(cancelled, false, 'Browser native form submission must proceed');
  } };
}

test('page uses an explicit same-origin native POST and preserves the original page', () => {
  const form = html.match(/<form\b[^>]+>/)[0];
  assert.match(form, /method="post"/);
  assert.match(form, /action="__PERSONA_FORM_ACTION__"/);
  assert.match(html, /href="__MANAGER_URL__"/);
  assert.match(form, /target="_blank"/);
  assert.match(form, /accept-charset="UTF-8"/);
  assert.match(html, /<meta name="referrer" content="same-origin">/);
  assert.match(html, /原稿页会保留，保存结果在新页面显示/);
  assert.match(html, /保存成功后，请在结果页继续编辑/);
  const textarea = html.match(/<textarea\b[^>]+>/)[0];
  assert.doesNotMatch(textarea, /\bname=|maxlength=|wrap="hard"/);
  assert.ok(html.includes(textarea + '\n__PERSONA_TEXT__</textarea>'), 'A template newline absorbs the HTML parser first-newline rule and preserves a user leading newline');
  for (const name of ['csrf', 'revision', 'textJson']) assert.ok(html.includes(`name="${name}"`));
  assert.equal((html.match(/<style nonce="__SCRIPT_NONCE__">/g) || []).length, 1);
  assert.equal((html.match(/<script nonce="__SCRIPT_NONCE__">/g) || []).length, 1);
  assert.doesNotMatch(script, /__PERSONA_|__CSRF_/);
});

test('save starts disabled and is only enabled after the submit listener is installed', () => {
  assert.match(html.match(/<button id="personaFormSave"[^>]+>/)[0], /\bdisabled\b/);
  const f = fixture();
  assert.equal(typeof f.get('personaForm').listeners.submit, 'function');
  assert.equal(f.get('personaFormSave').disabled, false);
  assert.equal(f.get('personaFormText').value, '目前的人设\n  保留空白  \n');
  assert.match(f.get('personaFormCount').textContent, /字/);
});

test('every explicit submit captures the current exact text without preventing native submission', () => {
  const f = fixture();
  const originalCsrf = f.get('personaFormCsrf').value;
  const originalRevision = f.get('personaFormRevision').value;
  for (const text of ['\n  新人设\t\n😀<>&"\\\n  ', '第二次修改\r\n还有一行\r结尾 ', '']) {
    f.get('personaFormText').value = text;
    f.get('personaFormText').listeners.input();
    f.submit();
    assert.equal(JSON.parse(f.get('personaFormTextJson').value), text);
    assert.equal(f.get('personaFormText').value, text, 'Submitting must not clear or replace the draft');
    assert.equal(f.get('personaFormCsrf').value, originalCsrf);
    assert.equal(f.get('personaFormRevision').value, originalRevision);
  }
  assert.match(f.get('personaFormProgress').textContent, /以新页面显示的结果为准/);
  assert.doesNotMatch(f.get('personaFormProgress').textContent, /已保存|生效成功/);
});

test('native URL encoding round-trips long Unicode and line endings through the JSON hidden field', () => {
  const f = fixture();
  const text = ' \r\n\t你好😀+&=%\n'.repeat(4000) + '\n  ';
  assert.ok(Buffer.byteLength(text) < 128 * 1024);
  f.get('personaFormText').value = text;
  f.submit();
  const wire = new URLSearchParams({ csrf: f.get('personaFormCsrf').value, revision: f.get('personaFormRevision').value,
    textJson: f.get('personaFormTextJson').value }).toString();
  const decoded = new URLSearchParams(wire);
  assert.equal(JSON.parse(decoded.get('textJson')), text);
  assert.ok(!f.get('personaFormTextJson').value.includes('\r'));
  assert.ok(!f.get('personaFormTextJson').value.includes('\n'));
});

test('typing only updates the count and never silently updates the submitted revision or draft', () => {
  const f = fixture();
  const initialPayload = f.get('personaFormTextJson').value;
  f.get('personaFormText').value = '我还没有保存';
  f.get('personaFormText').listeners.input();
  assert.equal(f.get('personaFormTextJson').value, initialPayload);
  assert.equal(f.get('personaFormText').value, '我还没有保存');
  assert.equal(f.get('personaFormRevision').value, 'a'.repeat(64));
  assert.equal(f.get('personaFormProgress').textContent, '');
});
