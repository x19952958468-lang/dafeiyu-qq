import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBilibiliConversation } from '../src/bilibili/conversation.js';
import { createBilibiliCompanion } from '../src/bilibili/service.js';

const OWNER = '70105', OTHER = '70102';
const BVID = 'BV17VUrBvE8L', SECOND = 'BV1hXbN6VEKV', THIRD = 'BV1eFs96uE3K';
const START = Date.parse('2026-10-30T04:00:00Z');
function event(text, extra = {}) { return { post_type: 'message', message_type: 'private', user_id: OWNER, message: text, ...extra }; }
function fixture() {
  let owner = OWNER, clock = START, allowed = true;
  const original = '这一段节奏的处理很细腻，停顿之后再进入主旋律很有层次。';
  const state = { shares: { [`${OWNER}:${BVID}`]: { time: START - 1000, status: 'sent', messageId: 70120 } },
    watched: { [BVID]: { time: START - 2000, title: '乐器演奏', summary: '抽样画面呈现演奏，旋律有明显停顿。', evidenceLevel: 'video' } },
    comments: { [BVID]: { time: START - 1500, status: 'sent', text: original, rpid: '123' } }, recent: [] };
  const reader = createBilibiliConversation({ getState: () => state, getOwner: () => owner,
    ownerAllowed: () => allowed, now: () => clock });
  return { state, original, read: reader.getConversationContext, setOwner: x => { owner = x; },
    ignore: () => { allowed = false; }, advance: ms => { clock += ms; } };
}

test('real legacy ledger answers 你都评论了什么 with exact successful original', () => {
  const h = fixture();
  const result = h.read(event('你都评论了什么'));
  assert.equal(result.factual, true);
  assert.ok(result.directReply.includes(h.original));
  assert.match(result.directReply, /评论已发送成功/);
  assert.match(result.system, /乐器演奏/);
  assert.match(result.system, /"recommendation":""/);
});

test('plural comments aggregate while message quote and explicit BV select one', () => {
  const h = fixture();
  h.state.shares[`${OWNER}:${SECOND}`] = { time: START - 500, status: 'sent', messageId: 22 };
  h.state.watched[SECOND] = { title: '第二条视频', summary: '另一个摘要' };
  h.state.comments[SECOND] = { status: 'sent', text: '这是第二条视频实际发出的评论。', rpid: '124' };
  const all = h.read(event('最近的评论'));
  assert.ok(all.directReply.includes(h.original));
  assert.match(all.directReply, /这是第二条视频实际发出的评论/);
  const quote = h.read(event([{ type: 'reply', data: { id: 70120 } }, { type: 'text', data: { text: '你都评论了什么' } }]));
  assert.ok(quote.directReply.includes(h.original));
  assert.doesNotMatch(quote.directReply, /第二条视频/);
  const explicit = h.read(event(`${SECOND} 发了什么评论`));
  assert.match(explicit.directReply, /第二条视频实际发出的评论/);
  assert.ok(!explicit.directReply.includes(h.original));
});

test('reply target persists for consecutive followups without taking unrelated chat', () => {
  const h = fixture();
  h.state.shares[`${OWNER}:${SECOND}`] = { time: START - 500, status: 'sent', messageId: 22 };
  h.state.watched[SECOND] = { title: '第二条视频' };
  h.read(event(`[CQ:reply,id=70120]这个视频讲了什么`));
  assert.ok(h.read(event('你说了啥')).directReply.includes(h.original));
  assert.equal(h.read(event('今天吃什么')), null);
  assert.equal(h.read(event('你说了啥')), null);
  assert.equal(h.read(event('你觉得我写了什么作业')), null);
  assert.match(h.read(event('评论成功了吗')).directReply, /第二条视频.*未评论/);
  assert.equal(h.read(event('[CQ:reply,id=999999]你说了啥')), null);
});

test('failed, unknown, missing, and draft comments never claim publication', () => {
  for (const status of ['failed', 'unknown', 'draft', null]) {
    const h = fixture();
    if (status) h.state.comments[BVID].status = status; else delete h.state.comments[BVID];
    const result = h.read(event('评论成功了吗'));
    assert.doesNotMatch(result.directReply, /已发送成功/);
    assert.match(result.directReply, status === 'failed' ? /发送失败/ : status === 'unknown' ? /结果未知/ : /未评论/);
    if (status === 'failed' || status === 'unknown') assert.ok(result.directReply.includes(h.original));
    else assert.ok(!result.directReply.includes(h.original));
  }
});

test('comment explanations retain evidence instead of repeating the comment', () => {
  const h = fixture();
  for (const question of ['你为什么这样评论', '这条评论是什么意思', '你对这个视频有什么看法']) {
    const result = h.read(event(question));
    assert.equal(result.factual, true);
    assert.equal(result.directReply, undefined);
    assert.ok(result.system.includes(h.original));
  }
});

test('vague recall does not select an old video after the conversation expires', () => {
  const h = fixture(); h.advance(31 * 60000);
  assert.equal(h.read(event('你说了啥')), null);
  assert.ok(h.read(event('你都评论了什么')).directReply.includes(h.original));
});

test('group, other private chat, ignored owner and changed owner cannot read old activity', () => {
  const h = fixture();
  assert.equal(h.read(event('你都评论了什么', { message_type: 'group' })), null);
  assert.equal(h.read(event('你都评论了什么', { user_id: OTHER })), null);
  h.read(event(`${BVID} 为什么推荐`));
  h.setOwner(OTHER);
  const changed = h.read(event(`${BVID} 评论了什么`, { user_id: OTHER }));
  assert.ok(!JSON.stringify(changed).includes(h.original));
  assert.doesNotMatch(JSON.stringify(changed), /乐器演奏/);
  h.state.shares[`${OTHER}:${BVID}`] = { ownerQq: OTHER, time: START, status: 'sent', title: '新主人自己的推荐' };
  assert.ok(!JSON.stringify(h.read(event(`${BVID} 评论了什么`, { user_id: OTHER }))).includes(h.original));
  h.ignore();
  assert.equal(h.read(event('你都评论了什么', { user_id: OTHER })), null);
});

test('unconfirmed share does not replace latest confirmed recommendation', () => {
  const h = fixture();
  h.state.shares[`${OWNER}:${SECOND}`] = { time: START, status: 'unknown', messageId: 22 };
  h.state.watched[SECOND] = { title: '尚未确认送达的视频' };
  const result = h.read(event('评论了什么'));
  assert.ok(result.directReply.includes(h.original));
  assert.doesNotMatch(result.system, /尚未确认送达/);
});

test('old audit records restore title, summary and sent comment but never invent recommendation', () => {
  const h = fixture(); h.state.watched = {}; h.state.comments = {};
  h.state.recent = [
    { action: 'watch', bvid: BVID, status: 'done', title: '旧标题', summary: '旧摘要' },
    { action: 'comment', bvid: BVID, status: 'sent', message: h.original },
    { action: 'share', bvid: BVID, status: 'sent', message: '已发给绑定的 QQ 好友' },
  ];
  assert.ok(h.read(event('评论了什么')).directReply.includes(h.original));
  const context = h.read(event('为什么推荐这个视频'));
  assert.equal(context.directReply, undefined);
  assert.match(context.system, /旧摘要/);
  assert.match(context.system, /"recommendation":""/);
});

test('aggregate is bounded and preserves every included comment verbatim', () => {
  const h = fixture();
  for (let i = 0; i < 8; i++) {
    const bvid = `BV${String(i).padStart(10, '0')}`;
    h.state.shares[`${OWNER}:${bvid}`] = { status: 'sent', time: START + i };
    h.state.comments[bvid] = { status: 'sent', text: String(i).repeat(140) };
  }
  const result = h.read(event('你都评论了什么'));
  assert.ok(result.directReply.length < 1850);
  for (let i = 3; i < 8; i++) assert.ok(result.directReply.includes(String(i).repeat(140)));
  assert.ok(!result.directReply.includes('2'.repeat(140)));
});

test('confirmed outbound share enters private history with original message and ID', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-conversation-'));
  fs.writeFileSync(path.join(root, 'persona.md'), '简洁回答。');
  const history = [], calls = { posts: 0, sends: 0 };
  let sentText;
  const service = createBilibiliCompanion({ rootDir: root,
    cfg: { persona: { file: 'persona.md' }, trigger: { ignoreUserIds: [] }, whitelist: { friends: [] } },
    now: () => START, store: { append: (key, turn) => history.push({ key, ...turn }) },
    setTimer: () => 1, clearTimer: () => {},
    client: { status: async () => ({ loggedIn: true, uid: '42' }),
      video: async () => ({ bvid: BVID, title: '测试视频', url: `https://www.bilibili.com/video/${BVID}` }),
      postComment: async () => { calls.posts++; return { ok: true, rpid: '123' }; } },
    analyzer: { analyze: async () => ({ evidenceLevel: 'video', evidenceText: '实际抽样内容' }) },
    limits: { gate: () => ({ ok: true }), spend: () => {}, noteReply: () => {} },
    llm: { chat: async () => ({ text: JSON.stringify({ score: 9, summary: '实际内容摘要', wantComment: true,
      comment: '这是实际发送的评论原文。', wantShare: true, recommendation: '我觉得这段内容值得看看。', tags: [] }) }) },
    transport: { call: async () => ({ ok: true, data: [{ user_id: OWNER }] }),
      sendPrivate: async (id, message) => { assert.equal(id, OWNER); calls.sends++; sentText = message[0].data.text;
        return { ok: true, data: { message_id: 70120 } }; } },
  });
  t.after(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await service.configure({ ownerQq: OWNER, enabled: true });
  await service.runNow({ dryRun: false, bvid: BVID }); await service.whenIdle();
  assert.deepEqual(history, [{ key: `p:${OWNER}`, role: 'assistant', content: sentText,
    source: 'bilibili', bvid: BVID, messageId: 70120 }]);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'data/bilibili/state.json'), 'utf8'));
  assert.equal(state.shares[`${OWNER}:${BVID}`].text, sentText);
  assert.equal(state.shares[`${OWNER}:${BVID}`].summary, '实际内容摘要');
  assert.equal(state.shares[`${OWNER}:${BVID}`].recommendation, '我觉得这段内容值得看看。');
  const before = { ...calls };
  assert.match(service.getConversationContext(event('你都评论了什么')).directReply, /这是实际发送的评论原文/);
  assert.deepEqual(calls, before, 'conversation lookup cannot invoke platform writes');
});
