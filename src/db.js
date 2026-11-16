import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { DB_FILE, CONFIG } from './config.js';

export const db = new DatabaseSync(DB_FILE);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  group_name TEXT DEFAULT 'default',
  cookie TEXT NOT NULL,
  cftk TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  state TEXT DEFAULT 'unknown',
  state_msg TEXT DEFAULT '',
  weight INTEGER DEFAULT 1,
  note TEXT DEFAULT '',
  expire_at INTEGER DEFAULT 0,
  models_json TEXT DEFAULT '[]',
  last_check INTEGER DEFAULT 0,
  last_used INTEGER DEFAULT 0,
  ok_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  secret TEXT NOT NULL UNIQUE,
  enabled INTEGER DEFAULT 1,
  quota INTEGER DEFAULT 0,
  used_tokens INTEGER DEFAULT 0,
  used_requests INTEGER DEFAULT 0,
  expire_at INTEGER DEFAULT 0,
  ip_whitelist TEXT DEFAULT '',
  model_whitelist TEXT DEFAULT '',
  max_ips INTEGER DEFAULT 0,
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS call_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  key_id INTEGER,
  key_name TEXT DEFAULT '',
  account_id INTEGER,
  account_name TEXT DEFAULT '',
  model TEXT DEFAULT '',
  endpoint TEXT DEFAULT '',
  status INTEGER DEFAULT 200,
  stream INTEGER DEFAULT 0,
  latency_ms INTEGER DEFAULT 0,
  first_token_ms INTEGER DEFAULT 0,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  ip TEXT DEFAULT '',
  error TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON call_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_key ON call_logs(key_id);

CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  key_id INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  requests INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  PRIMARY KEY (day, key_id, model)
);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS key_ips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id INTEGER NOT NULL,
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keyips ON key_ips(key_id, ip);

CREATE TABLE IF NOT EXISTS ip_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  cidr TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS signin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,
  account_id INTEGER,
  account_name TEXT DEFAULT '',
  ok INTEGER DEFAULT 0,
  claimed_json TEXT DEFAULT '[]',
  skipped_json TEXT DEFAULT '[]',
  errors_json TEXT DEFAULT '[]',
  credit INTEGER DEFAULT 0,
  source TEXT DEFAULT 'auto'
);
CREATE INDEX IF NOT EXISTS idx_signin_day ON signin_logs(day DESC, account_id);
`);

/* 轻量迁移：老库缺列就补上，避免升级后启动即报错。 */
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

// 保活状态：上次心跳时间与连续失败次数（连续失败到阈值才判失效，避免一次网络抖动就熔断）
ensureColumn('accounts', 'last_keepalive', 'INTEGER DEFAULT 0');
ensureColumn('accounts', 'keepalive_fail', 'INTEGER DEFAULT 0');

const now = () => Date.now();

export function getSetting(k, def = null) {
  const row = db.prepare('SELECT v FROM settings WHERE k = ?').get(k);
  if (!row) return def;
  try { return JSON.parse(row.v); } catch { return row.v; }
}

export function setSetting(k, v) {
  db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
    .run(k, JSON.stringify(v));
}

export function seedSettings() {
  const defaults = {
    default_model: '',
    model_alias: {},
    request_timeout_ms: CONFIG.requestTimeoutMs,
    max_concurrency: CONFIG.maxConcurrency,
    session_reuse: true,
    session_ttl_sec: 600,
    // 每个账号在途的上游会话上限，超出时回收最久未用的空闲会话
    session_pool_max: 3,
    agent_mode: true,
    system_prompt_mode: 'merge',
    log_body: false,
    // 每日签到：默认开启，北京时间每天 signin_hour 点执行一次
    signin_enabled: true,
    signin_hour: 8,
    signin_minute: 5,
    // 账号保活：上游会话是空闲超时（实测约 1~1.5 小时），定时打心跳把计时器推后
    keepalive_enabled: true,
    keepalive_interval_sec: 900,
    // 签到前先保活一次，否则 24 小时一次的调度触发时会话早已超时
    signin_preheat: true,
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (getSetting(k) === null) setSetting(k, v);
  }
  if (!getSetting('admin_password_hash')) {
    setSetting('admin_password_hash', hashPassword(CONFIG.adminPassword));
  }
  if (!getSetting('session_secret')) {
    setSetting('session_secret', crypto.randomBytes(32).toString('hex'));
  }
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `${salt}:${h}`;
}

export function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const calc = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(h, 'hex'));
}

/* ---------------- accounts ---------------- */

export function listAccounts() {
  return db.prepare('SELECT * FROM accounts ORDER BY id ASC').all().map(mapAccount);
}

export function mapAccount(r) {
  if (!r) return null;
  return {
    ...r,
    enabled: !!r.enabled,
    models: safeParse(r.models_json, []),
    cookie: r.cookie,
    cookieTail: tail(r.cookie),
  };
}

export function getAccount(id) {
  return mapAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
}

export function pickAccount(model) {
  const rows = db.prepare(
    `SELECT * FROM accounts WHERE enabled = 1 AND state != 'invalid' ORDER BY last_used ASC, id ASC`
  ).all();
  if (!rows.length) return null;
  const withModel = rows.filter((r) => {
    const ms = safeParse(r.models_json, []);
    return !model || ms.length === 0 || ms.includes(model);
  });
  const pool = withModel.length ? withModel : rows;
  const picked = pool[0];
  db.prepare('UPDATE accounts SET last_used = ? WHERE id = ?').run(now(), picked.id);
  return mapAccount(picked);
}

export function createAccount({ name, cookie, cftk = '', group_name = 'default', note = '', expire_at = 0, weight = 1 }) {
  const info = db.prepare(
    `INSERT INTO accounts(name, group_name, cookie, cftk, note, expire_at, weight, created_at)
     VALUES(?,?,?,?,?,?,?,?)`
  ).run(name, group_name, cookie, cftk, note, expire_at, weight, now());
  return getAccount(Number(info.lastInsertRowid));
}

export function updateAccount(id, patch) {
  const fields = [];
  const vals = [];
  for (const k of ['name', 'group_name', 'cookie', 'cftk', 'enabled', 'state', 'state_msg', 'weight', 'note', 'expire_at', 'models_json', 'last_check']) {
    if (patch[k] !== undefined) { fields.push(`${k} = ?`); vals.push(typeof patch[k] === 'boolean' ? Number(patch[k]) : patch[k]); }
  }
  if (!fields.length) return getAccount(id);
  vals.push(id);
  db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return getAccount(id);
}

export function deleteAccount(id) {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

/** 按名字找账号，导入 cookie 时用来判断是新增还是覆盖。 */
export function getAccountByName(name) {
  const r = db.prepare('SELECT * FROM accounts WHERE name = ?').get(name);
  return r ? mapAccount(r) : null;
}

/** 按名字有则更新、无则新建；导入工具用。 */
export function upsertAccount({ name, cookie, cftk = '', models = null }) {
  const exist = getAccountByName(name);
  if (exist) {
    return updateAccount(exist.id, {
      cookie,
      cftk,
      state: 'ok',
      state_msg: '',
      last_check: now(),
      ...(models ? { models_json: models } : {}),
    });
  }
  const created = createAccount({ name, cookie, cftk });
  return updateAccount(created.id, {
    state: 'ok',
    last_check: now(),
    ...(models ? { models_json: models } : {}),
  });
}

export function markAccountResult(id, ok, msg = '') {
  if (ok) {
    db.prepare("UPDATE accounts SET ok_count = ok_count + 1, state = 'ok', state_msg = ?, last_check = ?, keepalive_fail = 0 WHERE id = ?").run(msg, now(), id);
  } else {
    db.prepare("UPDATE accounts SET fail_count = fail_count + 1, state = 'error', state_msg = ?, last_check = ? WHERE id = ?").run(msg.slice(0, 500), now(), id);
  }
}

/**
 * 登录态失效：直接判死，不再参与选号。
 * 和 markAccountResult 分开，是因为「上游超时」「并发已满」这类失败重试有意义，
 * 而 Cookie 失效只能靠人工换 Cookie，继续选它只是把每个请求都白打一次上游。
 */
export function markAccountInvalid(id, msg = '') {
  db.prepare(
    "UPDATE accounts SET fail_count = fail_count + 1, state = 'invalid', state_msg = ?, last_check = ?, keepalive_fail = keepalive_fail + 1 WHERE id = ?"
  ).run(String(msg).slice(0, 500), now(), id);
}

/** 记一次保活结果（成功清零连续失败并解除熔断，失败累加）。 */
export function markKeepalive(id, ok, msg = '') {
  if (ok) {
    db.prepare("UPDATE accounts SET last_keepalive = ?, keepalive_fail = 0, state = 'ok', state_msg = '', last_check = ? WHERE id = ?")
      .run(now(), now(), id);
  } else {
    db.prepare('UPDATE accounts SET last_keepalive = ?, keepalive_fail = keepalive_fail + 1, state_msg = ? WHERE id = ?')
      .run(now(), String(msg).slice(0, 500), id);
  }
}

/** 账号池健康度：给网关短路和前端展示用。 */
export function poolStatus() {
  const rows = db.prepare('SELECT enabled, state FROM accounts').all();
  const total = rows.length;
  const enabled = rows.filter((r) => r.enabled).length;
  const invalid = rows.filter((r) => r.enabled && r.state === 'invalid').length;
  const usable = rows.filter((r) => r.enabled && r.state !== 'invalid').length;
  return { total, enabled, invalid, usable };
}

/* ---------------- keys ---------------- */

export function listKeys() {
  return db.prepare('SELECT * FROM api_keys ORDER BY id ASC').all().map(mapKey);
}

export function mapKey(r) {
  if (!r) return null;
  return {
    ...r,
    enabled: !!r.enabled,
    ip_whitelist: r.ip_whitelist ? r.ip_whitelist.split(',').map((s) => s.trim()).filter(Boolean) : [],
    model_whitelist: r.model_whitelist ? r.model_whitelist.split(',').map((s) => s.trim()).filter(Boolean) : [],
    secret_masked: r.secret.slice(0, 8) + '••••••••' + r.secret.slice(-4),
  };
}

export function createKey({ name, quota = 0, expire_at = 0, ip_whitelist = [], model_whitelist = [], note = '', max_ips = 0 }) {
  const secret = 'sk-ca-' + crypto.randomBytes(24).toString('hex');
  const info = db.prepare(
    `INSERT INTO api_keys(name, secret, quota, expire_at, ip_whitelist, model_whitelist, note, max_ips, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`
  ).run(name, secret, quota, expire_at, (ip_whitelist || []).join(','), (model_whitelist || []).join(','), note, max_ips, now());
  return { ...mapKey(db.prepare('SELECT * FROM api_keys WHERE id = ?').get(Number(info.lastInsertRowid))), secret };
}

export function updateKey(id, patch) {
  const fields = [];
  const vals = [];
  for (const k of ['name', 'enabled', 'quota', 'expire_at', 'note', 'max_ips', 'used_tokens', 'used_requests']) {
    if (patch[k] !== undefined) { fields.push(`${k} = ?`); vals.push(typeof patch[k] === 'boolean' ? Number(patch[k]) : patch[k]); }
  }
  for (const k of ['ip_whitelist', 'model_whitelist']) {
    if (patch[k] !== undefined) { fields.push(`${k} = ?`); vals.push((patch[k] || []).join(',')); }
  }
  if (fields.length) {
    vals.push(id);
    db.prepare(`UPDATE api_keys SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  }
  return mapKey(db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id));
}

export function deleteKey(id) {
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  db.prepare('DELETE FROM key_ips WHERE key_id = ?').run(id);
}

export function findKeyBySecret(secret) {
  return mapKey(db.prepare('SELECT * FROM api_keys WHERE secret = ?').get(secret));
}

export function getKey(id) {
  return mapKey(db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id));
}

export function touchKeyIp(keyId, ip) {
  const exists = db.prepare('SELECT id FROM key_ips WHERE key_id = ? AND ip = ?').get(keyId, ip);
  if (!exists) db.prepare('INSERT INTO key_ips(key_id, ip, ts) VALUES(?,?,?)').run(keyId, ip, now());
}

export function countKeyIps(keyId) {
  return db.prepare('SELECT COUNT(DISTINCT ip) AS c FROM key_ips WHERE key_id = ?').get(keyId).c;
}

export function bumpKeyUsage(keyId, tokens) {
  db.prepare('UPDATE api_keys SET used_tokens = used_tokens + ?, used_requests = used_requests + 1, last_used = ? WHERE id = ?')
    .run(tokens, now(), keyId);
}

/* ---------------- logs & usage ---------------- */

export function insertLog(row) {
  db.prepare(
    `INSERT INTO call_logs(ts,key_id,key_name,account_id,account_name,model,endpoint,status,stream,latency_ms,first_token_ms,prompt_tokens,completion_tokens,total_tokens,ip,error)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.ts ?? now(), row.key_id ?? null, row.key_name ?? '', row.account_id ?? null, row.account_name ?? '',
    row.model ?? '', row.endpoint ?? '', row.status ?? 200, row.stream ? 1 : 0,
    row.latency_ms ?? 0, row.first_token_ms ?? 0, row.prompt_tokens ?? 0, row.completion_tokens ?? 0,
    row.total_tokens ?? 0, row.ip ?? '', (row.error ?? '').slice(0, 2000)
  );
}

export function bumpUsage(day, keyId, model, { ok = true, pt = 0, ct = 0 } = {}) {  db.prepare(
    `INSERT INTO usage_daily(day,key_id,model,requests,errors,prompt_tokens,completion_tokens,total_tokens)
     VALUES(?,?,?,1,?,?,?,?)
     ON CONFLICT(day,key_id,model) DO UPDATE SET
       requests = requests + 1,
       errors = errors + excluded.errors,
       prompt_tokens = prompt_tokens + excluded.prompt_tokens,
       completion_tokens = completion_tokens + excluded.completion_tokens,
       total_tokens = total_tokens + excluded.total_tokens`
  ).run(day, keyId ?? 0, model ?? '', ok ? 0 : 1, pt, ct, pt + ct);
}

export function queryLogs({ limit = 50, offset = 0, keyId, model, status, q } = {}) {
  const where = [];
  const vals = [];
  if (keyId) { where.push('key_id = ?'); vals.push(keyId); }
  if (model) { where.push('model = ?'); vals.push(model); }
  if (status === 'error') where.push('status >= 400');
  if (status === 'ok') where.push('status < 400');
  if (q) { where.push('(model LIKE ? OR ip LIKE ? OR account_name LIKE ? OR error LIKE ?)'); vals.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM call_logs ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...vals, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM call_logs ${w}`).get(...vals).c;
  return { rows, total };
}

export function statsOverview() {
  const t = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(total_tokens),0) tok, COALESCE(SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END),0) err FROM call_logs').get();
  const today = new Date().toISOString().slice(0, 10);
  const td = db.prepare('SELECT COALESCE(SUM(requests),0) r, COALESCE(SUM(total_tokens),0) tok, COALESCE(SUM(errors),0) e FROM usage_daily WHERE day = ?').get(today);
  const acc = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(enabled),0) en, COALESCE(SUM(CASE WHEN state='error' THEN 1 ELSE 0 END),0) bad FROM accounts").get();
  const keys = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(enabled),0) en FROM api_keys').get();
  return {
    today: { requests: td.r, tokens: td.tok, errors: td.e },
    total: { requests: t.c, tokens: t.tok, errors: t.err },
    accounts: { total: acc.c, enabled: acc.en, error: acc.bad },
    keys: { total: keys.c, enabled: keys.en },
  };
}

export function usageSeries(days = 14) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return db.prepare(
    `SELECT day, SUM(requests) requests, SUM(errors) errors, SUM(prompt_tokens) pt, SUM(completion_tokens) ct, SUM(total_tokens) tt
     FROM usage_daily WHERE day >= ? GROUP BY day ORDER BY day ASC`
  ).all(since);
}

export function usageByModel(days = 14) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return db.prepare(
    `SELECT model, SUM(requests) requests, SUM(errors) errors, SUM(total_tokens) tt
     FROM usage_daily WHERE day >= ? GROUP BY model ORDER BY tt DESC LIMIT 20`
  ).all(since);
}

export function usageByHour(hours = 24) {
  const since = now() - hours * 3600000;
  const rows = db.prepare(
    `SELECT CAST(ts/3600000 AS INTEGER) h, COUNT(*) c, COALESCE(SUM(total_tokens),0) tok,
            COALESCE(AVG(NULLIF(first_token_ms,0)),0) ft
     FROM call_logs WHERE ts >= ? GROUP BY h ORDER BY h ASC`
  ).all(since);
  return rows.map((r) => ({ hour: r.h * 3600000, requests: r.c, tokens: r.tok, firstTokenMs: Math.round(r.ft) }));
}

export function safeParse(s, def) {
  try { return JSON.parse(s); } catch { return def; }
}

/* ------------------------------ 签到记录 ------------------------------ */

/** 记一条签到结果。成功与失败都记，便于前端展示历史与排查。 */
export function logSignin({ day, accountId, accountName, result, source = 'auto' }) {
  const claimed = result?.claimed || [];
  const errors = result?.errors || [];
  db.prepare(
    `INSERT INTO signin_logs(ts,day,account_id,account_name,ok,claimed_json,skipped_json,errors_json,credit,source)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).run(
    Date.now(), day, accountId ?? 0, accountName || '',
    errors.length === 0 ? 1 : 0,
    JSON.stringify(claimed),
    JSON.stringify(result?.skipped || []),
    JSON.stringify(errors),
    result?.total || 0,
    source
  );
}

/** 查今天的签到记录；没记录返回 null。 */
export function getSigninToday(day, accountId) {
  const r = db.prepare('SELECT * FROM signin_logs WHERE day = ? AND account_id = ? ORDER BY id DESC LIMIT 1').get(day, accountId);
  return r ? mapSignin(r) : null;
}

export function listSigninLogs({ limit = 50 } = {}) {
  return db.prepare('SELECT * FROM signin_logs ORDER BY id DESC LIMIT ?').all(limit).map(mapSignin);
}

function mapSignin(r) {
  return {
    id: r.id,
    ts: r.ts,
    day: r.day,
    accountId: r.account_id,
    accountName: r.account_name,
    ok: !!r.ok,
    claimed: safeParse(r.claimed_json, []),
    skipped: safeParse(r.skipped_json, []),
    errors: safeParse(r.errors_json, []),
    credit: r.credit,
    source: r.source,
  };
}

function tail(cookie) {
  if (!cookie) return '';
  const m = cookie.match(/(?:SessionID|cbc-sid|vk)=([^;]{4,})/);
  return m ? m[1].slice(0, 6) + '…' : '••••';
}
