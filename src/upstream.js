/**
 * 上游客户端：码道 CodeArts 网页端协议
 *
 * 上游协议分两层（均由网页端 SDK 定义）：
 *   1. cloudagent 层（当前线上生效）
 *        POST /v1/cloudagent/sessions                      创建会话
 *        POST /codebaseservice/v1/cloudagent/sessions/:id/messages   发送指令，返回 SSE
 *        GET  /codebaseservice/v1/cloudagent/sessions/:id/messages   拉取历史消息
 *        POST /v1/cloudagent/sessions/:id/messages/stop     中断本轮
 *        POST /v1/cloudagent/sessions/:id/messages/reply    回答 question 工具
 *   2. kernel 层（SDK 内保留，线上网关暂无 UriMapping，作为回退）
 *        POST /kernel/sessions/create | /kernel/sessions/:id/prompt
 *        GET  /kernel/sessions/:id/events                    SSE 长连接
 *
 * 鉴权：Cookie（SessionID / cbc-sid / vk 等）+ cftk 头（取自 cookie 前缀键）。
 */
import { CONFIG } from './config.js';

const BASE = CONFIG.upstreamBase;

export class UpstreamError extends Error {
  constructor(message, { status = 0, code = '', raw = '' } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
    this.raw = raw;
  }
}

/** 从整段 cookie 里取出 cftk：网页端是「app cookie 前缀 + cftk」这个 cookie 的值。 */
export function extractCftk(cookie) {
  if (!cookie) return '';
  const m = cookie.match(/(?:^|;\s*)([A-Za-z0-9_]*cftk)=([^;]+)/i);
  return m ? decodeURIComponent(m[2]) : '';
}

/** Cookie 里混入非 ASCII（复制粘贴带的零宽字符、全角标点等）会让 HTTP 头编码直接抛错，先清掉。 */
function sanitizeHeaderValue(v) {
  return String(v || '').replace(/[^\t\x20-\x7E\x80-\xFF]/g, '').trim();
}

function baseHeaders(account, extra = {}) {
  const cftk = account?.cftk || extractCftk(account?.cookie || '');
  return {
    'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'x-codearts-doer-scenario-type': 'web',
    'x-ot-client-type': CONFIG.clientType,
    'x-ot-client-version': CONFIG.clientVersion,
    // 真实网页端用的是小写键 agent-type，取值随服务而定：建会话/拉会话 = CodeBase
    'agent-type': 'CodeBase',
    'x-mode-type': 'fastmode',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    Cookie: sanitizeHeaderValue(account?.cookie || ''),
    ...(cftk ? { cftk: sanitizeHeaderValue(cftk) } : {}),
    ...extra,
  };
}

function withTimeout(ms = 60000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('upstream timeout')), ms);
  return { signal: ac.signal, clear: () => clearTimeout(timer) };
}

async function request(account, path, { method = 'GET', body, query, timeout = 60000, headers } = {}) {
  const url = new URL(BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
  }
  const t = withTimeout(timeout);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: baseHeaders(account, headers),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: t.signal,
      redirect: 'manual',
    });
  } catch (e) {
    t.clear();
    throw new UpstreamError(e.name === 'AbortError' ? '上游请求超时' : `上游连接失败：${e.message}`, { status: 0 });
  }
  t.clear();

  // 网页端靠这个响应头判断登录失效
  const redirect = res.headers.get('hw-ajax-redirect');

  // cftk 会随响应轮转，取到新值就得回写，否则下一次请求会被判鉴权失败
  const rotated = rotatedCftk(res);
  if (rotated) {
    account.cftk = rotated;
    if (typeof onCftkRotate === 'function') { try { onCftkRotate(account, rotated); } catch { /* noop */ } }
  } else if (!account.cftk) {
    // 库里的 cftk 是空的（比如导入时只贴了整段 cookie）：顺手从这个账号自己的
    // cookie 里补一次，让控制台显示的鉴权状态和实际发出去的头一致
    const fromCookie = extractCftk(account.cookie || '');
    if (fromCookie) {
      account.cftk = fromCookie;
      if (typeof onCftkRotate === 'function') { try { onCftkRotate(account, fromCookie); } catch { /* noop */ } }
    }
  }

  const text = await res.text();
  if (redirect) {
    throw new UpstreamError('上游登录态失效，请更新账号 Cookie', { status: 401, code: 'AUTH_REDIRECT', raw: redirect });
  }
  // 登录态失效时上游可能直接吐登录页 HTML（200 + text/html），不能当 JSON 继续往下走
  if (/text\/html/i.test(res.headers.get('content-type') || '')) {
    throw new UpstreamError('上游登录态失效，请更新账号 Cookie', { status: 401, code: 'AUTH_REDIRECT', raw: text.slice(0, 200) });
  }
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamError('上游鉴权失败（401/403），Cookie 或 cftk 可能已过期', { status: res.status, raw: text.slice(0, 500) });
  }
  if (!res.ok) {
    let msg = text.slice(0, 500);
    try {
      const j = JSON.parse(text);
      msg = j.error_msg || j.message || j.error || msg;
    } catch { /* keep raw */ }
    throw new UpstreamError(`上游返回 ${res.status}：${msg}`, { status: res.status, raw: text.slice(0, 1000) });
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

/**
 * 判断一个错误是不是「登录态失效」。
 * 上游失效时不一定给 401：可能回 200 + hw-ajax-redirect 头，也可能回 200 + 空对象，
 * 所以这里同时认 status/code/message 三类信号。
 */
export function isAuthError(e) {
  if (!e) return false;
  if (e.code === 'AUTH_REDIRECT' || e.code === 'AUTH_EMPTY') return true;
  if (e.status === 401 || e.status === 403) return true;
  return /登录态失效|鉴权失败|AUTH_REDIRECT/i.test(String(e.message || ''));
}

/* ----------------------------- cftk ----------------------------- */

let onCftkRotate = null;

/** 注册 cftk 轮转回调：由上层把新值写回账号库。 */
export function setCftkRotateHandler(fn) {
  onCftkRotate = fn;
}

/** 供其它模块（签到）在拿到新 cftk 后触发同一个回写。 */
export function emitCftkRotate(account, cftk) {
  if (typeof onCftkRotate !== 'function' || !account || !cftk) return;
  try { onCftkRotate(account, cftk); } catch { /* 回写失败不影响本次请求 */ }
}

/** 从响应里读出轮转后的 cftk（上游用 Set-Cookie 下发同名 cookie）。 */
function rotatedCftk(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of list) {
    const m = String(line).match(/^\s*([A-Za-z0-9_]*cftk)=([^;]+)/i);
    if (m && m[2].trim()) return decodeURIComponent(m[2].trim());
  }
  const raw = res.headers.get('set-cookie') || '';
  const m = raw.match(/(?:^|,\s*)([A-Za-z0-9_]*cftk)=([^;,\s]+)/i);
  return m ? decodeURIComponent(m[2].trim()) : '';
}

/** 把整段 cookie 里的 cftk 替换成新值（保持其余 cookie 不动）。 */
export function patchCookieCftk(cookie, cftk) {
  if (!cookie || !cftk) return cookie;
  if (/(?:^|;\s*)[A-Za-z0-9_]*cftk=[^;]*/i.test(cookie)) {
    return cookie.replace(/(^|;\s*)([A-Za-z0-9_]*cftk)=[^;]*/i, (all, sep, name) => `${sep}${name}=${cftk}`);
  }
  return `${cookie}; devclouddevuibjtcftk=${cftk}`;
}

/* ----------------------------- 账号信息 ----------------------------- */

export async function fetchMe(account) {
  const j = await request(account, '/rest/me', { query: { _: Date.now() } });
  const me = j?.data ?? j?.result ?? j ?? null;
  // 登录态失效时上游可能回 200 + 空对象，不能当成功
  if (!me || typeof me !== 'object' || !Object.keys(me).length) {
    throw new UpstreamError('上游未返回账号信息，登录态无效', { status: 401, code: 'AUTH_EMPTY' });
  }
  return me;
}

/**
 * 轻量探活：最省的一次鉴权调用，只为把上游的空闲计时器推后。
 * 只看「有没有被判失效」，不关心返回内容，失败直接抛。
 */
export async function probeAccount(account, { timeout = 15000 } = {}) {
  const j = await request(account, '/rest/me', { query: { _: Date.now() }, timeout });
  const me = j?.data ?? j?.result ?? j ?? null;
  if (!me || typeof me !== 'object' || !Object.keys(me).length) {
    throw new UpstreamError('探活未返回账号信息，登录态可能已失效', { status: 401, code: 'AUTH_EMPTY' });
  }
  return me;
}

/* ----------------------------- 模型列表 ----------------------------- */

/**
 * 网页端模型选择器的实际取值（model_id 就是这类短 slug）。
 * agent detail 接口需要 agent_id 等参数，取不到时回退到这份实测清单。
 */
export const KNOWN_MODELS = [
  { id: 'speed', name: '智速模式', multiple: 0.18, type: 'builtin' },
  { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017', multiple: 0.18, type: 'builtin' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', multiple: 0.08, type: 'builtin' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', multiple: 0.18, type: 'builtin' },
  { id: 'glm-5.3', name: 'GLM-5.3', multiple: 0.79, type: 'builtin' },
  { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', multiple: 1.63, type: 'builtin' },
  { id: 'kimi-k3', name: 'Kimi-K3', multiple: 2.38, type: 'builtin' },
  { id: 'glm-5.2', name: 'GLM-5.2', multiple: 0.7, type: 'builtin' },
  { id: 'glm-5.2-arkts-spark', name: 'GLM-5.2-ArkTS-SPARK', multiple: 0.7, type: 'builtin' },
  { id: 'openpangu-2.1-pro', name: 'OpenPangu-2.1-Pro', multiple: 0.07, type: 'builtin' },
  { id: 'openpangu-2.0-pro', name: 'OpenPangu-2.0-Pro', multiple: 0.7, type: 'builtin' },
  { id: 'openpangu-2.0-flash', name: 'OpenPangu-2.0-Flash', multiple: 0.32, type: 'builtin' },
];

export async function fetchModels(account) {
  let raw = [];
  try {
    const j = await request(account, '/PromptCenterService/v1/agent-center/agents/detail', {
      query: { agent_id: CONFIG.agentId, type: 'web' },
      headers: { 'agent-type': 'PromptCenter' },
      timeout: 15000,
    });
    const root = j?.data ?? j;
    const detail = root?.data ?? root;
    raw = detail?.gpts?.models ?? [];
  } catch {
    raw = [];
  }

  if (!raw.length) return KNOWN_MODELS.map((m) => ({ ...m }));

  const out = [];
  for (const m of raw) {
    const p = m?.model_parameters ?? {};
    const id = p.model_id || p.modelId || m.model_name || m.modelName;
    if (!id) continue;
    if (p.display_enabled === false || m.display_enabled === false) continue;
    out.push({
      id,
      name: m.model_name || p.model_name || id,
      context: p.context_window || p.input_context_window || 0,
      maxTokens: p.max_tokens || p.output_context_window || 0,
      multiple: p.multiple ?? m.multiple ?? 0,
      tag: m.model_tag || p.model_tag || '',
      type: m.model_type || p.model_type || '',
      desc: p.model_desc || m.model_desc || '',
    });
  }
  return out.length ? out : KNOWN_MODELS.map((m) => ({ ...m }));
}

/* ----------------------------- 会话层 ----------------------------- */

export async function createSession(account) {
  const j = await request(account, '/v1/cloudagent/sessions', { method: 'POST', body: {} });
  const r = j?.result ?? j?.data ?? j;
  const id = r?.session_id || r?.sessionId;
  if (!id) throw new UpstreamError('上游未返回 session_id', { raw: JSON.stringify(j).slice(0, 500) });
  return { id, raw: r };
}

export async function listSessions(account, { pageNum = 1, pageSize = 50 } = {}) {
  const j = await request(account, '/v1/cloudagent/sessions', { query: { page_num: pageNum, page_size: pageSize } });
  const rows = j?.result ?? j?.data ?? [];
  return Array.isArray(rows) ? rows : [];
}

export async function listMessages(account, sessionId, { pageNum = 1, pageSize = 200 } = {}) {
  const j = await request(account, `/codebaseservice/v1/cloudagent/sessions/${encodeURIComponent(sessionId)}/messages`, {
    query: { pageNum, pageSize },
  });
  const msgs = j?.messages ?? j?.result?.messages ?? [];
  return Array.isArray(msgs) ? msgs : [];
}

export async function stopSession(account, sessionId) {
  return request(account, `/v1/cloudagent/sessions/${encodeURIComponent(sessionId)}/messages/stop`, { method: 'POST', body: {} });
}

/**
 * 真正删除上游会话，释放 runtime 配额。
 * 只 stop 不会回收 runtime，会话会一直挂着，攒满后上游对发消息回
 * CODEBASE.00014000.429（Insufficient environmental resources）。
 */
export async function deleteSession(account, sessionId) {
  return request(account, `/v1/cloudagent/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}

export async function replyQuestion(account, sessionId, { questionId, answers }) {
  return request(account, `/v1/cloudagent/sessions/${encodeURIComponent(sessionId)}/messages/reply`, {
    method: 'POST',
    body: { question_id: questionId, answers },
  });
}

/**
 * 发送一轮 prompt，返回上游原始 SSE 响应（ReadableStream）。
 * 上游要求 Accept: text/event-stream，并以 event:/data: 两行格式推送。
 */
export async function promptStream(account, sessionId, payload, { timeout = CONFIG.requestTimeoutMs, signal } = {}) {
  const path = `/codebaseservice/v1/cloudagent/sessions/${encodeURIComponent(sessionId)}/messages`;
  const url = `${BASE}${path}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('prompt timeout')), timeout);
  if (signal) signal.addEventListener('abort', () => ac.abort(new Error('client aborted')), { once: true });

  const headers = baseHeaders(account, { Accept: 'text/event-stream' });
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ac.signal,
      redirect: 'manual',
    });
  } catch (e) {
    clearTimeout(timer);
    throw new UpstreamError(e.name === 'AbortError' ? '上游响应超时' : `上游连接失败：${e.message}`);
  }

  const redirect = res.headers.get('hw-ajax-redirect');

  if (redirect) {
    clearTimeout(timer);
    throw new UpstreamError('上游登录态失效，请更新账号 Cookie', { status: 401, code: 'AUTH_REDIRECT' });
  }
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '');
    clearTimeout(timer);
    throw new UpstreamError(`上游返回 ${res.status}：${txt.slice(0, 400)}`, { status: res.status, raw: txt.slice(0, 1000) });
  }

  // 这里的响应也可能轮转 cftk
  const rotated = rotatedCftk(res);
  if (rotated) {
    account.cftk = rotated;
    if (typeof onCftkRotate === 'function') { try { onCftkRotate(account, rotated); } catch { /* noop */ } }
  }

  return {
    body: res.body,
    headers: res.headers,
    close: () => { clearTimeout(timer); try { ac.abort(); } catch { /* noop */ } },
  };
}

/** 把上游 SSE 字节流解析成 {event, data} 事件序列。 */
export async function* parseSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // 上游用 "  " (两空格) 分隔事件块，同时兼容标准 \n\n
      let idx;
      while ((idx = findBoundary(buf)) !== -1) {
        const block = buf.slice(0, idx.at);
        buf = buf.slice(idx.at + idx.len);
        const ev = parseBlock(block);
        if (ev) yield ev;
      }
    }
    buf += decoder.decode();
    if (buf.trim()) {
      const ev = parseBlock(buf);
      if (ev) yield ev;
    }
  } finally {
    try { await reader.cancel(); } catch { /* noop */ }
  }
}

function findBoundary(s) {
  const a = s.indexOf('\n\n');
  const b = s.indexOf('\r\n\r\n');
  if (a === -1 && b === -1) return -1;
  if (a !== -1 && (b === -1 || a < b)) return { at: a, len: 2 };
  return { at: b, len: 4 };
}

function parseBlock(block) {
  let event = '';
  const datas = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) datas.push(line.slice(5).trim());
  }
  if (!datas.length) return null;
  const data = datas.join('\n');
  if (!data || data === '[DONE]') return { event: event || 'done', data: null, raw: data };
  let parsed = null;
  try { parsed = JSON.parse(data); } catch { /* 非 JSON 事件原样返回 */ }
  return { event: event || 'message', data: parsed, raw: data };
}

/* ----------------------------- kernel 回退层 ----------------------------- */

export async function kernelCreateSession(account) {
  const j = await request(account, '/kernel/sessions/create', { method: 'POST', body: {} });
  const r = j?.result ?? j;
  return { id: r?.session_id || r?.sessionId, raw: r };
}

export async function kernelPrompt(account, sessionId, payload) {
  return promptStream(account, sessionId, payload);
}
