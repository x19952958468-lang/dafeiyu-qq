import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** Keep open local editor pages valid across a bot restart. Never log this value. */
export async function loadUiCsrfToken(dataDir) {
  const file = path.join(dataDir, 'ui-csrf');
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  try { await fs.writeFile(file, crypto.randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw new Error('Local UI session is unavailable'); }
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64) throw new Error('Invalid local UI session file');
  const token = (await fs.readFile(file, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) throw new Error('Invalid local UI session token');
  await fs.chmod(file, 0o600);
  return token;
}
