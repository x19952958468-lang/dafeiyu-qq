import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/memory.js';
import { projectPersonaHistory } from '../src/persona-context.js';

test('old ordinary assistant replies stop being style examples while user and functional facts remain', () => {
  const records = [
    { role: 'user', content: '之前讨论的事', ts: 10 },
    { role: 'assistant', content: '旧人设的诊断口吻', ts: 11 },
    { role: 'assistant', content: '已发出的B站推荐', source: 'bilibili', ts: 12 },
    { role: 'assistant', content: '唱过的歌', source: 'singing', ts: 13 },
    { role: 'assistant', content: '已经确认的事实', factual: true, ts: 14 },
    { role: 'assistant', content: '新人设的回应', ts: 20 },
  ];
  const saved = structuredClone(records);
  const projection = projectPersonaHistory(records, { since: 20 });
  assert.deepEqual(projection.history, [records[0], ...records.slice(2)]);
  assert.deepEqual(projection.archivedAssistant, [records[1]]);
  assert.deepEqual(projection.archivedHistory, [records[1]]);
  assert.deepEqual(records, saved);
  assert.equal(projection.archivedAssistant[0], records[1]);
});

test('unknown timestamps and absent activation retain legacy compatibility', () => {
  const records = [
    { role: 'assistant', content: '缺时间' },
    { role: 'assistant', content: '未知时间', ts: NaN },
    { role: 'assistant', content: '无穷时间', ts: Infinity },
    { role: 'assistant', content: '字符串不假设单位', ts: '10' },
  ];
  assert.deepEqual(projectPersonaHistory(records, { since: 20 }), { history: records, archivedAssistant: [], archivedHistory: [] });
  assert.deepEqual(projectPersonaHistory([{ role: 'assistant', ts: 10 }]), {
    history: [{ role: 'assistant', ts: 10 }], archivedAssistant: [], archivedHistory: [],
  });
  assert.deepEqual(projectPersonaHistory([...records, { role: 'user', content: '未知时间的用户消息' }], { since: 20, isolateUserTurns: true }), {
    history: [...records, { role: 'user', content: '未知时间的用户消息' }], archivedAssistant: [], archivedHistory: [],
  });
});

test('opt-in isolation removes both sides of old dialogue while preserving functional facts and new turns', () => {
  const records = [
    { role: 'user', content: '旧争执里的话题', ts: 10 },
    { role: 'assistant', content: '旧争执里的回怼', ts: 11 },
    { role: 'assistant', content: 'B站推荐原文', source: 'bilibili', ts: 12 },
    { role: 'assistant', content: '已唱完的歌', source: 'singing', ts: 13 },
    { role: 'user', content: '明确保留的功能事实', factual: true, ts: 14 },
    { role: 'user', content: '这一轮的新消息', ts: 20 },
    { role: 'assistant', content: '新口吻回复', ts: 21 },
  ];
  const before = structuredClone(records);
  const p = projectPersonaHistory(records, { since: 20, isolateUserTurns: true });
  assert.deepEqual(p.history, records.slice(2));
  assert.deepEqual(p.archivedHistory, records.slice(0, 2));
  assert.deepEqual(p.archivedAssistant, [records[1]]);
  assert.deepEqual(records, before);
  // Default mode remains assistant-only for existing callers.
  assert.deepEqual(projectPersonaHistory(records, { since: 20 }).history, [records[0], ...records.slice(2)]);
});

test('functional exemptions require exact provenance or factual:true', () => {
  const records = [
    { role: 'assistant', source: 'chat', factual: false, ts: 10 },
    { role: 'assistant', source: 'BILIBILI', factual: 'true', ts: 11 },
    { role: 'assistant', source: 'bilibili', ts: 12 },
  ];
  const p = projectPersonaHistory(records, { since: 20 });
  assert.deepEqual(p.archivedAssistant, records.slice(0, 2));
  assert.deepEqual(p.history, records.slice(2));
});

test('real store retains raw history and notes while context exposes only selected provenance', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { dir, ctx: { maxTurns: 24, maxChars: 5000, maxAgeSec: 600 }, mem: { noteCount: 3, noteMaxChars: 120 } };
  const store = createStore(options), key = 'p:10000', now = Date.now(), since = now - 1000;
  store.append(key, { role: 'user', name: '测试用户', content: '今天的话题' }, now - 4000);
  store.append(key, { role: 'assistant', content: '旧人设回答', delivered: [{ messageId: 3, mode: 'voice' }] }, now - 3000);
  store.append(key, { role: 'assistant', content: 'B站记录', source: 'bilibili', factual: true, messageId: 4, bvid: 'BV1234567890' }, now - 2000);
  store.append(key, { role: 'assistant', content: '新人设回答', source: 'chat' }, now);
  store.addNote(key, '用户喜欢听歌');
  store.flush();
  const before = structuredClone(store.get(key));
  const context = store.context(key);
  assert.deepEqual(context.notes, before.notes);
  assert.equal(context.history[1].ts, now - 3000);
  assert.equal(context.history[1].delivered, undefined);
  assert.deepEqual(context.history[2], { role: 'assistant', name: undefined, content: 'B站记录',
    ts: now - 2000, source: 'bilibili', factual: true, messageId: 4, bvid: 'BV1234567890' });
  const projection = projectPersonaHistory(context.history, { since });
  assert.deepEqual(projection.history.map(x => x.content), ['今天的话题', 'B站记录', '新人设回答']);
  assert.deepEqual(projection.archivedAssistant.map(x => x.content), ['旧人设回答']);
  const isolated = projectPersonaHistory(context.history, { since, isolateUserTurns: true });
  assert.deepEqual(isolated.history.map(x => x.content), ['B站记录', '新人设回答']);
  assert.deepEqual(isolated.archivedHistory.map(x => x.content), ['今天的话题', '旧人设回答']);
  assert.deepEqual(isolated.archivedAssistant.map(x => x.content), ['旧人设回答']);
  assert.deepEqual(store.get(key), before);
  assert.deepEqual(createStore(options).get(key), before);
  assert.deepEqual(createStore(options).context(key).notes, ['用户喜欢听歌']);
});
