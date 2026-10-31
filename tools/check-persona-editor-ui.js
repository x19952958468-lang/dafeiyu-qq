import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Execute the shipped page script with a small DOM and API fixture. No QQ or
// Bilibili writes and no production persona files are involved in these tests.
const html = await fs.readFile(new URL('../src/bilibili/login.html', import.meta.url), 'utf8');
const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture({ available = true } = {}) {
  const elements = new Map(), requests = [], intervals = [], windowListeners = {};
  let state = { available, text: '原来的人设\n第二行', revision: 'r1', appliedRevision: 'r1', needsApply: false, updatedAt: '2026-10-30T10:00:00Z',
    backups: [{ id: 'backup-one.md', createdAt: '2026-10-29T10:00:00Z', label: '10月29日的版本' }] };
  let getResponse = null, nextSaveError = null, nextBackupError = null, nextSaveResponse = null;
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
  function applySave(patch) { state = { ...state, text: patch.text, revision: state.revision + '-saved', appliedRevision: state.revision + '-saved', needsApply: false }; }
  const backups = new Map([['backup-one.md', '历史人设\n  原样缩进  \n']]);
  function element() {
    return { value: '', textContent: '', disabled: false, hidden: false, className: '', listeners: {}, children: [],
      addEventListener(type, fn) { this.listeners[type] = fn; }, append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; }, add(option) { this.children.push(option); },
      checkValidity: () => true, reportValidity() {},
    };
  }
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) elements.set(id, element());
  const get = id => elements.get(id);
  const context = vm.createContext({
    document: { getElementById: get, querySelector: () => ({ content: 'test-csrf' }), createElement: element, addEventListener() {}, hidden: false },
    window: { addEventListener(type, fn) { windowListeners[type] = fn; } },
    Option: function(text, value) { this.text = text; this.value = value; },
    setTimeout: () => 0, clearTimeout() {}, setInterval(fn) { intervals.push(fn); },
    async fetch(route, options) {
      requests.push({ route, options });
      let body, status = 200;
      if (route === '/api/persona') {
        if (options.method === 'POST') {
          const patch = JSON.parse(options.body);
          if (nextSaveResponse) {
            const override = nextSaveResponse; nextSaveResponse = null;
            if (override.apply) applySave(patch);
            if (override.reject) throw new TypeError('Failed to fetch');
            return { ok: override.status >= 200 && override.status < 300, status: override.status,
              async text() { if (override.interrupt) throw new TypeError('Load failed'); return override.raw; },
              async json() { throw new Error('The page must read the response body as text first'); } };
          }
          if (nextSaveError) { status = nextSaveError.status; body = { error: nextSaveError.message }; nextSaveError = null; }
          else if (patch.revision !== state.revision) { status = 409; body = { error: '版本已改变' }; }
          else { applySave(patch); body = structuredClone(state); }
        } else if (getResponse) {
          const response = getResponse; getResponse = null; return response;
        } else body = structuredClone(state);
      } else if (route.startsWith('/api/persona/backup?')) {
        if (nextBackupError) { status = 404; body = { error: '此历史版本已不存在。' }; nextBackupError = null; }
        else body = { text: backups.get(new URL(route, 'http://localhost').searchParams.get('id')) };
      } else if (route === '/api/status') body = { phase: 'awaiting_login', account: { loggedIn: false }, config: {}, stats: {}, recent: [] };
      else if (route === '/api/speech') body = { available: false, config: null };
      else if (route === '/api/friends') body = { friends: [] };
      else throw new Error('Unexpected request: ' + route);
      return response(body, status);
    },
  });
  new vm.Script(script).runInContext(context);
  await settle();
  return { get, requests, backups, windowListeners,
    state: () => structuredClone(state),
    setState(patch) { Object.assign(state, patch); if (patch.revision && !state.needsApply && patch.appliedRevision === undefined) state.appliedRevision = patch.revision; },
    failSave(status, message) { nextSaveError = { status, message }; },
    overrideSave(options = {}) { nextSaveResponse = { status: 200, raw: '', ...options }; },
    failNextGet() { getResponse = response({ error: '模拟状态读取失败' }, 503); },
    failBackup() { nextBackupError = true; },
    deferGet() { let resolve; getResponse = new Promise(done => { resolve = done; }); return snapshot => resolve(response(snapshot)); },
    edit(text) { get('personaText').value = text; get('personaText').listeners.input(); },
    async poll() { intervals.forEach(fn => fn()); await settle(); },
    click(id) { return get(id).listeners.click(); },
  };
}

test('persona editor is prominent, has no small text limit, and loads without sending messages', async () => {
  assert.ok(html.indexOf('id="persona"') < html.indexOf('id="settingsTitle"'));
  assert.match(html, /保存后用于下一条回复，旧版本自动备份，聊天记录保留/);
  assert.doesNotMatch(html.match(/<textarea id="personaText"[^>]*>/)[0], /maxlength/);
  const f = await fixture();
  assert.equal(f.get('personaText').value, f.state().text);
  assert.equal(f.get('personaText').disabled, false);
  assert.equal(f.get('savePersona').disabled, true);
  assert.equal(f.requests.filter(({ options }) => options.method === 'POST').length, 0);
  assert.ok(f.requests.every(({ options }) => options.credentials === 'omit'), 'Local UI must not attach cookies from another localhost service');
  assert.match(f.get('personaCount').textContent, /字/);
});

test('saves original text, including whitespace and long content, with CSRF and the loaded revision', async () => {
  const f = await fixture();
  const text = '\n  我的新角色\n特殊字符：<>&“”\t😀\n' + '人设'.repeat(20000) + '\n  ';
  f.edit(text);
  assert.equal(f.get('savePersona').disabled, false);
  assert.equal(f.get('personaStatus').textContent, '未保存');
  await f.click('savePersona');
  const posts = f.requests.filter(({ options }) => options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].route, '/api/persona');
  assert.equal(posts[0].options.headers['X-CSRF-Token'], 'test-csrf');
  assert.equal(posts[0].options.credentials, 'omit');
  assert.deepEqual(JSON.parse(posts[0].options.body), { text, revision: 'r1' });
  assert.equal(f.state().text, text);
  assert.equal(f.get('personaText').value, text);
  assert.equal(f.get('savePersona').disabled, true);
  assert.match(f.get('personaResult').textContent, /下一条回复/);
});

test('polling refreshes clean text but preserves a draft and its base revision after an external update', async () => {
  const f = await fixture();
  f.setState({ text: '另一个页面的更改', revision: 'r2' });
  await f.poll();
  assert.equal(f.get('personaText').value, '另一个页面的更改');
  f.edit('本页的草稿');
  f.setState({ text: '又一个更改', revision: 'r3' });
  await f.poll();
  assert.equal(f.get('personaText').value, '本页的草稿');
  assert.equal(f.get('personaStatus').textContent, '版本有变化');
  await f.click('savePersona');
  const posted = f.requests.find(({ options }) => options.method === 'POST');
  assert.equal(JSON.parse(posted.options.body).revision, 'r2');
  assert.equal(f.get('personaText').value, '本页的草稿');
  assert.match(f.get('personaResult').textContent, /草稿已保留/);
  assert.equal(f.state().text, '又一个更改');
});

test('HTTP 409 and save errors preserve the draft and re-enable editing', async () => {
  const f = await fixture();
  f.edit('未保存的文字');
  f.failSave(409, '冲突');
  await f.click('savePersona');
  assert.equal(f.get('personaText').value, '未保存的文字');
  assert.equal(f.get('personaStatus').textContent, '版本有变化');
  assert.match(f.get('personaResult').textContent, /保存未完成.*草稿已保留/);
  assert.equal(f.get('savePersona').disabled, false);
  assert.equal(f.get('personaText').disabled, false);
  f.failSave(400, '人设正文不能超过 128 KiB。');
  await f.click('savePersona');
  assert.equal(f.get('personaText').value, '未保存的文字');
  assert.match(f.get('personaResult').textContent, /128 KiB/);
});

test('restoring a history entry loads a draft and only activates after explicit save', async () => {
  const f = await fixture();
  const oldActive = f.state().text;
  assert.match(f.get('personaBackup').children[1].text, /2026.*10月29日的版本/);
  f.get('personaBackup').value = 'backup-one.md';
  f.get('personaBackup').listeners.change();
  assert.equal(f.get('loadPersonaBackup').disabled, false);
  await f.click('loadPersonaBackup');
  assert.equal(f.get('personaText').value, f.backups.get('backup-one.md'));
  assert.equal(f.state().text, oldActive);
  assert.equal(f.requests.filter(({ options }) => options.method === 'POST').length, 0);
  assert.match(f.get('personaResult').textContent, /尚未生效/);
  await f.click('savePersona');
  assert.equal(f.state().text, f.backups.get('backup-one.md'));
  f.edit('其他草稿');
  f.failBackup();
  await f.click('loadPersonaBackup');
  assert.equal(f.get('personaText').value, '其他草稿');
  assert.match(f.get('personaResult').textContent, /已保留/);
});

test('an externally changed persona can be applied without manufacturing an unsaved edit', async () => {
  const f = await fixture();
  f.setState({ text: '从文件修改的新正文', revision: 'external-r2', needsApply: true });
  await f.poll();
  assert.equal(f.get('personaText').value, '从文件修改的新正文');
  assert.equal(f.get('personaStatus').textContent, '待生效');
  assert.equal(f.get('savePersona').disabled, false);
  assert.match(f.get('personaResult').textContent, /尚未用于回复/);
  await f.click('savePersona');
  const post = f.requests.find(({ options }) => options.method === 'POST');
  assert.deepEqual(JSON.parse(post.options.body), { text: '从文件修改的新正文', revision: 'external-r2' });
  assert.equal(f.get('personaStatus').textContent, '已保存');
  assert.equal(f.get('savePersona').disabled, true);
});

test('explicit reload explains draft discard, and accidental page unload warns while dirty', async () => {
  const f = await fixture();
  f.edit('本地草稿');
  assert.equal(f.get('reloadPersona').textContent, '放弃草稿并重载');
  let prevented = false;
  f.windowListeners.beforeunload({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  f.setState({ text: '最新版本', revision: 'r2' });
  await f.click('reloadPersona');
  assert.equal(f.get('personaText').value, '最新版本');
  assert.equal(f.get('personaStatus').textContent, '已保存');
  prevented = false;
  f.windowListeners.beforeunload({ preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
});

test('late polling response cannot overwrite a draft or a newly saved version', async () => {
  const f = await fixture();
  const oldSnapshot = f.state();
  const finish = f.deferGet();
  await f.poll();
  f.edit('新版本');
  await f.click('savePersona');
  finish(oldSnapshot);
  await settle();
  assert.equal(f.get('personaText').value, '新版本');
  assert.equal(f.get('personaStatus').textContent, '已保存');
  f.edit('下一次更改');
  await f.click('savePersona');
  assert.equal(f.state().text, '下一次更改', 'Save must retain the latest successful revision');
});

test('an unavailable persona editor leaves other settings usable and can be reloaded later', async () => {
  const f = await fixture({ available: false });
  assert.equal(f.get('personaText').disabled, true);
  assert.equal(f.get('savePersona').disabled, true);
  assert.equal(f.get('reloadPersona').disabled, false);
  assert.equal(f.get('phaseText').textContent, '等待 B站登录');
  f.setState({ available: true });
  await f.click('reloadPersona');
  assert.equal(f.get('personaText').disabled, false);
  assert.equal(f.get('personaText').value, f.state().text);
});

for (const [status, expected] of [[400, /请求内容有误/], [403, /页面验证已失效.*复制草稿/], [408, /请求接收超时/], [431, /请求头过大.*复制草稿/]]) {
  test(`empty HTTP ${status} response uses a Chinese status error and keeps the draft`, async () => {
    const f = await fixture();
    f.edit('必须保留的草稿\n  缩进  ');
    f.overrideSave({ status, raw: '' });
    await f.click('savePersona');
    assert.equal(f.get('personaText').value, '必须保留的草稿\n  缩进  ');
    assert.match(f.get('personaResult').textContent, expected);
    assert.doesNotMatch(f.get('personaResult').textContent, /JSON|Unexpected|execute|Response/);
    assert.equal(f.requests.filter(({ options }) => options.method === 'POST').length, 1);
    assert.equal(f.requests.filter(({ route, options }) => route === '/api/persona' && options.method !== 'POST').length, 1, 'A known rejected request does not need an uncertain-result check');
  });
}

for (const [name, override] of [
  ['empty success', { raw: '' }],
  ['invalid JSON success', { raw: '<html>PRIVATE SERVER BODY</html>' }],
  ['incomplete JSON success', { raw: '{"available":true}' }],
  ['network interruption', { reject: true }],
  ['response read interruption', { interrupt: true }],
  ['upstream HTML error', { status: 502, raw: '<html>PRIVATE SERVER BODY</html>' }],
  ['server parser uncertain error', { status: 400, raw: JSON.stringify({ error: '请求解析未完成。', code: 'HPE_INVALID_METHOD', uncertain: true }) }],
  ['server parser header error', { status: 431, raw: JSON.stringify({ error: '请求头过大。', code: 'HPE_HEADER_OVERFLOW', uncertain: true }) }],
]) {
  test(`${name} is reconciled by GET without replaying POST when the persona was saved`, async () => {
    const f = await fixture();
    f.edit('这份正文已经保存\n  保留空白  ');
    f.overrideSave({ ...override, apply: true });
    await f.click('savePersona');
    assert.equal(f.requests.filter(({ options }) => options.method === 'POST').length, 1);
    assert.equal(f.requests.filter(({ route, options }) => route === '/api/persona' && options.method !== 'POST').length, 2);
    assert.equal(f.get('personaText').value, '这份正文已经保存\n  保留空白  ');
    assert.equal(f.get('personaStatus').textContent, '已保存');
    assert.equal(f.get('savePersona').disabled, true);
    assert.match(f.get('personaResult').textContent, /已核对.*生效成功/);
    assert.doesNotMatch(f.get('personaResult').textContent, /PRIVATE SERVER BODY|<html>|Unexpected|Failed to fetch/);
    const previousRevision = f.state().revision;
    f.edit('之后又做了修改');
    await f.click('savePersona');
    const posts = f.requests.filter(({ options }) => options.method === 'POST');
    assert.equal(JSON.parse(posts[1].options.body).revision, previousRevision, 'Reconciliation must update the draft base revision');
    assert.equal(f.state().text, '之后又做了修改');
  });
}

test('empty success followed by old server text reports not saved and keeps the complete draft', async () => {
  const f = await fixture();
  f.edit('未保存到服务器\n  完整草稿  ');
  f.overrideSave({ raw: '' });
  await f.click('savePersona');
  assert.equal(f.get('personaText').value, '未保存到服务器\n  完整草稿  ');
  assert.equal(f.get('personaStatus').textContent, '未保存');
  assert.match(f.get('personaResult').textContent, /已核对.*本次人设未保存.*草稿已保留/);
  assert.equal(f.requests.filter(({ options }) => options.method === 'POST').length, 1);
});

test('failed confirmation leaves result uncertain and a later poll can confirm without another POST', async () => {
  const f = await fixture();
  f.edit('响应丢失但保存成功的草稿');
  f.overrideSave({ raw: '', apply: true });
  f.failNextGet();
  await f.click('savePersona');
  assert.equal(f.get('personaText').value, '响应丢失但保存成功的草稿');
  assert.match(f.get('personaResult').textContent, /保存结果尚未确认.*草稿已保留/);
  assert.equal(f.get('personaStatus').textContent, '待核对');
  assert.equal(f.get('personaText').disabled, false);
  assert.equal(f.requests.filter(({ options }) => options.method === 'POST').length, 1);
  await f.poll();
  assert.match(f.get('personaResult').textContent, /已核对.*生效成功/);
  assert.equal(f.get('personaStatus').textContent, '已保存');
  assert.equal(f.requests.filter(({ options }) => options.method === 'POST').length, 1);
});

test('confirmation checks applied revision, rather than claiming matching text is already active', async () => {
  const f = await fixture();
  f.edit('正文相同但没有生效');
  f.overrideSave({ raw: '' });
  f.setState({ text: '正文相同但没有生效', revision: 'disk-r2', appliedRevision: 'r1', needsApply: true });
  await f.click('savePersona');
  assert.equal(f.get('personaText').value, '正文相同但没有生效');
  assert.equal(f.get('personaStatus').textContent, '待生效');
  assert.equal(f.get('savePersona').disabled, false);
  assert.match(f.get('personaResult').textContent, /正文已保存，但尚未确认生效/);
  assert.doesNotMatch(f.get('personaResult').textContent, /生效成功/);
  assert.equal(f.requests.filter(({ options }) => options.method === 'POST').length, 1);
});

test('a delayed confirmation cannot silently enable editing or overwrite the submitted snapshot', async () => {
  const f = await fixture();
  f.edit('正在核对的草稿');
  f.overrideSave({ raw: '', apply: true });
  const finish = f.deferGet();
  const saving = f.click('savePersona');
  await settle();
  assert.equal(f.get('personaStatus').textContent, '正在核对');
  assert.equal(f.get('personaText').disabled, true);
  assert.equal(f.get('savePersona').disabled, true);
  finish(f.state());
  await saving;
  assert.equal(f.get('personaText').value, '正在核对的草稿');
  assert.equal(f.get('personaText').disabled, false);
  assert.equal(f.requests.filter(({ options }) => options.method === 'POST').length, 1);
});
