/**
 * 管理面 API（/api/*），会话鉴权。
 */
import {
  listAccounts, getAccount, createAccount, updateAccount, deleteAccount, mapAccount,
  listKeys, createKey, updateKey, deleteKey, touchKeyIp, countKeyIps,
  queryLogs, statsOverview, usageSeries, usageByModel, usageByHour,
  getSetting, setSetting, seedSettings, db, markAccountResult, markAccountInvalid,
  getSigninToday, listSigninLogs,
} from './db.js';
import { fetchMe, fetchModels, listSessions, stopSession, deleteSession, extractCftk, isAuthError } from './upstream.js';
import { runOnce, signinStatus, startSigninScheduler } from './signin-scheduler.js';
import { runKeepalive, keepaliveStatus, startKeepalive } from './keepalive.js';
import { listModelIds } from './gateway.js';
import { clearAllSessions, releaseAccountSessions } from './bridge.js';
import { login, logout, checkPassword, changePassword, requireAuth, clientIp } from './auth.js';

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};

const bad = (res, msg, code = 400) => json(res, code, { error: msg });

export async function handleApi(req, res, url, body) {
  const path = url.pathname.replace(/^\/api/, '');
  const method = req.method.toUpperCase();

  /* -------- 登录 -------- */
  if (path === '/login' && method === 'POST') {
    if (!checkPassword(body?.password || '')) return bad(res, '密码错误', 401);
    login(res, 'admin');
    return json(res, 200, { ok: true });
  }
  if (path === '/logout' && method === 'POST') {
    logout(res);
    return json(res, 200, { ok: true });
  }
  if (path === '/public') {
    return json(res, 200, {
      version: '1.0.0',
      upstream: true,
      loggedIn: !!requireAuthSoft(req),
    });
  }

  const user = requireAuth(req, res);
  if (!user) return null;

  /* -------- me / password -------- */
  if (path === '/me' && method === 'GET') {
    return json(res, 200, { username: user.u, role: 'admin' });
  }
  if (path === '/password' && method === 'POST') {
    if (!checkPassword(body?.old_password || '')) return bad(res, '原密码错误', 401);
    const np = String(body?.new_password || '');
    if (np.length < 6) return bad(res, '新密码至少 6 位');
    changePassword(np);
    return json(res, 200, { ok: true });
  }

  /* -------- 仪表盘 -------- */
  if (path === '/stats/overview' && method === 'GET') {
    return json(res, 200, statsOverview());
  }
  if (path === '/stats/series' && method === 'GET') {
    const days = Number(url.searchParams.get('days') || 14);
    return json(res, 200, { daily: usageSeries(days), models: usageByModel(days), hourly: usageByHour(24) });
  }

  /* -------- 账号 -------- */
  if (path === '/accounts' && method === 'GET') {
    return json(res, 200, listAccounts());
  }
  if (path === '/accounts' && method === 'POST') {
    const { name, cookie, cftk, group_name, note, expire_at } = body || {};
    if (!name || !cookie) return bad(res, 'name 与 cookie 必填');
    // cftk 是 cookie 里带出来的，前端导入时通常只贴整段 cookie：
    // 与 PATCH 换 Cookie 保持同一套逻辑，省得每个新账号都要手工补一次
    const acc = createAccount({
      name, cookie: cookie.trim(), cftk: cftk || extractCftk(cookie.trim()) || '',
      group_name: group_name || 'default',
      note: note || '', expire_at: Number(expire_at) || 0,
    });
    syncAccount(acc.id).catch(() => {});
    return json(res, 200, acc);
  }

  const accMatch = path.match(/^\/accounts\/(\d+)$/);
  if (accMatch) {
    const id = Number(accMatch[1]);
    if (method === 'PATCH') {
      const prev = getAccount(id);
      const patch = { ...(body || {}) };
      // 换了 Cookie 就等于换了登录态：之前的失效标记和探活失败计数都该清掉，
      // 否则账号会一直挂在 invalid 上，永远不参与选号
      if (typeof patch.cookie === 'string' && patch.cookie.trim() && patch.cookie !== prev?.cookie) {
        patch.cookie = patch.cookie.trim();
        // cftk 和 cookie 是一体的：换了 cookie 却留着旧 cftk 会直接 csrf validate fail，
        // 调用方没显式给就从新 cookie 里重新提取
        if (patch.cftk === undefined || patch.cftk === '') {
          const cftk = extractCftk(patch.cookie);
          if (cftk) patch.cftk = cftk;
        }
        patch.state = 'ok';
        patch.state_msg = '';
        patch.last_check = Date.now();
        db.prepare('UPDATE accounts SET keepalive_fail = 0 WHERE id = ?').run(id);
      }
      const acc = updateAccount(id, patch);
      // 停用账号时把它在上游挂着会话一并释放，否则 runtime 配额会一直占着
      if (prev?.enabled && acc && !acc.enabled) {
        await releaseAccountSessions(acc).catch(() => {});
      }
      return json(res, 200, acc);
    }
    if (method === 'DELETE') {
      const prev = getAccount(id);
      if (prev) await releaseAccountSessions(prev).catch(() => {});
      deleteAccount(id);
      return json(res, 200, { ok: true });
    }
    if (method === 'GET') return json(res, 200, getAccount(id));
  }

  const accAction = path.match(/^\/accounts\/(\d+)\/(test|sync|models)$/);
  if (accAction && method === 'POST') {
    const id = Number(accAction[1]);
    const acc = getAccount(id);
    if (!acc) return bad(res, '账号不存在', 404);
    if (accAction[2] === 'test' || accAction[2] === 'sync') {
      const r = await syncAccount(id);
      return json(res, 200, r);
    }
    const models = await fetchModels(acc);
    return json(res, 200, { models });
  }

  /* -------- 密钥 -------- */
  if (path === '/keys' && method === 'GET') return json(res, 200, listKeys());
  if (path === '/keys' && method === 'POST') {
    const { name, quota, expire_at, ip_whitelist, model_whitelist, note, max_ips } = body || {};
    if (!name) return bad(res, 'name 必填');
    const k = createKey({
      name, quota: Number(quota) || 0, expire_at: Number(expire_at) || 0,
      ip_whitelist: ip_whitelist || [], model_whitelist: model_whitelist || [],
      note: note || '', max_ips: Number(max_ips) || 0,
    });
    return json(res, 200, k);
  }
  const keyMatch = path.match(/^\/keys\/(\d+)$/);
  if (keyMatch) {
    const id = Number(keyMatch[1]);
    if (method === 'PATCH') return json(res, 200, updateKey(id, body || {}));
    if (method === 'DELETE') { deleteKey(id); return json(res, 200, { ok: true }); }
    if (method === 'GET') {
      const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
      if (!row) return bad(res, '密钥不存在', 404);
      return json(res, 200, { ...row, ips: db.prepare('SELECT ip, ts FROM key_ips WHERE key_id = ? ORDER BY ts DESC').all(id) });
    }
  }
  const keyIps = path.match(/^\/keys\/(\d+)\/ips$/);
  if (keyIps && method === 'GET') {
    const id = Number(keyIps[1]);
    return json(res, 200, { ips: db.prepare('SELECT ip, ts FROM key_ips WHERE key_id = ? ORDER BY ts DESC').all(id) });
  }

  /* -------- 日志 -------- */
  if (path === '/logs' && method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 500);
    const offset = Number(url.searchParams.get('offset') || 0);
    return json(res, 200, queryLogs({
      limit, offset,
      keyId: Number(url.searchParams.get('key_id')) || undefined,
      model: url.searchParams.get('model') || undefined,
      status: url.searchParams.get('status') || undefined,
      q: url.searchParams.get('q') || undefined,
    }));
  }

  /* -------- 模型 -------- */
  if (path === '/models' && method === 'GET') {
    const cached = getSetting('model_cache', null);
    return json(res, 200, { models: cached?.detail || [], ids: cached?.list || [], ts: cached?.ts || 0 });
  }
  if (path === '/models' && method === 'POST') {
    const acc = listAccounts().find((a) => a.cookie) || null;
    const models = await fetchModels(acc);
    return json(res, 200, { models });
  }

  /* -------- IP 规则 -------- */
  if (path === '/ip-rules' && method === 'GET') {
    return json(res, 200, db.prepare('SELECT * FROM ip_rules ORDER BY id DESC').all());
  }
  if (path === '/ip-rules' && method === 'POST') {
    const { kind, cidr, note } = body || {};
    if (!['allow', 'deny'].includes(kind) || !cidr) return bad(res, 'kind 需为 allow/deny，cidr 必填');
    db.prepare('INSERT INTO ip_rules(kind, cidr, note, created_at) VALUES(?,?,?,?)')
      .run(kind, cidr.trim(), note || '', Date.now());
    return json(res, 200, { ok: true });
  }
  const ruleDel = path.match(/^\/ip-rules\/(\d+)$/);
  if (ruleDel && method === 'DELETE') {
    db.prepare('DELETE FROM ip_rules WHERE id = ?').run(Number(ruleDel[1]));
    return json(res, 200, { ok: true });
  }

  /* -------- 设置 -------- */
  if (path === '/settings' && method === 'GET') {
    return json(res, 200, {
      default_model: getSetting('default_model', ''),
      model_alias: getSetting('model_alias', {}),
      session_reuse: getSetting('session_reuse', true),
      session_ttl_sec: getSetting('session_ttl_sec', 1800),
      system_prompt_mode: getSetting('system_prompt_mode', 'merge'),
      request_timeout_ms: getSetting('request_timeout_ms', 300000),
      max_concurrency: getSetting('max_concurrency', 8),
      signin_enabled: getSetting('signin_enabled', true),
      signin_hour: Number(getSetting('signin_hour', 8)),
      signin_minute: Number(getSetting('signin_minute', 5)),
      keepalive_enabled: getSetting('keepalive_enabled', true),
      keepalive_interval_sec: Number(getSetting('keepalive_interval_sec', 900)),
      signin_preheat: getSetting('signin_preheat', true),
      client_ip: clientIp(req),
    });
  }
  if (path === '/settings' && method === 'POST') {
    const allow = ['default_model', 'model_alias', 'session_reuse', 'session_ttl_sec', 'session_pool_max', 'system_prompt_mode', 'request_timeout_ms', 'max_concurrency', 'signin_enabled', 'signin_hour', 'signin_minute', 'keepalive_enabled', 'keepalive_interval_sec', 'signin_preheat'];
    for (const [k, v] of Object.entries(body || {})) {
      if (allow.includes(k)) setSetting(k, v);
    }
    if (body?.reset_sessions) clearAllSessions();
    // 签到时间或开关变了要重排定时器
    if ('signin_enabled' in (body || {}) || 'signin_hour' in (body || {}) || 'signin_minute' in (body || {}) || 'signin_preheat' in (body || {})) {
      startSigninScheduler();
    }
    // 保活开关或间隔变了要重排定时器
    if ('keepalive_enabled' in (body || {}) || 'keepalive_interval_sec' in (body || {})) {
      startKeepalive();
    }
    return json(res, 200, { ok: true });
  }

  /* -------- 账号保活 -------- */
  if (path === '/keepalive/status' && method === 'GET') {
    return json(res, 200, keepaliveStatus());
  }
  if (path === '/keepalive/run' && method === 'POST') {
    try {
      const r = await runKeepalive({ source: 'manual', force: true });
      if (r?.skipped === 'busy') return bad(res, '已有一轮保活正在执行', 429);
      return json(res, 200, r);
    } catch (e) {
      return bad(res, e.message, 502);
    }
  }

  // 签到：查看调度状态与今日各账号结果
  if (path === '/signin/status' && method === 'GET') {
    const st = signinStatus();
    const day = st.today;
    const accounts = listAccounts().map((a) => {
      const today = getSigninToday(day, a.id);
      return {
        id: a.id, name: a.name, enabled: a.enabled,
        today: today ? { ok: today.ok, credit: today.credit, claimed: today.claimed, errors: today.errors } : null,
      };
    });
    return json(res, 200, { ...st, accounts });
  }

  // 签到：立即手动执行一轮（忽略「今天已签」的跳过判定由 runSignin 内部决定）
  if (path === '/signin/run' && method === 'POST') {
    try {
      const batch = await runOnce('manual');
      if (batch?.skipped === 'busy') return bad(res, '已有一轮签到正在执行', 429);
      return json(res, 200, batch);
    } catch (e) {
      return bad(res, e.message, 502);
    }
  }

  // 签到：历史记录
  if (path === '/signin/logs' && method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
    return json(res, 200, listSigninLogs({ limit }));
  }
  if (path === '/sessions/clear' && method === 'POST') {
    clearAllSessions();
    return json(res, 200, { ok: true });
  }
  // 释放上游真正挂着的会话：上游同时对同一账号只允许 3 个并发会话，
  // 攒满后所有请求都会 429，需要一键清空来恢复。
  if (path === '/sessions/purge' && method === 'POST') {
    const acc = body?.account_id ? getAccount(Number(body.account_id)) : listAccounts().find((a) => a.enabled);
    if (!acc) return bad(res, '没有可用账号', 400);
    clearAllSessions();
    let removed = 0;
    try {
      const list = await listSessions(acc, { pageSize: 100 });
      const arr = Array.isArray(list) ? list : [];
      for (const s of arr.filter((x) => x.status === 'ACTIVE')) {
        try { await deleteSession(acc, s.session_id); removed += 1; } catch { /* 单条失败继续 */ }
      }
    } catch (e) {
      return bad(res, `拉取上游会话失败：${e.message}`, 502);
    }
    return json(res, 200, { ok: true, removed });
  }

  /* -------- 上游探测 -------- */
  if (path === '/upstream/sessions' && method === 'GET') {
    const acc = listAccounts().find((a) => a.enabled);
    if (!acc) return bad(res, '没有可用账号', 400);
    const rows = await listSessions(acc, { pageNum: 1, pageSize: 50 });
    return json(res, 200, { sessions: rows });
  }

  return bad(res, '接口不存在', 404);
}

function requireAuthSoft(req) {
  try {
    // 仅用于 /api/public 的轻量判断，避免 401 覆盖登录页
    const { getSessionUser } = AUTH;
    return getSessionUser(req);
  } catch { return null; }
}

// 延迟引入，避免循环依赖时的初始化顺序问题
import * as AUTH from './auth.js';

async function syncAccount(id) {
  const acc = getAccount(id);
  if (!acc) return { ok: false, error: '账号不存在' };
  try {
    const me = await fetchMe(acc);
    const models = await fetchModels(acc);
    const ids = models.map((m) => m.id);
    updateAccount(id, { models_json: JSON.stringify(ids), last_check: Date.now(), state: 'ok', state_msg: '' });
    if (ids.length) {
      const detail = models.map((m) => ({
        id: m.id, name: m.name, context: m.context, maxTokens: m.maxTokens, type: m.type, desc: m.desc,
      }));
      db.prepare("INSERT INTO settings(k,v) VALUES('model_cache',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
        .run(JSON.stringify({ ts: Date.now(), list: ids, detail }));
    }
    markAccountResult(id, true, '');
    db.prepare('UPDATE accounts SET keepalive_fail = 0 WHERE id = ?').run(id);
    return { ok: true, me, models };
  } catch (e) {
    // 校验失败时不能让熔断状态倒退：登录态失效的账号如果被写成 'error'，
    // pickAccount 会重新把它选进池子，每个请求又白打一次上游
    if (isAuthError(e)) {
      markAccountInvalid(id, e.message);
    } else {
      updateAccount(id, { last_check: Date.now(), state: 'error', state_msg: e.message });
    }
    return { ok: false, error: e.message, status: e.status || 0 };
  }
}

export { syncAccount };
