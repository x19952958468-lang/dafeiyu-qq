/**
 * OneBot 11 传输层（正向 WebSocket 客户端）。
 * 只依赖 Node 22 内置 WebSocket，不引任何第三方库。
 *
 * 兼容 NapCat / Lagrange.OneBot / LLOneBot 等任何实现了 OneBot 11 正向 WS 的协议端。
 */

const CALL_TIMEOUT_MS = 15000;
// 建连也要有超时，否则半连接的 socket 会把整个重连机制卡死（见 connect() 里的注释）
const CONNECT_TIMEOUT_MS = 10000;

export const seg = {
  text: (text) => ({ type: 'text', data: { text: String(text) } }),
  at: (qq) => ({ type: 'at', data: { qq: String(qq) } }),
  reply: (id) => ({ type: 'reply', data: { id: String(id) } }),
};

export function createTransport({ cfg, log = console.log }) {
  const { ws: rawUrl, accessToken, reconnectDelayMs } = cfg.onebot;

  let socket = null;
  let seq = 0;
  let closedByUs = false;
  let reconnecting = false;
  let connectTimer = null;
  const pending = new Map();
  let onEvent = () => {};
  let onStatus = () => {};

  function resolveUrl() {
    if (!accessToken) return rawUrl;
    const sep = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${sep}access_token=${encodeURIComponent(accessToken)}`;
  }

  function openSocket() {
    const url = resolveUrl();
    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;
    // Node 内置 WebSocket 对自定义 header 的支持随版本不同，失败则退回纯 URL 方式
    if (headers) {
      try {
        return new WebSocket(url, { headers });
      } catch {
        /* fallthrough */
      }
    }
    return new WebSocket(url);
  }

  function connect() {
    closedByUs = false;
    const url = resolveUrl();
    log(`[onebot] 正在连接 ${url.replace(/access_token=[^&]+/, 'access_token=***')}`);
    try {
      socket = openSocket();
    } catch (e) {
      log(`[onebot] 建连失败：${e.message}`);
      scheduleReconnect();
      return;
    }

    // 连接超时兜底：机器休眠唤醒、或者协议端在重启的窗口里，TCP 可能永远停在
    // CONNECTING —— 这时既不会触发 open 也不会触发 close，重连逻辑根本不会被唤醒，
    // 进程就变成「活着但不干活」的僵尸（日志里只剩一条「正在连接」，之后全是空白）。
    // 所以必须自己数秒，到点还连不上就当它死了，强制丢掉重来。
    clearTimeout(connectTimer);
    connectTimer = setTimeout(() => {
      if (!socket || socket.readyState === 1) return;
      log(`[onebot] 连接超时（${Math.round(CONNECT_TIMEOUT_MS / 1000)}s 未连上），强制重连`);
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      socket = null;
      scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      clearTimeout(connectTimer);
      connectTimer = null;
      log('[onebot] 已连接');
      onStatus({ connected: true });
    });

    socket.addEventListener('message', async (evt) => {
      let raw = evt.data;
      if (typeof raw !== 'string') {
        try {
          raw = await raw.text();
        } catch {
          return;
        }
      }
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.echo != null && pending.has(String(msg.echo))) {
        const { resolve, timer } = pending.get(String(msg.echo));
        clearTimeout(timer);
        pending.delete(String(msg.echo));
        if (msg.status === 'failed' || msg.retcode !== 0) {
          resolve({ ok: false, error: msg.wording || msg.message || `retcode=${msg.retcode}`, data: msg.data });
        } else {
          resolve({ ok: true, data: msg.data });
        }
        return;
      }
      try {
        onEvent(msg);
      } catch (e) {
        log(`[onebot] 事件处理异常：${e.stack || e.message}`);
      }
    });

    socket.addEventListener('error', () => {
      // 具体原因在 close 里统一报，避免刷两条
    });

    socket.addEventListener('close', (e) => {
      clearTimeout(connectTimer);
      connectTimer = null;
      onStatus({ connected: false });
      for (const [, { resolve, timer }] of pending) {
        clearTimeout(timer);
        resolve({ ok: false, error: '连接已断开' });
      }
      pending.clear();
      if (closedByUs) return;
      log(`[onebot] 连接断开（code=${e.code}），${Math.round(reconnectDelayMs / 1000)}s 后重连`);
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (reconnecting || closedByUs) return;
    reconnecting = true;
    setTimeout(() => {
      reconnecting = false;
      if (!closedByUs) connect();
    }, reconnectDelayMs);
  }

  function call(action, params = {}) {
    return new Promise((resolve) => {
      if (!socket || socket.readyState !== 1) {
        resolve({ ok: false, error: '尚未连接到协议端' });
        return;
      }
      const echo = `e${++seq}`;
      const timer = setTimeout(() => {
        pending.delete(echo);
        resolve({ ok: false, error: `${action} 超时` });
      }, CALL_TIMEOUT_MS);
      pending.set(echo, { resolve, timer });
      try {
        socket.send(JSON.stringify({ action, params, echo }));
      } catch (e) {
        clearTimeout(timer);
        pending.delete(echo);
        resolve({ ok: false, error: e.message });
      }
    });
  }

  const sendGroup = (groupId, segments) => {
    if ((cfg.mutedGroups ?? []).map(String).includes(String(groupId))) {
      return Promise.resolve({ ok: false, error: '该群已暂停发言' });
    }
    return call('send_group_msg', { group_id: groupId, message: segments });
  };
  const sendPrivate = (userId, segments) => call('send_private_msg', { user_id: userId, message: segments });
  const getLoginInfo = () => call('get_login_info');

  function close() {
    closedByUs = true;
    clearTimeout(connectTimer);
    connectTimer = null;
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
  }

  return {
    connect,
    close,
    call,
    sendGroup,
    sendPrivate,
    getLoginInfo,
    setEventHandler: (fn) => {
      onEvent = fn;
    },
    setStatusHandler: (fn) => {
      onStatus = fn;
    },
  };
}
