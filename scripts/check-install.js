import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { REPO_ROOT } from '../src/paths.js';

async function unusedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('clean checkout setup preserves local files and dashboard boots without optional models', { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dafeiyu-install-'));
  let child, exited;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const name of ['src', 'scripts', 'config.example.json', 'package.json'])
    await fs.cp(path.join(REPO_ROOT, name), path.join(root, name), { recursive: true });
  await fs.mkdir(path.join(root, 'persona'));
  await fs.copyFile(path.join(REPO_ROOT, 'persona/example.md'), path.join(root, 'persona/example.md'));
  const setup = () => spawnSync(process.execPath, ['scripts/setup.js'], { cwd: root, encoding: 'utf8' });
  assert.equal(setup().status, 0);
  const original = await fs.readFile(path.join(root, 'config.json'), 'utf8');
  const config = JSON.parse(original);
  assert.equal(config.onebot.autoAcceptInvite, false);
  assert.equal(config.singing.enabled, false);
  assert.equal(config.trigger.alwaysReplyMention, false);
  assert.equal(config.trigger.alwaysReplyPrivate, false);
  assert.equal(config.trigger.interjectRate, 0);
  assert.ok(config.whitelist.groups.length > 0 && config.whitelist.friends.length > 0);
  const localPersona = 'A local persona edit that must survive setup.\n';
  await fs.writeFile(path.join(root, 'persona/dafeiyu.md'), localPersona);
  assert.equal(setup().status, 0);
  assert.equal(await fs.readFile(path.join(root, 'persona/dafeiyu.md'), 'utf8'), localPersona);
  assert.equal(await fs.readFile(path.join(root, 'config.json'), 'utf8'), original);
  const port = await unusedPort();
  config.onebot.ws = `ws://127.0.0.1:${await unusedPort()}`;
  config.bilibili = { ...config.bilibili, uiPort: port };
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  child = spawn(process.execPath, ['src/index.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  exited = new Promise(resolve => child.once('exit', resolve));
  let response;
  for (let attempt = 0; attempt < 40; attempt++) {
    assert.equal(child.exitCode, null, logs);
    try { response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(300) }); }
    catch { await sleep(100); continue; }
    if (response.ok) break;
    await response.body?.cancel();
    await sleep(100);
  }
  assert.equal(response?.status, 200, logs);
  assert.match(await response.text(), /<!DOCTYPE html>/i);
  const speechResponse = await fetch(`http://127.0.0.1:${port}/api/speech`);
  assert.equal(speechResponse.status, 200);
  const speechState = await speechResponse.json();
  assert.equal(speechState.config.enabled, false);
});
