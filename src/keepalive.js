/**
 * 账号保活。
 *
 * 上游登录态是「空闲超时」判定的：一段时间不请求就作废，实测窗口约 1~1.5 小时。
 * 定时打一次最轻的鉴权接口（GET /rest/me）就能把计时器推后，代价是每个账号每轮一个请求。
 *
 * 几个刻意的取舍：
 *   - 心跳接口选 /rest/me：它和账号校验走同一条路径，日志里看到的就是「还活着」；
 *   - 连续 N 次失败才判死：单次超时/网络抖动不该把账号熔断掉；
 *   - 判定失效后状态写 'invalid'，pickAccount 会跳过它，避免每个请求都白打一次上游；
 *   - 刚被业务请求用过的账号本轮跳过，别让心跳和真实请求抢上游配额。
 */
import { listAccounts, getSetting, markKeepalive, markAccountInvalid, db } from './db.js';
import { probeAccount, isAuthError } from './upstream.js';

// 连续失败到这个次数才认定登录态真的没了
const FAIL_THRESHOLD = 2;

let timer = null;
let running = false;
let lastRun = null;

function intervalMs() {
  const sec = Number(getSetting('keepalive_interval_sec', 900)) || 900;
  // 下限 60 秒：再密就是拿上游当靶子打，也没必要
  return Math.max(60, sec) * 1000;
}

/** 对一个账号做一次探活，结果落库。 */
export async function probeOnce(account) {
  try {
    await probeAccount(account);
    // 探活成功即视为登录态恢复：markKeepalive 会把之前熔断的 invalid 拉回 ok
    markKeepalive(account.id, true);
    return { id: account.id, name: account.name, ok: true };
  } catch (e) {
    const auth = isAuthError(e);
    markKeepalive(account.id, false, e.message);
    const row = db.prepare('SELECT keepalive_fail FROM accounts WHERE id = ?').get(account.id);
    const fails = row?.keepalive_fail || 1;
    if (auth || fails >= FAIL_THRESHOLD) {
      markAccountInvalid(account.id, e.message);
    }
    return { id: account.id, name: account.name, ok: false, auth, fails, error: e.message };
  }
}

/**
 * 对全部启用账号跑一轮保活。
 * @param {object} opts
 * @param {string} opts.source    'auto' | 'manual' | 'preheat'
 * @param {boolean} opts.force    true 时不跳过刚活跃过的账号
 */
export async function runKeepalive({ source = 'auto', force = false } = {}) {
  if (running) return { skipped: 'busy' };
  running = true;
  const startedAt = Date.now();
  const skipWindow = intervalMs() / 2;
  const results = [];
  try {
    const accounts = listAccounts().filter((a) => a.enabled);
    for (const acc of accounts) {
      // 刚被真实请求用过，会话本来就是热的，这轮不必再打
      if (!force && acc.last_used && startedAt - acc.last_used < skipWindow) {
        results.push({ id: acc.id, name: acc.name, ok: true, skipped: 'recent' });
        continue;
      }
      results.push(await probeOnce(acc));
    }
    lastRun = { ts: Date.now(), source, results };
    return lastRun;
  } finally {
    running = false;
  }
}

function scheduleNext() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!getSetting('keepalive_enabled', true)) return;

  const wait = intervalMs();
  timer = setTimeout(async () => {
    try {
      const batch = await runKeepalive({ source: 'auto' });
      const bad = (batch.results || []).filter((r) => r.ok === false);
      if (bad.length) {
        console.warn(`[保活] ${bad.length} 个账号探活失败：${bad.map((b) => `${b.name}(${b.error})`).join('；')}`);
      }
    } catch (e) {
      console.error('[保活] 执行异常：', e.message);
    }
    scheduleNext();
  }, wait);
  if (timer.unref) timer.unref();
}

/** 启动保活（重复调用安全，会重置定时器）。 */
export function startKeepalive() {
  const enabled = getSetting('keepalive_enabled', true);
  scheduleNext();
  if (enabled) {
    console.log(`  账号保活   已启用，每 ${Math.round(intervalMs() / 1000)} 秒心跳一次`);
  } else {
    console.log('  账号保活   已关闭');
  }
}

export function stopKeepalive() {
  if (timer) clearTimeout(timer);
  timer = null;
}

export function keepaliveStatus() {
  const accounts = listAccounts().map((a) => ({
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    state: a.state,
    last_keepalive: a.last_keepalive || 0,
    keepalive_fail: a.keepalive_fail || 0,
  }));
  return {
    enabled: !!getSetting('keepalive_enabled', true),
    interval_sec: Math.round(intervalMs() / 1000),
    signin_preheat: !!getSetting('signin_preheat', true),
    nextAt: getSetting('keepalive_enabled', true) ? Date.now() + intervalMs() : 0,
    running,
    lastRun,
    accounts,
  };
}
