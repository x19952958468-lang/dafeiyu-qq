import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQqActions } from '../src/qq-actions.js';

// All protocol methods are local fakes. This suite cannot send real QQ messages.
const OWNER = '20000', SELF = '10000', GROUP = '40000', OTHER_GROUP = '50000', MEMBER = '30000';
const event = (text, changes = {}) => ({ post_type: 'message', message_type: 'private', user_id: OWNER,
  self_id: SELF, message_id: '123', message: [{ type: 'text', data: { text } }], ...changes });
const command = '去测试群 @小明 发“请先看群公告。”';
const action = () => ({ type: 'qq_send', groupName: '测试群', mentionName: '小明', text: '请先看群公告。', requestText: command });

function harness(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-actions-'));
  const cfg = { trigger: { ignoreUserIds: [] }, whitelist: { friends: [OWNER], groups: [GROUP, OTHER_GROUP] }, mutedGroups: [] };
  let owner = OWNER;
  const calls = { lookup: [], send: [], history: [], logs: [] };
  const groups = options.groups || [{ group_id: GROUP, group_name: '测试群' }, { group_id: OTHER_GROUP, group_name: '另一个群' }];
  const members = options.members || [{ user_id: MEMBER, nickname: '小明', card: '' }, { user_id: '60000', nickname: '小红', card: '目标群友' }];
  const transport = {
    async call(method, params) {
      calls.lookup.push({ method, params });
      if (options.waitLookup) await options.waitLookup;
      if (options.lookupFailure) return { ok: false };
      return { ok: true, data: method === 'get_group_list' ? groups : members };
    },
    async sendGroup(groupId, segments) {
      calls.send.push({ groupId, segments });
      if (options.waitSend) await options.waitSend;
      if (options.sendThrow) throw new Error('private-key=DO_NOT_PRINT');
      return options.response || { ok: true, data: { message_id: '999' } };
    },
  };
  const make = () => createQqActions({ cfg, transport, store: { append(key, entry) { calls.history.push({ key, ...entry }); } },
    getOwner: () => owner, getRecentTargets: options.getRecentTargets || (() => options.recentTargets || []),
    log: line => calls.logs.push(line), dataDir });
  const service = make();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, cfg, calls, service, make, setOwner(value) { owner = value; } };
}

test('exact owner request resolves group and member, sends only at/text, and records both conversations', async t => {
  const h = harness(t);
  const result = await h.service.execute(event(command), action());
  assert.equal(result.state, 'completed'); assert.match(result.summary, /请先看群公告/);
  assert.deepEqual(h.calls.send, [{ groupId: GROUP, segments: [
    { type: 'at', data: { qq: MEMBER } }, { type: 'text', data: { text: '请先看群公告。' } },
  ] }]);
  assert.deepEqual(h.calls.history.map(entry => entry.key), [`g:${GROUP}`, `p:${OWNER}`]);
  assert.ok(h.calls.history.every(entry => entry.factual && entry.actionState === 'completed'));
  const ledgerFile = path.join(h.dataDir, 'sent.json');
  assert.equal(fs.statSync(ledgerFile).mode & 0o777, 0o600);
  const persisted = fs.readFileSync(ledgerFile, 'utf8');
  assert.doesNotMatch(persisted, /请先看群公告|测试群|小明/);
  assert.equal(Object.values(JSON.parse(persisted).records)[0].state, 'completed');
});

test('single clear group ID works without mentioning a member', async t => {
  const h = harness(t); const text = `向群 ${GROUP} 发“大家晚上好。”`;
  assert.equal((await h.service.execute(event(text), { type: 'qq_send', groupId: GROUP, text: '大家晚上好。' })).state, 'completed');
  assert.equal(h.calls.lookup.length, 1);
  assert.deepEqual(h.calls.send[0].segments, [{ type: 'text', data: { text: '大家晚上好。' } }]);
});

test('owner-only and current friend policy reject before protocol reads or writes', async t => {
  for (const variant of ['foreign', 'group', 'self', 'missingSelf', 'ignored', 'friend', 'ownerChanged', 'missingId']) {
    const h = harness(t); const evt = event(command);
    if (variant === 'foreign') evt.user_id = MEMBER;
    if (variant === 'group') evt.message_type = 'group';
    if (variant === 'self') evt.self_id = OWNER;
    if (variant === 'missingSelf') delete evt.self_id;
    if (variant === 'ignored') h.cfg.trigger.ignoreUserIds = [OWNER];
    if (variant === 'friend') h.cfg.whitelist.friends = [MEMBER];
    if (variant === 'ownerChanged') h.setOwner(MEMBER);
    if (variant === 'missingId') delete evt.message_id;
    assert.equal((await h.service.execute(evt, action())).state, 'failed', variant);
    assert.equal(h.calls.lookup.length + h.calls.send.length, 0);
  }
});

test('ambiguous wording, missing exact body, and fabricated source or targets never send', async t => {
  const cases = [
    ['去群体骂他一句，说她骚扰女性', { type: 'qq_send' }],
    ['去群体骂他一句，说她骚扰女性', { type: 'qq_send', groupName: '群体', text: '她骚扰女性' }],
    [command, { ...action(), text: '这是模型编造的正文。' }],
    [command, { ...action(), requestText: '伪造的原始指令' }],
    [command, { ...action(), groupName: '另一个群' }],
    [command, { ...action(), mentionName: '小红' }],
    ['去测试群，叫他看公告。', { type: 'qq_send', groupName: '测试群', mentionName: '他', text: '看公告。' }],
    ['说“你好。”', { type: 'qq_send', text: '你好。' }],
  ];
  for (const [text, request] of cases) {
    const h = harness(t); const result = await h.service.execute(event(text), request);
    assert.ok(['failed', 'clarification'].includes(result.state)); assert.equal(h.calls.send.length, 0);
  }
});

test('only trusted third-argument prior request may supply a missing body or target', async t => {
  const h = harness(t); const earlier = '去测试群发“请先看群公告。”';
  const followup = '@小明';
  const merged = { ...action(), requestText: followup };
  assert.equal((await h.service.execute(event(followup), { ...merged, priorRequestText: earlier })).state, 'clarification');
  assert.equal(h.calls.send.length, 0);
  const result = await h.service.execute(event(followup), merged, { priorRequestText: earlier });
  assert.equal(result.state, 'completed'); assert.equal(h.calls.send.length, 1);
});

test('group names must match uniquely and only existing unmuted allowed groups may receive messages', async t => {
  const variants = [
    { groups: [{ group_id: GROUP, group_name: '测试群' }, { group_id: OTHER_GROUP, group_name: '测试群' }] },
    { groups: [{ group_id: GROUP, group_name: '测试群改名了' }] },
    { mutate: cfg => { cfg.whitelist.groups = []; } },
    { mutate: cfg => { cfg.whitelist.groups = [OTHER_GROUP]; } },
    { mutate: cfg => { cfg.mutedGroups = [GROUP]; } },
  ];
  for (const options of variants) {
    const h = harness(t, options); options.mutate?.(h.cfg);
    assert.notEqual((await h.service.execute(event(command), action())).state, 'completed');
    assert.equal(h.calls.send.length, 0);
  }
});

test('member IDs and names must resolve exactly once, never choose ambiguous, absent, ignored, or all members', async t => {
  const variants = [
    { members: [{ user_id: MEMBER, nickname: '小明' }, { user_id: '60000', card: '小明' }] },
    { members: [{ user_id: MEMBER, nickname: '大明' }] },
    { mutate: cfg => { cfg.trigger.ignoreUserIds = [MEMBER]; } },
  ];
  for (const options of variants) {
    const h = harness(t, options); options.mutate?.(h.cfg);
    assert.notEqual((await h.service.execute(event(command), action())).state, 'completed'); assert.equal(h.calls.send.length, 0);
  }
  for (const mentionQq of ['all', '全体成员']) {
    const h = harness(t); const request = `去测试群 @${mentionQq} 发“你好。”`;
    assert.equal((await h.service.execute(event(request), { type: 'qq_send', groupName: '测试群', mentionQq, text: '你好。' })).state, 'clarification');
    assert.equal(h.calls.send.length, 0);
  }
});

test('member number is verified against the actual target group and cannot come from the model alone', async t => {
  const h = harness(t); const request = `去测试群 @${MEMBER} 发“请先看群公告。”`;
  assert.equal((await h.service.execute(event(request), { type: 'qq_send', groupName: '测试群', mentionQq: MEMBER, text: '请先看群公告。' })).state, 'completed');
  assert.equal(h.calls.send[0].segments[0].data.qq, MEMBER);
  const other = harness(t);
  assert.equal((await other.service.execute(event(command), { ...action(), mentionName: undefined, mentionQq: MEMBER })).state, 'clarification');
  assert.equal(other.calls.send.length, 0);
});

test('CQ injection and mass mentions are rejected even when copied literally from the request', async t => {
  for (const text of ['[CQ:at,qq=all]', '通知 @所有人', '通知 @全体成员', '通知 @all']) {
    const h = harness(t); const request = `去测试群发“${text}”`;
    assert.equal((await h.service.execute(event(request), { type: 'qq_send', groupName: '测试群', text })).state, 'failed');
    assert.equal(h.calls.send.length, 0);
  }
});

test('identical message IDs are idempotent concurrently and across restart', async t => {
  let release; const waitSend = new Promise(resolve => { release = resolve; });
  const h = harness(t, { waitSend });
  const first = h.service.execute(event(command), action());
  const second = h.service.execute(event(command), action());
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.calls.send.length, 1);
  release(); assert.equal((await first).state, 'completed'); assert.equal((await second).duplicate, true);
  assert.equal((await h.make().execute(event(command), action())).duplicate, true);
  assert.equal(h.calls.send.length, 1); assert.equal(h.calls.history.length, 2);
});

test('timeout stays unknown across restart, never retries, and records no fabricated group utterance', async t => {
  const h = harness(t, { sendThrow: true });
  const result = await h.service.execute(event(command), action());
  assert.equal(result.state, 'unknown'); assert.doesNotMatch(result.summary, /DO_NOT_PRINT/);
  assert.equal((await h.make().execute(event(command), action())).state, 'unknown');
  assert.equal(h.calls.send.length, 1);
  assert.deepEqual(h.calls.history.map(entry => entry.key), [`p:${OWNER}`]);
  assert.equal(h.calls.history[0].actionState, 'unknown');
});

test('definite send failure is distinguished from an unconfirmed transport result', async t => {
  for (const response of [{ ok: false, unknown: false }, { ok: false, error: '尚未连接到协议端' }, { ok: false, error: '该群已暂停发言' }]) {
    const h = harness(t, { response });
    assert.equal((await h.service.execute(event(command), action())).state, 'failed');
    assert.equal((await h.make().execute(event(command), action())).state, 'failed');
    assert.equal(h.calls.send.length, 1); assert.equal(h.calls.history.length, 1);
  }
});

test('unreadable lookup and corrupt persisted ledger fail without sending', async t => {
  const h = harness(t, { lookupFailure: true });
  assert.equal((await h.service.execute(event(command), action())).state, 'failed'); assert.equal(h.calls.send.length, 0);
  fs.writeFileSync(path.join(h.dataDir, 'sent.json'), '{broken');
  assert.equal((await h.make().execute(event(command), action())).state, 'failed'); assert.equal(h.calls.send.length, 0);
});

test('policy is checked again after asynchronous target resolution', async t => {
  let release; const waitLookup = new Promise(resolve => { release = resolve; });
  const h = harness(t, { waitLookup }); const pending = h.service.execute(event(command), action());
  h.cfg.mutedGroups = [GROUP]; release();
  assert.equal((await pending).state, 'failed'); assert.equal(h.calls.send.length, 0);
});

const recentTarget = (groupId = GROUP, extra = {}) => ({ groupId, lastSpokeAt: Date.now() - 1000, ...extra });

test('one recent successful group is reused for omitted or referential group targets without asking', async t => {
  for (const groupName of [undefined, '群里', '那个群']) {
    const h = harness(t, { recentTargets: [recentTarget()] });
    const text = `去${groupName || '群里'}发“大家晚上好。”`;
    const result = await h.service.execute(event(text), { type: 'qq_send', groupName, text: '大家晚上好。' });
    assert.equal(result.state, 'completed'); assert.equal(h.calls.send[0].groupId, GROUP);
    assert.equal(h.calls.send[0].segments.length, 1, 'A group reference does not invent a member mention');
  }
});

test('zero, two, expired, future or unavailable recent targets cannot choose a group', async t => {
  const cases = [[], [recentTarget(), recentTarget(OTHER_GROUP)],
    [recentTarget(GROUP, { lastSpokeAt: Date.now() - 11 * 60000 })],
    [recentTarget(GROUP, { lastSpokeAt: Date.now() + 60000 })]];
  for (const recentTargets of cases) {
    const h = harness(t, { recentTargets });
    const result = await h.service.execute(event('去群里发“你好。”'), { type: 'qq_send', groupName: '群里', text: '你好。' });
    assert.equal(result.state, 'clarification'); assert.equal(h.calls.send.length, 0);
  }
  const h = harness(t, { getRecentTargets: () => { throw new Error('unavailable'); } });
  assert.equal((await h.service.execute(event('去群里发“你好。”'), { type: 'qq_send', text: '你好。' })).state, 'clarification');
  assert.equal(h.calls.send.length, 0);
});

test('explicit literal group takes priority, but another-group requests never reuse the recent one', async t => {
  const h = harness(t, { recentTargets: [recentTarget()] });
  const result = await h.service.execute(event(`到群 ${OTHER_GROUP} 发“你好。”`), { type: 'qq_send', groupId: OTHER_GROUP, text: '你好。' });
  assert.equal(result.state, 'completed'); assert.equal(h.calls.send[0].groupId, OTHER_GROUP);
  for (const phrase of ['别的群', '另一个群', '其他群', '换一个群']) {
    for (const groupId of [undefined, GROUP]) {
      const other = harness(t, { recentTargets: [recentTarget()] });
      const outcome = await other.service.execute(event(`去${phrase}发“你好。”`), { type: 'qq_send', groupId, text: '你好。' });
      assert.equal(outcome.state, 'clarification'); assert.equal(other.calls.send.length, 0);
    }
  }
});

test('matching trusted context IDs are valid sources; arbitrary IDs or choosing between two recent groups are not', async t => {
  const text = '去群里对他说“请先看群公告。”';
  const h = harness(t, { recentTargets: [recentTarget(GROUP, { memberQq: MEMBER, memberName: '小明' })] });
  const result = await h.service.execute(event(text), { type: 'qq_send', groupId: GROUP, mentionQq: MEMBER, text: '请先看群公告。' });
  assert.equal(result.state, 'completed'); assert.equal(h.calls.send[0].segments[0].data.qq, MEMBER);
  const cases = [
    { targets: [recentTarget()], request: { groupId: OTHER_GROUP } },
    { targets: [recentTarget(), recentTarget(OTHER_GROUP)], request: { groupId: GROUP } },
    { targets: [recentTarget(GROUP, { memberQq: MEMBER })], request: { groupId: GROUP, mentionQq: '60000' } },
  ];
  for (const item of cases) {
    const other = harness(t, { recentTargets: item.targets });
    assert.equal((await other.service.execute(event(text), { type: 'qq_send', ...item.request, text: '请先看群公告。' })).state, 'clarification');
    assert.equal(other.calls.send.length, 0);
  }
});

test('real planner IDs plus a trusted companion member name are accepted without another clarification', async t => {
  const requestText = '去群里告诉他早点休息';
  for (const groupName of [undefined, '']) {
    const h = harness(t, { recentTargets: [recentTarget(GROUP, { memberQq: MEMBER, memberName: '小明' })] });
    const result = await h.service.execute(event(requestText), { type: 'qq_send', text: '早点休息',
      groupId: GROUP, groupName, mentionQq: MEMBER, mentionName: '小明', requestText });
    assert.equal(result.state, 'completed');
    assert.deepEqual(h.calls.send, [{ groupId: GROUP, segments: [
      { type: 'at', data: { qq: MEMBER } }, { type: 'text', data: { text: '早点休息' } },
    ] }]);
    assert.deepEqual(h.calls.lookup.at(-1), { method: 'get_group_member_list', params: { group_id: GROUP } });
  }
  const wrongName = harness(t, { recentTargets: [recentTarget(GROUP, { memberQq: MEMBER, memberName: '小明' })] });
  assert.equal((await wrongName.service.execute(event(requestText), { type: 'qq_send', text: '早点休息',
    groupId: GROUP, mentionQq: MEMBER, mentionName: '小红' })).state, 'clarification');
  assert.equal(wrongName.calls.send.length, 0);
  const leftGroup = harness(t, { recentTargets: [recentTarget(GROUP, { memberQq: MEMBER, memberName: '小明' })],
    members: [{ user_id: '60000', nickname: '小明' }] });
  assert.equal((await leftGroup.service.execute(event(requestText), { type: 'qq_send', text: '早点休息',
    groupId: GROUP, mentionQq: MEMBER, mentionName: '小明' })).state, 'clarification');
  assert.equal(leftGroup.calls.send.length, 0, 'A same-name member cannot replace the actual recent recipient');
});

test('singular recipient references reuse only the selected group unique recent reply target and verify actual membership', async t => {
  for (const mentionName of ['他', '她', '对方']) {
    const h = harness(t, { recentTargets: [recentTarget(GROUP, { memberQq: MEMBER, memberName: '小明' })] });
    const result = await h.service.execute(event(`去群里对${mentionName}说“请先看群公告。”`),
      { type: 'qq_send', groupName: '群里', mentionName, text: '请先看群公告。' });
    assert.equal(result.state, 'completed'); assert.equal(h.calls.send[0].segments[0].data.qq, MEMBER);
    assert.deepEqual(h.calls.lookup.at(-1), { method: 'get_group_member_list', params: { group_id: GROUP } });
  }
  const missing = harness(t, { recentTargets: [recentTarget(GROUP, { memberQq: MEMBER })], members: [{ user_id: '60000', nickname: '小红' }] });
  assert.equal((await missing.service.execute(event('去群里对他说“你好。”'), { type: 'qq_send', mentionName: '他', text: '你好。' })).state, 'clarification');
  assert.equal(missing.calls.send.length, 0);
});

test('ambiguous or absent recent reply members never get inferred or borrowed from another group', async t => {
  const cases = [[recentTarget()],
    [recentTarget(GROUP, { memberQq: MEMBER }), recentTarget(GROUP, { memberQq: '60000' })],
    [recentTarget(), recentTarget(OTHER_GROUP, { memberQq: MEMBER })]];
  for (const recentTargets of cases) {
    const h = harness(t, { recentTargets });
    const result = await h.service.execute(event('去测试群对他说“你好。”'), { type: 'qq_send', groupName: '测试群', mentionName: '他', text: '你好。' });
    assert.equal(result.state, 'clarification'); assert.equal(h.calls.send.length, 0);
  }
});

test('literal member overrides recent recipient; inferred groups still obey muted and allowlist policies', async t => {
  const h = harness(t, { recentTargets: [recentTarget(GROUP, { memberQq: MEMBER })] });
  assert.equal((await h.service.execute(event('去群里 @小红 说“你好。”'), { type: 'qq_send', mentionName: '小红', text: '你好。' })).state, 'completed');
  assert.equal(h.calls.send[0].segments[0].data.qq, '60000');
  for (const mutate of [cfg => { cfg.mutedGroups = [GROUP]; }, cfg => { cfg.whitelist.groups = [OTHER_GROUP]; }]) {
    const other = harness(t, { recentTargets: [recentTarget()] }); mutate(other.cfg);
    assert.equal((await other.service.execute(event('去群里说“你好。”'), { type: 'qq_send', text: '你好。' })).state, 'failed');
    assert.equal(other.calls.send.length, 0);
  }
});
