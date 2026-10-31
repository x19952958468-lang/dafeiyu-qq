import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORK_DIR = path.resolve(process.env.DAFEIYU_WORK_DIR || path.join(REPO_ROOT, 'work'));
export const FFMPEG = process.env.DAFEIYU_FFMPEG || 'ffmpeg';
export const BILI_PYTHON = process.env.DAFEIYU_BILI_PYTHON || path.join(WORK_DIR,
  'bilibili-video', 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export const SPEECH_LAUNCHER = process.env.DAFEIYU_SPEECH_LAUNCHER || path.join(REPO_ROOT, 'integrations/breeze/serve.sh');
