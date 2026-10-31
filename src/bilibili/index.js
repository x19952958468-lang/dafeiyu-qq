import fs from 'node:fs/promises';
import path from 'node:path';
import { createBilibiliClient } from './client.js';
import { createContentAnalyzer } from './content.js';
import { createBilibiliCompanion } from './service.js';
import { createLoginServer } from './server.js';
import { loadUiCsrfToken } from './ui-session.js';

export async function startBilibili({ rootDir, cfg, llm, limits, transport, store, log, speech, deliverReply, acquireHeavy, personaEditor }) {
  const dataDir = path.join(rootDir, 'data/bilibili');
  const client = createBilibiliClient({ credentialFile: path.join(dataDir, 'credentials.json') });
  const analyzer = createContentAnalyzer({ rootDir, client, log, acquireHeavy, config: cfg.bilibili?.content });
  const singingBusy = async () => {
    const dir = path.resolve(rootDir, cfg.singing?.dataDir || 'data/singing', 'jobs');
    try {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        if (!item.isDirectory()) continue;
        const names = await fs.readdir(path.join(dir, item.name));
        if (names.includes('request.json') && !names.includes('status.json') && !names.includes('finished')) return true;
      }
    } catch { /* the singing queue may not exist yet */ }
    return false;
  };
  const companion = createBilibiliCompanion({ rootDir, cfg, llm, limits, transport, client, analyzer, singingBusy, store, log, deliverReply });
  const ui = createLoginServer({ companion, log, speech, personaEditor, port: cfg.bilibili?.uiPort ?? 6196, python: cfg.bilibili?.qrPython, csrfToken: await loadUiCsrfToken(dataDir) });
  await ui.start();
  companion.start();
  return { handleEvent: companion.handleEvent, status: companion.status, getConversationContext: companion.getConversationContext,
    executeAction: companion.executeAction, getConfig: companion.getConfig,
    stop: async () => { await companion.stop(); await ui.stop(); } };
}
