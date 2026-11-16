/**
 * 每日签到（福利中心）协议客户端。
 *
 * 与 cloudagent 对话链路无关，是独立的一组接口，前缀 /chat 下的 PromptCenterService：
 *   GET  /PromptCenterService/v1/ops/delivery?channel=WEB   列出全部活动与领取状态
 *   POST /PromptCenterService/v1/ops/events/trigger         触发事件（user.login 等）让签到权益生成
 *   POST /PromptCenterService/v1/ops/claim                  领取某个活动的积分
 *   POST /PromptCenterService/v1/ops/confirm                确认到账
 *   POST /PromptCenterService/v1/ops/events/conversation    上报对话行为（任务型活动用）
 *
 * 签到实际是两步：先 trigger user.login 触发当天的权益投递，再在 delivery 里
 * 挑 status=ELIGIBLE 的活动 claim。只 claim 不 trigger 会一直是「尚未到达权益刷新时间」。
 *
 * 鉴权与对话接口相同（Cookie + cftk），但 Agent-Type 要换成 PromptCenter。
 */
import { CONFIG } from './config.js';
import { UpstreamError, emitCftkRotate } from './upstream.js';

const BASE = CONFIG.upstreamBase;
const OPS = '/PromptCenterService/v1';

/** 签到接口专用的请求头：Agent-Type 与对话链路不同，用错会被拒。 */
function signHeaders(account) {
  const cookie = String(account?.cookie || '').replace(/[^\t\x20-\x7E\x80-\xFF]/g, '').trim();
  const m = cookie.match(/(?:^|;\s*)([A-Za-z0-9_]*cftk)=([^;]+)/i);
  const cftk = account?.cftk || (m ? decodeURIComponent(m[2]) : '');
  return {
    'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'x-codearts-doer-scenario-type': 'web',
    'Agent-Type': 'PromptCenter',
    'X-Language': 'zh-cn',
    Accept: 'application/json, text/plain, */*',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    Cookie: cookie,
    ...(cftk ? { cftk } : {}),
  };
}

/** 上游统一返回 {code, message, data}，code 0/200 或带 data 视为成功。 */
async function call(account, path, { method = 'GET', body, timeout = 20000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('signin timeout')), timeout);
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: signHeaders(account),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
      redirect: 'manual',
    });
  } catch (e) {
    clearTimeout(timer);
    throw new UpstreamError(e.name === 'AbortError' ? '签到接口超时' : `签到接口连接失败：${e.message}`, { status: 0 });
  }
  clearTimeout(timer);

  // cftk 会随响应轮转，取到新值回写，否则下一次请求鉴权失败
  const sc = res.headers.get('set-cookie') || '';
  const mm = sc.match(/devclouddevuibjtcftk=([^;,\s]+)/i);
  if (mm && mm[1] && account && account.cftk !== mm[1]) {
    account.cftk = mm[1];
    // 走和对话链路同一个回写通道，否则签到轮转出的新 cftk 只活在内存里，
    // 下次对话拿旧 cftk 就会 csrf validate fail
    emitCftkRotate(account, mm[1]);
  }

  const redirect = res.headers.get('hw-ajax-redirect');
  if (redirect) {
    throw new UpstreamError('上游登录态失效，请更新账号 Cookie', { status: 401, code: 'AUTH_REDIRECT' });
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamError('上游鉴权失败（401/403），Cookie 或 cftk 可能已过期', { status: res.status, raw: text.slice(0, 300) });
  }
  if (!res.ok) {
    throw new UpstreamError(`签到接口返回 ${res.status}：${text.slice(0, 300)}`, { status: res.status });
  }
  let j;
  try { j = JSON.parse(text); } catch {
    throw new UpstreamError(`签到接口返回非 JSON：${text.slice(0, 200)}`, { status: 502 });
  }
  return j;
}

/** 幂等键：网页端签到用 `login-YYYYMMDD-随机`，领取用含时间戳的串。 */
function dayKey() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** 拉取活动列表（签到、注册礼、任务等全在里面）。 */
export async function fetchBenefits(account) {
  const j = await call(account, `${OPS}/ops/delivery?channel=WEB`);
  const data = j?.data || {};
  return { items: Array.isArray(data.items) ? data.items : [], serverTime: data.serverTime || 0 };
}

/** 触发事件。签到对应 triggerEvent='user.login'，触发后当天权益才会投递。 */
export async function triggerEvent(account, triggerEvent = 'user.login', extra = {}, idempotentKey) {
  const body = {
    triggerEvent,
    channel: 'WEB',
    idempotentKey: idempotentKey || `login-${dayKey()}-${Math.random().toString(36).slice(2, 8)}`,
    ...extra,
  };
  return call(account, `${OPS}/ops/events/trigger`, { method: 'POST', body });
}

/** 领取某个活动的权益。 */
export async function claimBenefit(account, campaignId, benefitId) {
  const body = {
    campaignId,
    idempotentKey: `claim-${campaignId}-${Date.now()}`,
    channel: 'WEB',
  };
  if (benefitId != null) body.benefitId = benefitId;
  return call(account, `${OPS}/ops/claim`, { method: 'POST', body });
}

/** 确认到账（部分活动领取后需再 confirm 一次）。 */
export async function confirmBenefit(account, campaignId) {
  return call(account, `${OPS}/ops/confirm`, { method: 'POST', body: { campaignId } });
}

/**
 * 判断一次 claim 的结果。
 * 上游把业务错误也放在 HTTP 200 里，必须看 code：
 *   0/200 且 data 非空  -> 领取成功
 *   40001 且提示刷新时间 -> 今天已经签过，属正常
 * 其它都算失败，原文带回便于排查。
 */
export function classifyClaimResult(j) {
  const code = j?.code;
  const msg = String(j?.message || '');
  if (code === 0 || code === 200) return { ok: true, message: msg || 'ok' };
  if (code === 40001 && /刷新时间|已经领取|已领取|already/i.test(msg)) {
    return { ok: true, already: true, message: msg };
  }
  return { ok: false, message: msg || `code=${code}`, code };
}

/**
 * 对一个账号执行一次完整签到：
 *   1) trigger user.login（让当天权益投递）
 *   2) 拉活动列表，挑出 status=ELIGIBLE 的
 *   3) 逐个 claim，必要时 confirm
 * 返回结构化结果，供定时任务与接口复用。
 */
export async function runSignin(account, { detail = false } = {}) {
  const out = { account: account.name, triggered: false, claimed: [], skipped: [], errors: [], total: 0 };

  // 1) 触发事件。失败不致命：可能今天已经触发过，后面看列表状态即可。
  try {
    const t = await triggerEvent(account, 'user.login');
    out.triggered = true;
    if (t?.code !== 0 && t?.code !== 200 && detail) {
      out.triggered = false;
      out.errors.push(`trigger: code=${t?.code} ${t?.message || ''}`);
    }
  } catch (e) {
    out.errors.push(`trigger: ${e.message}`);
  }

  // 2) 拉列表
  const { items } = await fetchBenefits(account);
  if (!items.length) {
    out.errors.push('活动列表为空（可能登录态异常）');
    return out;
  }

  // 3) 逐个领取。ELIGIBLE 才可领；其余按状态归类，便于前端展示。
  for (const it of items) {
    const id = it.campaignId;
    const title = it.title || `活动${id}`;
    if (it.status !== 'ELIGIBLE') {
      out.skipped.push({ id, title, status: it.status || (it.claimable ? 'CLAIMABLE' : '-'), amount: it.benefitAmount });
      continue;
    }
    try {
      const r = await claimBenefit(account, id);
      const c = classifyClaimResult(r);
      if (c.ok) {
        out.claimed.push({ id, title, amount: it.benefitAmount, already: !!c.already, message: c.message });
        out.total += it.benefitAmount || 0;
        // 领取成功后确认到账；失败不影响结果
        await confirmBenefit(account, id).catch(() => {});
      } else {
        out.errors.push(`${title}: ${c.message}`);
      }
    } catch (e) {
      out.errors.push(`${title}: ${e.message}`);
    }
  }

  return out;
}
