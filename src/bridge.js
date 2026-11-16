/**
 * 桥接层：OpenAI 请求体 <-> 码道上游会话/SSE
 *
 * 上游事件（event: xxx / data: {...}）语义：
 *   status        {status:processing|retry|..., message, attempt}
 *   thought       {part_id, content, subagent_id}        思维链增量
 *   message       {part_id, content, message_type}        正文增量
 *   tool_call     {part_id, call_id, tool, title, input}  工具调用
 *   tool_result   {part_id, tool, status, result, error}  工具结果
 *   step_finish   {reason, tokens, cost}                  单步结束（带 token 用量）
 *   file_diff     {diff: [{file, before, after}]}          文件变更
 *   question      {call_id, question_id, ...}              需要用户回答
 *   done          {message_id, tokens, latency_ms, credit_cost_for_web, turn_id}
 *   error         {type, error, error_code}
 *   stopped       {partial_message_id}
 */
import { CONFIG } from './config.js';
import crypto from 'node:crypto';
import {
  createSession, promptStream, parseSse, stopSession, replyQuestion, UpstreamError,
  deleteSession, setCftkRotateHandler, patchCookieCftk, isAuthError,
} from './upstream.js';
import { db, getSetting, pickAccount, markAccountResult, markAccountInvalid, poolStatus } from './db.js';

// 上游每次响应都可能轮转 cftk，落库后再用于下一次请求
setCftkRotateHandler((account, cftk) => {
  if (!account?.id) return;
  const cookie = patchCookieCftk(account.cookie || '', cftk);
  account.cookie = cookie;
  updateAccountQuiet(account.id, cftk, cookie);
});

function updateAccountQuiet(id, cftk, cookie) {
  try {
    db.prepare('UPDATE accounts SET cftk = ?, cookie = ?, last_used = ? WHERE id = ?')
      .run(cftk, cookie, Date.now(), id);
  } catch { /* 写库失败不影响本次请求 */ }
}

/* ----------------------------- 会话池 ----------------------------- */

const sessions = new Map(); // key: `${accountId}:${chatHash}` -> { id, ts, busy }

function sessionKey(accountId, hash) {
  return `${accountId}:${hash}`;
}

export function dropSession(accountId, hash) {
  const k = sessionKey(accountId, hash);
  const s = sessions.get(k);
  if (s) sessions.delete(k);
}

export function clearAllSessions() {
  sessions.clear();
}

async function acquireSession(account, hash) {
  const reuse = getSetting('session_reuse', true) && !!hash;
  const ttl = Number(getSetting('session_ttl_sec', 600)) * 1000;
  const maxPool = Number(getSetting('session_pool_max', 3));
  const k = sessionKey(account.id, hash || crypto.randomUUID());

  if (reuse) {
    const cur = sessions.get(k);
    if (cur && Date.now() - cur.ts < ttl && !cur.busy) {
      cur.busy = true;
      cur.ts = Date.now();
      return { id: cur.id, key: k, reused: true };
    }
  }
  // 上游对同一账号的并发会话有硬上限（实测 3 个，超出直接报「并发会话数已达上限」）。
  // 「腾位 / 建会话 / 记账」必须整体串行，否则并发请求会同时通过检查、各自建会话，
  // 直接把上游配额打穿。
  return withAccountLock(account.id, async () => {
    await ensureCapacity(account, maxPool);
    const { id } = await createSession(account);
    sessions.set(k, { id, ts: Date.now(), busy: true });
    return { id, key: k, reused: false };
  });
}

/**
 * 确保该账号在池中的会话数低于上限。
 * 满了优先淘汰最久未用的空闲会话（并到上游真正删掉，否则 runtime 配额照占）；
 * 全是繁忙会话就排队等，等不到抛 429，而不是无限挂住。
 */
async function ensureCapacity(account, maxPool, timeoutMs = 600000) {
  if (!(maxPool > 0)) return;
  const deadline = Date.now() + timeoutMs;
  const mine = () => [...sessions.entries()].filter(([key]) => key.startsWith(`${account.id}:`));
  while (mine().length >= maxPool) {
    const idle = mine()
      .filter(([, v]) => !v.busy)
      .sort((a, b) => a[1].ts - b[1].ts)[0];
    if (idle) {
      const [key, v] = idle;
      sessions.delete(key);
      await deleteSession(account, v.id).catch(() => { /* 上游删除失败不影响继续 */ });
      continue;
    }
    if (Date.now() > deadline) {
      throw new UpstreamError(`该账号并发已满（上限 ${maxPool} 个会话），请稍后重试`, { status: 429 });
    }
    await new Promise((r) => { setTimeout(r, 200); });
  }
}

/* 每账号一把串行锁：建会话是「检查配额 -> 建 -> 记账」，中间不能被别的请求插进来。 */
const accountLocks = new Map(); // accountId -> Promise

function withAccountLock(accountId, fn) {
  const prev = accountLocks.get(accountId) || Promise.resolve();
  const next = prev.then(fn, fn);
  // 链上不保留异常，否则一次失败会让后续全部连带 reject
  accountLocks.set(accountId, next.catch(() => {}));
  return next;
}

/** 释放该账号全部上游会话（账号删除/停用时调用，避免 runtime 配额泄漏）。 */
export async function releaseAccountSessions(account) {
  const mine = [...sessions.entries()].filter(([key]) => key.startsWith(`${account.id}:`));
  for (const [key, v] of mine) {
    sessions.delete(key);
    await deleteSession(account, v.id).catch(() => {});
  }
  return mine.length;
}

function releaseSession(key, ok = true) {
  const s = sessions.get(key);
  if (!s) return;
  s.busy = false;
  s.ts = Date.now();
  // 失败时把会话从池里摘掉，避免废会话永久占着上游配额
  if (!ok) sessions.delete(key);
}
/* ----------------------------- 消息拼装 ----------------------------- */

/** 把 OpenAI messages 压成上游接受的一段纯文本（上游是 agent，只吃自然语言指令）。 */
export function buildPrompt(messages = [], opts = {}) {
  const parts = [];
  const systems = [];
  for (const m of messages) {
    const role = m.role || 'user';
    const text = contentToText(m.content);
    if (!text) continue;
    if (role === 'system' || role === 'developer') systems.push(text);
    else if (role === 'assistant') parts.push(`【助手】${text}`);
    else if (role === 'tool') parts.push(`【工具结果】${text}`);
    else parts.push(text);
  }
  const sys = systems.join('\n\n');
  if (opts.withSystem !== false && sys) return `${sys}\n\n${parts.join('\n\n')}`.trim();
  return parts.join('\n\n').trim();
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c?.type === 'text') return c.text || '';
        if (c?.type === 'image_url') return '[图片]';
        if (c?.type === 'input_text') return c.text || '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') return JSON.stringify(content);
  return String(content);
}

/** 简单估算 token：中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token。 */
export function estimateTokens(text = '') {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const rest = text.length - cjk;
  return Math.max(1, Math.ceil(cjk + rest / 4));
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function chatHash(messages, model, keyId = '') {
  // 以「首条 user 消息」作为会话根：同一会话的多轮请求都会算出同一个指纹，才能复用上游 session
  const first = messages.find((m) => m.role === 'user');
  const root = first ? contentToText(first.content) : '';
  if (!root) return '';
  return hashStr(`${model}::${keyId}::${root}`).slice(0, 16);
}

/** 复用会话时只发最后一条 user 消息，让上游自行累积上下文；否则发完整拼接内容。 */
export function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return contentToText(messages[i].content);
  }
  return '';
}

/* ----------------------------- 上游请求体 ----------------------------- */

export function upstreamPayload(prompt, model, opts = {}) {
  const body = {
    content: prompt,
    model_id: model,
    repos: [],
  };
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
  return body;
}

/* ----------------------------- 事件归一化 ----------------------------- */

/** 上游事件 -> 中性事件，供 OpenAI / Anthropic 两个出口复用。 */
export function normalizeEvent(ev) {
  const { event, data } = ev;
  if (!data) return null;
  switch (event) {
    case 'status':
      return { kind: 'status', status: data.status, message: data.message, attempt: data.attempt };
    case 'thought':
      if (!data.content) return null;
      return { kind: 'reasoning', text: data.content, id: data.part_id, subagent: data.subagent_id };
    case 'message':
      if (!data.content) return null;
      // 真实事件只有 {content,index,part_id,ts}；部分服务端会额外带 message_type
      return {
        kind: data.message_type === 'command' ? 'command' : 'text',
        text: data.content,
        id: data.part_id,
        index: data.index,
        subagent: data.subagent_id,
      };
    case 'tool_call':
      return {
        kind: 'tool_call',
        id: data.part_id,
        callId: data.call_id,
        tool: data.tool,
        title: data.title,
        input: data.input,
      };
    case 'tool_result':
      return {
        kind: 'tool_result',
        id: data.part_id,
        tool: data.tool,
        status: data.status,
        output: data.result,
        error: data.error,
        input: data.input,
      };
    case 'step_finish':
      return { kind: 'step', tokens: data.tokens, cost: data.cost, reason: data.reason };
    case 'file_diff':
      return { kind: 'file_diff', diff: data.diff || [] };
    case 'question':
      return { kind: 'question', callId: data.call_id, questionId: data.question_id, payload: data };
    case 'done':
      return {
        kind: 'done',
        messageId: data.message_id || data.messageId,
        tokens: data.tokens,
        latency: data.latency_ms,
        credit: data.credit_cost_for_web,
        turnId: data.turn_id || data.turnId,
      };
    case 'error':
      if (data.type === 'stream_ended' || data.error_code === 'CODEBASE.00010628.200') {
        return { kind: 'done', soft: true, messageId: data.message_id };
      }
      return { kind: 'error', message: data.error || '上游错误', code: data.error_code, type: data.type };
    case 'stopped':
      return { kind: 'stopped', messageId: data.partial_message_id };
    case 'session_title':
      return { kind: 'title', title: data.title || data.content };
    default:
      return null;
  }
}

/* ----------------------------- 主流程 ----------------------------- */

/**
 * 执行一次对话：选账号 -> 建/复用会话 -> 发 prompt -> 逐条产出中性事件。
 * @returns {AsyncGenerator<object>} 最后一定 yield 一个 {kind:'done'|'error'}
 */
export async function* runChat({ messages, model, opts = {}, accountId = null, signal = null, onAccount = null, keyId = '' }) {
  const fullPrompt = buildPrompt(messages, { withSystem: getSetting('system_prompt_mode', 'merge') !== 'split' });
  if (!fullPrompt) {
    yield { kind: 'error', message: '请求内容为空', status: 400, code: 'EMPTY_PROMPT' };
    return;
  }

  let acc = accountId ? { id: accountId } : null;
  if (!acc) acc = pickAccount(model);
  if (!acc) {
    const err = noAccountErr();
    yield { kind: 'error', message: err.message, status: err.status, code: err.code };
    return;
  }
  if (onAccount) onAccount(acc);

  const hash = chatHash(messages, model, keyId);
  let session;
  try {
    session = await acquireSession(acc, hash);
  } catch (e) {
    markFailure(acc, e);
    yield toErr(e);
    return;
  }

  // 复用会话时上游已有上文，只补最后一条 user；新会话发完整拼接内容
  const prompt = session.reused ? (lastUserText(messages) || fullPrompt) : fullPrompt;

  let holder = null;
  let finishedOk = false;
  try {
    holder = await promptStream(acc, session.id, upstreamPayload(prompt, model, opts), { signal });
    for await (const ev of parseSse(holder.body)) {
      const n = normalizeEvent(ev);
      if (!n) continue;
      if (n.kind === 'done') {
        finishedOk = true;
        yield n;
        return;
      }
      if (n.kind === 'error') {
        finishedOk = false;
        yield n;
        return;
      }
      if (n.kind === 'question') {
        // 自动回答：上游 agent 会用 question 工具提问，这里按“直接继续”作答，避免挂死
        autoAnswer(acc, session.id, n).catch(() => {});
      }
      if (n.kind === 'tool_call' && n.tool === 'question') {
        // question 工具会单独发 question 事件，这里跳过工具本身
        continue;
      }
      yield n;
    }
    // 流自然结束但没收到 done
    if (finishedOk) {
      yield { kind: 'done' };
    } else {
      yield { kind: 'done', soft: true };
      finishedOk = true;
    }
  } catch (e) {
    if (signal?.aborted) {
      yield { kind: 'stopped' };
      return;
    }
    markFailure(acc, e);
    yield toErr(e);
  } finally {
    if (holder) holder.close();
    releaseSession(session.key, finishedOk);
    if (finishedOk) markAccountResult(acc.id, true, '');
  }
}

function toErr(e) {
  if (e instanceof UpstreamError) {
    return { kind: 'error', message: e.message, status: e.status || 502, code: e.code || 'UPSTREAM' };
  }
  return { kind: 'error', message: e?.message || String(e), status: 502, code: 'UPSTREAM' };
}

/**
 * 记一次账号失败。
 * 登录态失效直接熔断（人工换 Cookie 才能恢复，继续选它只是白打上游）；
 * 超时、并发已满这类只记 error，下一轮还可能好。
 */
function markFailure(acc, e) {
  if (!acc?.id) return;
  if (isAuthError(e)) {
    markAccountInvalid(acc.id, e.message || '登录态失效');
    console.warn(`[账号] ${acc.name || acc.id} 登录态失效，已从选号池移除，请更新 Cookie`);
    return;
  }
  markAccountResult(acc.id, false, e.message || String(e));
}

/** 选不到账号时给出能指导操作的原因，而不是笼统一句「账号池为空」。 */
function noAccountErr() {
  const p = poolStatus();
  if (p.enabled === 0) {
    return { message: '账号池为空，请先在控制台添加账号', status: 503, code: 'NO_ACCOUNT' };
  }
  if (p.usable === 0) {
    return {
      message: `全部 ${p.invalid} 个启用账号的 Cookie 已失效，请在控制台「账号管理」重新导入 Cookie`,
      status: 503,
      code: 'ALL_ACCOUNTS_INVALID',
    };
  }
  return { message: '当前没有可用账号，请稍后重试', status: 503, code: 'NO_ACCOUNT' };
}

async function autoAnswer(account, sessionId, q) {
  const answers = [];
  const payload = q.payload || {};
  const questions = payload.questions || payload.question || [];
  const list = Array.isArray(questions) ? questions : [questions];
  for (const item of list) {
    const options = item?.options || item?.choices || [];
    const first = Array.isArray(options) && options.length ? (options[0].label ?? options[0].value ?? options[0]) : '继续';
    answers.push({ question_id: item?.id || q.questionId, answer: String(first) });
  }
  if (!answers.length) answers.push({ question_id: q.questionId, answer: '继续' });
  await replyQuestion(account, sessionId, { questionId: q.questionId, answers });
}

export { stopSession, CONFIG };
