import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Protocol references (independent Node implementation):
// https://github.com/chenluQwQ/astrbot_plugin_bilibili_ai_bot/blob/main/core/bilibili.py
// https://github.com/chenluQwQ/astrbot_plugin_bilibili_ai_bot/blob/main/core/proactive.py
const API = 'https://api.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const COOKIE_NAMES = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3', 'buvid4']);
const MIXIN_ORDER = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const MAX_JSON = 2 * 1024 * 1024;

export class BilibiliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BilibiliError';
    this.code = code;
    Object.assign(this, details);
  }
}

function bv(value) {
  if (typeof value !== 'string' || !/^BV[0-9A-Za-z]{10}$/.test(value)) {
    throw new BilibiliError('INVALID_INPUT', '视频编号必须是有效的 BV 号');
  }
  return value;
}

function limitOf(value) { return Math.min(30, Math.max(1, Math.floor(Number(value) || 10))); }
function plain(value, max = 2000) {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').slice(0, max);
}
function seconds(value) {
  if (typeof value === 'string' && value.includes(':')) return value.split(':').reduce((a, b) => a * 60 + Number(b), 0);
  return Math.max(0, Number(value) || 0);
}
function normalize(item) {
  if (!item || !/^BV[0-9A-Za-z]{10}$/.test(String(item.bvid || ''))) return null;
  return {
    bvid: item.bvid, aid: Number(item.aid ?? item.id) || 0,
    ...(item.cid ? { cid: Number(item.cid) } : {}),
    title: plain(item.title, 240), description: plain(item.desc ?? item.description),
    author: plain(item.owner?.name ?? item.author, 100), duration: seconds(item.duration),
    url: `https://www.bilibili.com/video/${item.bvid}`,
    ...(item.pic ? { cover: String(item.pic).replace(/^\/\//, 'https://') } : {}),
  };
}
function filteredCookies(input = {}) {
  return Object.fromEntries(Object.entries(input).filter(([name, value]) => COOKIE_NAMES.has(name) && typeof value === 'string' && /^[^\x00-\x20\x7f;]{1,4096}$/.test(value)));
}
function cookieHeader(input) { return Object.entries(filteredCookies(input)).map(([key, value]) => `${key}=${value}`).join('; '); }
function cookieUpdates(headers) {
  const lines = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : String(headers.get('set-cookie') || '').split(/,(?=\s*[A-Za-z0-9_]+=)/);
  const cookies = {};
  for (const line of lines) {
    const match = String(line).match(/^\s*([^=;\s]+)=([^;]*)/);
    if (match) cookies[match[1]] = match[2];
  }
  return filteredCookies(cookies);
}
function isDomain(host, domain) { return host === domain || host.endsWith(`.${domain}`); }
function trustedMedia(value, kind = 'media') {
  let url;
  try { url = new URL(String(value).replace(/^\/\//, 'https://')); } catch { return null; }
  const domains = kind === 'subtitle' ? ['hdslb.com', 'bilibili.com'] : ['bilivideo.com', 'bilivideo.cn', 'hdslb.com'];
  if (url.protocol !== 'https:' || url.username || url.password || !domains.some(d => isDomain(url.hostname, d))) return null;
  return url.href;
}
function platformError(code, httpStatus) {
  code = Number.isFinite(Number(code)) ? Number(code) : undefined;
  if ([-101, -111].includes(code) || httpStatus === 401) return new BilibiliError('AUTH_REQUIRED', 'B站账号需要重新登录', { platformCode: code, httpStatus });
  if ([-352, -412, -509, 412, 12002, 12009].includes(code) || [403, 412, 429].includes(httpStatus)) return new BilibiliError('RISK_CONTROL', 'B站要求验证或暂时限制访问，请在官方客户端检查账号', { platformCode: code, httpStatus });
  return new BilibiliError('PLATFORM_ERROR', `B站接口未成功（${code ?? httpStatus}）`, { platformCode: code, httpStatus });
}

/** Account session is confined to fixed Bilibili endpoints; callers never receive cookies. */
export function createBilibiliClient({ credentialFile, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000 } = {}) {
  if (!credentialFile) throw new Error('credentialFile is required');
  const qrSessions = new Map();
  let cachedWbi = null;
  let cachedStatus = null;
  let guestCookies = {};

  async function credentials() {
    try {
      const stat = await fs.stat(credentialFile);
      if (stat.size > 65536) return { cookies: {} };
      const data = JSON.parse(await fs.readFile(credentialFile, 'utf8'));
      return { ...data, cookies: filteredCookies(data.cookies) };
    } catch { return { cookies: {} }; }
  }

  async function saveCredentials(data) {
    await fs.mkdir(path.dirname(credentialFile), { recursive: true, mode: 0o700 });
    const temp = `${credentialFile}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, credentialFile);
      await fs.chmod(credentialFile, 0o600);
    } finally { await fs.unlink(temp).catch(() => {}); }
    cachedStatus = null;
    cachedWbi = null;
  }

  async function request(base, { params, method = 'GET', body, cookies, raw = false, publicMedia = false } = {}) {
    const url = new URL(base);
    if (!publicMedia && ![API, PASSPORT].includes(url.origin)) throw new BilibiliError('INVALID_INPUT', '禁止向未知站点发送账号请求');
    if (publicMedia && !trustedMedia(url.href, 'subtitle')) throw new BilibiliError('INVALID_INPUT', '字幕地址不在允许的来源中');
    for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const headers = { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.bilibili.com/' };
    if (!publicMedia) {
      const saved = cookies ?? { ...guestCookies, ...(await credentials()).cookies };
      const header = cookieHeader(saved);
      if (header) headers.Cookie = header;
    }
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    try {
      const response = await fetchImpl(url.href, { method, headers, body: body ? new URLSearchParams(body).toString() : undefined, signal: ctrl.signal, redirect: 'error' });
      if (!response.ok) throw platformError(undefined, response.status);
      if (Number(response.headers.get('content-length')) > MAX_JSON) throw new BilibiliError('INVALID_RESPONSE', 'B站响应超过大小限制');
      let text = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_JSON) { await reader.cancel(); throw new BilibiliError('INVALID_RESPONSE', 'B站响应超过大小限制'); }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } else {
        text = await response.text();
        if (Buffer.byteLength(text) > MAX_JSON) throw new BilibiliError('INVALID_RESPONSE', 'B站响应超过大小限制');
      }
      let data;
      try { data = JSON.parse(text); } catch { throw new BilibiliError('INVALID_RESPONSE', 'B站返回了无法识别的响应'); }
      if (!raw && Number(data.code) !== 0) throw platformError(data.code, response.status);
      return { data, headers: response.headers };
    } catch (error) {
      if (error instanceof BilibiliError) throw error;
      throw new BilibiliError(ctrl.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR', ctrl.signal.aborted ? 'B站请求超时' : 'B站连接暂时失败');
    } finally { clearTimeout(timer); }
  }

  async function status() {
    const saved = await credentials();
    if (!saved.cookies.SESSDATA) return { loggedIn: false };
    const sessionId = crypto.createHash('sha256').update(saved.cookies.SESSDATA).digest('hex');
    if (cachedStatus?.sessionId === sessionId && now() - cachedStatus.time < 60000) return { ...cachedStatus.value };
    try {
      const { data } = await request(`${API}/x/web-interface/nav`, { cookies: saved.cookies });
      const value = data.data?.isLogin && data.data?.mid
        ? { loggedIn: true, uid: String(data.data.mid), name: plain(data.data.uname, 100) }
        : { loggedIn: false };
      cachedStatus = { sessionId, time: now(), value };
      return { ...value };
    } catch (error) { return { loggedIn: false, error: error.code }; }
  }

  async function createQr() {
    const { data } = await request(`${PASSPORT}/x/passport-login/web/qrcode/generate`, { cookies: {} });
    let url;
    try { url = new URL(data.data?.url); } catch { throw new BilibiliError('INVALID_RESPONSE', 'B站没有返回有效登录二维码'); }
    const key = String(data.data?.qrcode_key || '');
    if (url.protocol !== 'https:' || !isDomain(url.hostname, 'bilibili.com') || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new BilibiliError('INVALID_RESPONSE', 'B站返回的登录二维码格式不正确');
    const expiresAt = now() + 180000;
    qrSessions.clear();
    qrSessions.set(key, expiresAt);
    return { url: url.href, key, expiresAt };
  }

  async function pollQr(key) {
    if (!qrSessions.has(key) || now() >= qrSessions.get(key)) return { status: 'expired' };
    const issuedExpiry = qrSessions.get(key);
    const { data: envelope, headers } = await request(`${PASSPORT}/x/passport-login/web/qrcode/poll`, { params: { qrcode_key: key }, cookies: {} });
    if (qrSessions.get(key) !== issuedExpiry || now() >= issuedExpiry) return { status: 'expired' };
    const data = envelope.data || {};
    if (data.code === 86101) return { status: 'waiting' };
    if (data.code === 86090) return { status: 'scanned' };
    if (data.code === 86038) { qrSessions.delete(key); return { status: 'expired' }; }
    if (data.code !== 0) throw platformError(data.code);
    const fromUrl = {};
    if (data.url) {
      try {
        const result = new URL(data.url);
        if (result.protocol === 'https:' && ['bilibili.com', 'biligame.com'].some(d => isDomain(result.hostname, d))) {
          for (const name of COOKIE_NAMES) { const value = result.searchParams.get(name); if (value) fromUrl[name] = value; }
        }
      } catch { /* only response headers are used when callback URL is absent */ }
    }
    const cookies = { ...filteredCookies(fromUrl), ...cookieUpdates(headers) };
    if (!cookies.SESSDATA || !cookies.bili_jct || !/^\d+$/.test(cookies.DedeUserID || '')) throw new BilibiliError('INVALID_RESPONSE', '登录响应缺少必要凭据，请重新扫码');
    const { data: nav } = await request(`${API}/x/web-interface/nav`, { cookies });
    if (!nav.data?.isLogin || String(nav.data.mid) !== cookies.DedeUserID) throw new BilibiliError('AUTH_REQUIRED', '未能核实扫码账号，请重新扫码');
    if (qrSessions.get(key) !== issuedExpiry || now() >= issuedExpiry) return { status: 'expired' };
    const account = { uid: cookies.DedeUserID, name: plain(nav.data.uname, 100) };
    await saveCredentials({ version: 1, cookies, refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token.slice(0, 4096) : '', account, savedAt: now() });
    qrSessions.delete(key);
    return { status: 'confirmed', account };
  }

  async function guestSession() {
    if (guestCookies.buvid3 || (await credentials()).cookies.buvid3) return;
    const { data } = await request(`${API}/x/frontend/finger/spi`, { cookies: {} });
    guestCookies = filteredCookies({ buvid3: data.data?.b_3, buvid4: data.data?.b_4 });
  }

  async function signed(params) {
    if (!cachedWbi || now() - cachedWbi.time > 6 * 3600000) {
      const { data } = await request(`${API}/x/web-interface/nav`, { raw: true });
      const images = data.data?.wbi_img;
      const extract = value => new URL(value).pathname.split('/').pop().split('.')[0];
      let original;
      try { original = extract(images.img_url) + extract(images.sub_url); } catch { throw new BilibiliError('INVALID_RESPONSE', 'B站签名信息不可用'); }
      if (!/^[0-9a-f]{64}$/i.test(original)) throw new BilibiliError('INVALID_RESPONSE', 'B站签名信息格式不正确');
      cachedWbi = { time: now(), key: MIXIN_ORDER.map(i => original[i]).join('').slice(0, 32) };
    }
    const values = { ...params, wts: Math.floor(now() / 1000) };
    const query = Object.keys(values).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(values[k]).replace(/[!'()*]/g, ''))}`).join('&');
    return { ...values, w_rid: crypto.createHash('md5').update(query + cachedWbi.key).digest('hex') };
  }

  async function popular({ limit = 10 } = {}) {
    const { data } = await request(`${API}/x/web-interface/popular`, { params: { ps: limitOf(limit), pn: 1 } });
    return (data.data?.list || []).map(normalize).filter(Boolean).slice(0, limitOf(limit));
  }
  async function search(keyword, { limit = 10 } = {}) {
    if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 100) throw new BilibiliError('INVALID_INPUT', '搜索词长度应为 1 到 100 字');
    await guestSession();
    const params = await signed({ keyword: keyword.trim(), search_type: 'video', page: 1, page_size: limitOf(limit), order: 'totalrank' });
    const { data } = await request(`${API}/x/web-interface/wbi/search/type`, { params });
    return (data.data?.result || []).map(normalize).filter(Boolean).slice(0, limitOf(limit));
  }
  async function recommendations({ limit = 10 } = {}) {
    if (!(await credentials()).cookies.SESSDATA) return popular({ limit });
    const params = await signed({ ps: limitOf(limit), fresh_type: 4, fresh_idx: 1, fresh_idx_1h: 1, feed_version: 'V8', homepage_ver: 1 });
    const { data } = await request(`${API}/x/web-interface/wbi/index/top/feed/rcmd`, { params });
    return (data.data?.item || data.data?.items || []).map(normalize).filter(Boolean).slice(0, limitOf(limit));
  }
  async function video(bvid) {
    bv(bvid);
    const { data } = await request(`${API}/x/web-interface/view`, { params: { bvid } });
    const result = normalize(data.data);
    if (!result || result.bvid !== bvid) throw new BilibiliError('INVALID_RESPONSE', 'B站没有返回匹配的视频信息');
    if (!result.cid && data.data?.pages?.[0]?.cid) result.cid = Number(data.data.pages[0].cid);
    return result;
  }
  async function subtitles(bvid, cid) {
    bv(bvid);
    if (!Number.isSafeInteger(Number(cid)) || Number(cid) <= 0) throw new BilibiliError('INVALID_INPUT', '视频分P编号无效');
    const { data } = await request(`${API}/x/player/v2`, { params: { bvid, cid } });
    const options = data.data?.subtitle?.subtitles || [];
    const chosen = options.find(x => /^(zh|ai-zh)/.test(x.lan || '')) || options[0];
    if (!chosen) return { text: '', available: false };
    const url = trustedMedia(chosen.subtitle_url, 'subtitle');
    if (!url) throw new BilibiliError('INVALID_RESPONSE', '字幕地址不在允许的来源中');
    const { data: transcript } = await request(url, { raw: true, publicMedia: true });
    const text = (transcript.body || []).map(x => plain(x.content, 2000)).join('\n').slice(0, 30000);
    return { text, available: !!text, language: plain(chosen.lan, 30) };
  }
  async function playUrl(bvid, cid) {
    bv(bvid);
    if (!Number.isSafeInteger(Number(cid)) || Number(cid) <= 0) throw new BilibiliError('INVALID_INPUT', '视频分P编号无效');
    const { data } = await request(`${API}/x/player/playurl`, { params: { bvid, cid, qn: 16, fnval: 16, fnver: 0, fourk: 0 } });
    const info = data.data || {};
    if (info.is_preview || info.drm_tech_type || info.drm_type || info.need_vip) throw new BilibiliError('UNAVAILABLE_MEDIA', '该视频无法取得完整公开播放源');
    const videos = (info.dash?.video || []).filter(x => !x.drm).sort((a, b) => (Number(a.height) || 1e6) - (Number(b.height) || 1e6) || (Number(a.bandwidth) || 0) - (Number(b.bandwidth) || 0));
    const audios = (info.dash?.audio || []).sort((a, b) => (Number(a.bandwidth) || 0) - (Number(b.bandwidth) || 0));
    const chosen = videos.find(x => trustedMedia(x.baseUrl || x.base_url));
    const audio = audios.find(x => trustedMedia(x.baseUrl || x.base_url));
    if (chosen) return { videoUrl: trustedMedia(chosen.baseUrl || chosen.base_url), ...(audio ? { audioUrl: trustedMedia(audio.baseUrl || audio.base_url) } : {}), duration: Number(info.timelength) / 1000 || Number(info.dash.duration) || 0 };
    if (info.durl?.length === 1) {
      const url = trustedMedia(info.durl[0].url);
      if (url) return { videoUrl: url, duration: Number(info.timelength) / 1000 || 0 };
    }
    throw new BilibiliError('UNAVAILABLE_MEDIA', '该视频没有可用的公开播放源');
  }
  async function postComment({ bvid, text }) {
    bv(bvid);
    if (typeof text !== 'string' || !text.trim() || text.length > 500) throw new BilibiliError('INVALID_INPUT', '评论内容应为 1 到 500 字');
    const account = await status();
    if (!account.loggedIn) return { ok: false, unknown: false, error: account.error || 'AUTH_REQUIRED' };
    const saved = await credentials();
    if (!saved.cookies.bili_jct) return { ok: false, unknown: false, error: 'AUTH_REQUIRED' };
    let info;
    try { info = await video(bvid); } catch (error) { return { ok: false, unknown: false, error: error.code }; }
    if (!info.aid) return { ok: false, unknown: false, error: 'INVALID_RESPONSE' };
    try {
      // Deliberately one POST only: an interrupted write cannot safely be retried.
      const { data } = await request(`${API}/x/v2/reply/add`, { method: 'POST', cookies: saved.cookies, body: { oid: info.aid, type: 1, message: text.trim(), plat: 1, csrf: saved.cookies.bili_jct } });
      const rpid = data.data?.rpid ?? data.data?.reply?.rpid;
      if (!rpid) return { ok: false, unknown: true, error: 'UNCONFIRMED_RESULT' };
      return { ok: true, rpid: String(rpid) };
    } catch (error) {
      const unknown = ['TIMEOUT', 'NETWORK_ERROR', 'INVALID_RESPONSE'].includes(error.code) || Number(error.httpStatus) >= 500;
      return { ok: false, unknown, error: error.code || 'UNKNOWN_ERROR' };
    }
  }
  return { status, createQr, pollQr, popular, search, recommendations, video, subtitles, playUrl, postComment };
}
