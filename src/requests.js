/**
 * 处理 QQ 的「请求」事件（入群邀请 / 加好友申请）。
 *
 * 为什么需要它：NapCat 没有任何「主动加群」接口，机器人号没法自己申请入群。
 * 可行的自动化路径只有一条 —— 别人把机器人号邀进群，机器人收到 invite 请求后自动同意。
 */

export function createRequestHandler({ transport, cfg, log = console.log }) {
  const autoAcceptInvite = cfg.onebot?.autoAcceptInvite === true;

  return async function handleRequest(evt) {
    if (evt.post_type !== 'request') return false;

    if (evt.request_type === 'group') {
      const sub = evt.sub_type;
      const groupId = String(evt.group_id ?? '');
      const from = String(evt.user_id ?? '');
      const comment = evt.comment || '（无）';

      if (sub === 'invite') {
        log(`[request] 收到入群邀请：群 ${groupId}，邀请人 ${from}`);
        if (!autoAcceptInvite) {
          log('[request] 已配置为不自动同意，跳过');
          return true;
        }
        const r = await transport.call('set_group_add_request', {
          flag: evt.flag,
          sub_type: 'invite',
          approve: true,
        });
        log(r.ok ? `[request] ✓ 已同意加入群 ${groupId}` : `[request] ✗ 同意失败：${r.error}`);
        return true;
      }

      // sub === 'add'：有人要加进机器人当管理员的群，交给人处理，不擅自批
      log(`[request] 加群申请：群 ${groupId}，申请人 ${from}，验证消息「${comment}」—— 未自动处理`);
      return true;
    }

    if (evt.request_type === 'friend') {
      log(`[request] 好友申请：${evt.user_id}，验证消息「${evt.comment || '（无）'}」—— 未自动处理`);
      return true;
    }

    return true;
  };
}
