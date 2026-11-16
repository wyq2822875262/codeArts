/**
 * 每日签到调度器。
 *
 * 设计要点：
 *   - 单进程内定时器，不引入外部 cron 依赖；服务重启后会重新计算下一次触发时间。
 *   - 每天只真正跑一次（以「当天是否已有成功记录」判定），失败则按退避重试。
 *   - 上游把「今天已签过」也当作正常返回，所以重试不会重复领积分。
 *   - 时间按北京时间（UTC+8）计算，与用户认知一致；服务器时区无关。
 */
import { getSetting, listAccounts, logSignin, getSigninToday } from './db.js';
import { runSignin } from './signin.js';
import { runKeepalive } from './keepalive.js';

const RETRY_DELAYS = [10 * 60e3, 30 * 60e3, 60 * 60e3, 3 * 60 * 60e3]; // 10m, 30m, 1h, 3h
let timer = null;
let retryCount = 0;
let lastRun = null;
let running = false;

/** 北京时间当天日期串 YYYY-MM-DD，作为「今天是否已签」的键。 */
export function beijingDay(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600e3);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** 距离下一个北京时间 HH:MM 还有多少毫秒。 */
export function msUntilNext(hour, minute, now = Date.now()) {
  const bj = now + 8 * 3600e3;
  const d = new Date(bj);
  const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0, 0);
  let diff = target - bj;
  if (diff <= 0) diff += 24 * 3600e3;
  return diff;
}

/** 对所有启用账号跑一轮签到，逐账号落库。 */
export async function runOnce(source = 'auto') {
  if (running) return { skipped: 'busy' };
  running = true;
  const day = beijingDay();
  const accounts = listAccounts().filter((a) => a.enabled);
  const results = [];
  try {
    // 签到调度是 24 小时一次，而上游会话是空闲超时（约 1~1.5 小时）。
    // 不先热身的话，等到触发那一刻 Cookie 早就凉了，签到必然全失败。
    if (getSetting('signin_preheat', true) && accounts.length) {
      await runKeepalive({ source: 'preheat', force: true }).catch(() => { /* 热身失败不阻塞签到 */ });
    }
    for (const acc of accounts) {
      // 当天已成功签过就跳过，避免重复请求上游
      const today = getSigninToday(day, acc.id);
      if (today && today.ok) {
        results.push({ account: acc.name, skipped: 'already' });
        continue;
      }
      try {
        const r = await runSignin(acc, { detail: true });
        logSignin({ day, accountId: acc.id, accountName: acc.name, result: r, source });
        results.push(r);
      } catch (e) {
        const fail = { account: acc.name, claimed: [], skipped: [], errors: [e.message], total: 0 };
        logSignin({ day, accountId: acc.id, accountName: acc.name, result: fail, source });
        results.push(fail);
      }
    }
    lastRun = { ts: Date.now(), day, source, results };
    return lastRun;
  } finally {
    running = false;
  }
}

/** 本轮是否全部无错；有错则安排退避重试。 */
function allOk(batch) {
  if (!batch?.results?.length) return true;
  return batch.results.every((r) => r.skipped === 'already' || !(r.errors && r.errors.length));
}

function scheduleNext() {
  if (timer) clearTimeout(timer);
  timer = null;
  const enabled = getSetting('signin_enabled', true);
  if (!enabled) return;

  const hour = Number(getSetting('signin_hour', 8)) || 8;
  const minute = Number(getSetting('signin_minute', 5)) || 0;
  const delay = msUntilNext(hour, minute);

  timer = setTimeout(async () => {
    let batch = null;
    try {
      batch = await runOnce('auto');
      if (!allOk(batch) && retryCount < RETRY_DELAYS.length) {
        const wait = RETRY_DELAYS[retryCount++];
        console.warn(`[签到] 本轮有失败，${Math.round(wait / 60000)} 分钟后重试（第 ${retryCount} 次）`);
        timer = setTimeout(() => { scheduleNext(); }, wait);
        return;
      }
      retryCount = 0;
    } catch (e) {
      console.error('[签到] 执行异常：', e.message);
    }
    scheduleNext();
  }, delay);

  if (timer.unref) timer.unref();
}

/** 启动调度。重复调用安全（会重置定时器）。 */
export function startSigninScheduler() {
  scheduleNext();
  const enabled = getSetting('signin_enabled', true);
  const hour = Number(getSetting('signin_hour', 8)) || 8;
  const minute = Number(getSetting('signin_minute', 5)) || 0;
  if (enabled) {
    const next = new Date(Date.now() + msUntilNext(hour, minute));
    console.log(`  每日签到   已启用，北京时区每天 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}（下次 ${beijingDay(next.getTime())} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}）`);
  } else {
    console.log('  每日签到   已关闭');
  }
}

/** 停止调度（测试与进程退出用）。 */
export function stopSigninScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
}

export function signinStatus() {
  const enabled = !!getSetting('signin_enabled', true);
  const hour = Number(getSetting('signin_hour', 8)) || 8;
  const minute = Number(getSetting('signin_minute', 5)) || 0;
  return {
    enabled,
    hour,
    minute,
    nextAt: enabled ? Date.now() + msUntilNext(hour, minute) : 0,
    retryCount,
    lastRun,
    today: beijingDay(),
  };
}
