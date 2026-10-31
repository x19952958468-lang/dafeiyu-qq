import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadUiCsrfToken } from '../src/bilibili/ui-session.js';

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-session-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test('the same private token survives restarts and concurrent loading', async t => {
  const dir = await directory(t), data = path.join(dir, 'data');
  const first = await loadUiCsrfToken(data);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await fs.stat(path.join(data, 'ui-csrf'))).mode & 0o777, 0o600);
  assert.deepEqual(await Promise.all([loadUiCsrfToken(data), loadUiCsrfToken(data)]), [first, first]);
});
test('an existing live token is retained but invalid files are rejected without printing contents', async t => {
  const dir = await directory(t), file = path.join(dir, 'ui-csrf');
  await fs.writeFile(file, 'A'.repeat(43), { mode: 0o644 });
  assert.equal(await loadUiCsrfToken(dir), 'A'.repeat(43));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.writeFile(file, 'PRIVATE_INVALID_TOKEN');
  await assert.rejects(loadUiCsrfToken(dir), error => /Invalid/.test(error.message) && !error.message.includes('PRIVATE'));
});
