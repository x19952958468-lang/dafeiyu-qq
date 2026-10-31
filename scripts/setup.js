import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/paths.js';

for (const [source, target] of [['config.example.json', 'config.json'], ['persona/example.md', 'persona/dafeiyu.md']]) {
  const destination = path.join(REPO_ROOT, target);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.copyFileSync(path.join(REPO_ROOT, source), destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
    console.log(`Created ${target}`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log(`Kept existing ${target}`);
  }
}
console.log('Edit config.json and persona/dafeiyu.md, then run npm start.');
