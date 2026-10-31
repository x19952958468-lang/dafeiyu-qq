import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../src/paths.js';

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => {
    const file = path.join(dir, item.name);
    return item.isDirectory() ? files(file) : file.endsWith('.js') ? [file] : [];
  });
}
const targets = ['src', 'tools', 'scripts'].flatMap(dir => files(path.join(REPO_ROOT, dir)));
for (const file of targets) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax OK: ${targets.length} JavaScript files`);
