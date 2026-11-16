/**
 * 对外网关：OpenAI / Anthropic 兼容出口
 *
 *   POST /v1/chat/completions        OpenAI Chat Completions（流式/非流式）
 *   POST /v1/messages               Anthropic Messages（Claude Code 等）
 *   POST /v1/responses              OpenAI Responses API
 *   GET  /v1/models                 模型列表
 *   GET  /v1/usage                  密钥自查
 */
import crypto from 'node:crypto';
import {
  findKeyBySecret, getKey, bumpKeyUsage, insertLog, bumpUsage, touchKeyIp, countKeyIps,
  getSetting, safeParse, markAccountResult,
} from './db.js';
import { runChat, estimateTokens, buildPrompt } from './bridge.js';
import { fetchModels } from './upstream.js';
import { db } from './db.js';
import { ipMatch, clientIp } from './auth.js';

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};

const oaiErr = (message, type = 'invalid_request_error', code = '') => ({
  error: { message, type, code: code || null, param: null },
});

/* ----------------------------- 鉴权 ----------------------------- */

function extractKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  if (req.headers['api-key']) return String(req.headers['api-key']).trim();
  return '';
}

/** 校验入站密钥 + IP + 额度。返回 {key} 或 {error,status}。 */
export function authenticateKey(req) {
  const secret = extractKey(req);
  if (!secret) return { status: 401, error: oaiErr('缺少 API Key（Authorization: Bearer sk-...）', 'authentication_error') };

  const key = findKeyBySecret(secret);
  if (!key) return { status: 401, error: oaiErr('API Key 无效', 'authentication_error') };
  if (!key.enabled) return { status: 403, error: oaiErr('该 API Key 已被禁用', 'permission_error') };
  if (key.expire_at && Date.now() > key.expire_at) return { status: 403, error: oaiErr('该 API Key 已过期', 'permission_error') };
  if (key.quota > 0 && key.used_tokens >= key.quota) {
    return { status: 429, error: oaiErr('该 API Key 额度已用尽', 'insufficient_quota', 'quota_exceeded') };
  }

  const ip = clientIp(req);

  // 全局入站规则
  const rules = db.prepare('SELECT * FROM ip_rules').all();
  const denied = rules.some((r) => r.kind === 'deny' && ipMatch(ip, r.cidr));
  if (denied) return { status: 403, error: oaiErr(`来源 IP ${ip} 已被拒绝`, 'permission_error') };
  const allows = rules.filter((r) => r.kind === 'allow');
  if (allows.length && !allows.some((r) => ipMatch(ip, r.cidr))) {
    return { status: 403, error: oaiErr(`来源 IP ${ip} 不在白名单内`, 'permission_error') };
  }

  // 每密钥 IP 白名单 / 数量上限
  if (key.ip_whitelist?.length && !key.ip_whitelist.some((r) => ipMatch(ip, r))) {
    return { status: 403, error: oaiErr(`来源 IP ${ip} 不在该密钥的 IP 白名单内`, 'permission_error') };
  }
  if (key.max_ips > 0) {
    const used = countKeyIps(key.id);
    const known = db.prepare('SELECT 1 FROM key_ips WHERE key_id = ? AND ip = ?').get(key.id, ip);
    if (!known && used >= key.max_ips) {
      return { status: 403, error: oaiErr(`该密钥已绑定 ${used} 个 IP，超过上限 ${key.max_ips}`, 'permission_error') };
    }
    touchKeyIp(key.id, ip);
  } else {
    touchKeyIp(key.id, ip);
  }

  return { key, ip };
}

function checkModelAllowed(key, model) {
  if (!key.model_whitelist?.length) return true;
  return key.model_whitelist.includes(model);
}

/* ----------------------------- 模型解析 ----------------------------- */

async function resolveModel(account, requested) {
  const alias = getSetting('model_alias', {}) || {};
  const model = alias[requested] || requested;
  if (model) return model;
  const def = getSetting('default_model', '');
  return def || 'DeepSeek-V3.2';
}

export async function listModelIds(account) {
  const cached = getSetting('model_cache', null);
  if (cached && Date.now() - cached.ts < 5 * 60000 && cached.list?.length) return cached.list;
  if (!account) return cached?.list || [];
  try {
    const list = await fetchModels(account);
    if (list.length) {
      const ids = list.map((m) => m.id);
      // eslint-disable-next-line no-use-before-define
      setModelCache({ ts: Date.now(), list: ids, detail: list });
      return ids;
    }
  } catch { /* 忽略 */ }
  return cached?.list || [];
}

function setModelCache(v) {
  db.prepare("INSERT INTO settings(k,v) VALUES('model_cache',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .run(JSON.stringify(v));
}

/* ----------------------------- 日志与用量 ----------------------------- */

function logCall(ctx, extra = {}) {
  const day = new Date().toISOString().slice(0, 10);
  const row = {
    ts: Date.now(),
    key_id: ctx.key?.id,
    key_name: ctx.key?.name || '',
    account_id: ctx.account?.id,
    account_name: ctx.account?.name || '',
    model: ctx.model || '',
    endpoint: ctx.endpoint || '',
    ip: ctx.ip || '',
    ...extra,
  };
  insertLog(row);
  bumpUsage(day, ctx.key?.id, ctx.model, {
    ok: (row.status || 200) < 400,
    pt: row.prompt_tokens || 0,
    ct: row.completion_tokens || 0,
  });
  if (ctx.key?.id) bumpKeyUsage(ctx.key.id, row.total_tokens || 0);
}

/* ----------------------------- Chat Completions ----------------------------- */

export async function handleChatCompletions(req, res, body) {
  const auth = authenticateKey(req);
  if (auth.error) return json(res, auth.status, auth.error);
  const { key, ip } = auth;

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length) return json(res, 400, oaiErr('messages 不能为空'));

  let model;
  try {
    model = await resolveModel(null, body.model);
  } catch {
    model = body.model;
  }
  if (!model) return json(res, 400, oaiErr('缺少 model 参数'));
  if (!checkModelAllowed(key, model) && !checkModelAllowed(key, body.model)) {
    return json(res, 403, oaiErr(`该密钥无权使用模型 ${model}`, 'permission_error'));
  }

  const stream = body.stream === true;
  const promptText = buildPrompt(messages);
  const promptTokens = estimateTokens(promptText);
  const startedAt = Date.now();
  const ctx = { key, ip, model, endpoint: '/v1/chat/completions' };

  const ac = new AbortController();
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) { clientGone = true; ac.abort(); }
  });

  const opts = {};
  if (body.reasoning_effort) opts.reasoningEffort = body.reasoning_effort;

  let acc = null;
  let firstTokenAt = 0;
  let answer = '';
  let reasoning = '';
  let usage = null;
  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (obj) => {
      if (res.writableEnded || clientGone) return;
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    const chunk = (delta, finish = null, extra = {}) => ({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(startedAt / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
      ...extra,
    });

    send(chunk({ role: 'assistant', content: '' }));
    let done = false;

    try {
      for await (const ev of runChat({
        messages, model, opts, signal: ac.signal, keyId: key.id,
        onAccount: (a) => { acc = a; ctx.account = a; },
      })) {
        if (clientGone) break;
        if (ev.kind === 'error') {
          send({ error: { message: ev.message, type: 'upstream_error', code: ev.code || null } });
          logCall(ctx, {
            status: ev.status || 502, stream: 1, latency_ms: Date.now() - startedAt,
            first_token_ms: firstTokenAt ? firstTokenAt - startedAt : 0,
            prompt_tokens: promptTokens, completion_tokens: estimateTokens(answer), total_tokens: promptTokens + estimateTokens(answer),
            error: ev.message,
          });
          done = true;
          break;
        }
        if (ev.kind === 'reasoning') {
          if (!firstTokenAt) firstTokenAt = Date.now();
          reasoning += ev.text;
          send(chunk({ reasoning_content: ev.text }));
          continue;
        }
        if (ev.kind === 'text' || ev.kind === 'command') {
          if (!firstTokenAt) firstTokenAt = Date.now();
          answer += ev.text;
          send(chunk({ content: ev.text }));
          continue;
        }
        if (ev.kind === 'tool_call') {
          send(chunk({
            tool_calls: [{
              index: 0,
              id: 'call_' + (ev.callId || ev.id || crypto.randomBytes(6).toString('hex')),
              type: 'function',
              function: { name: ev.tool || 'tool', arguments: JSON.stringify(ev.input ?? {}) },
            }],
          }));
          continue;
        }
        if (ev.kind === 'step' && ev.tokens) { usage = ev.tokens; continue; }
        if (ev.kind === 'done') {
          if (ev.tokens) usage = ev.tokens;
          done = true;
          break;
        }
        if (ev.kind === 'stopped') { done = true; break; }
      }
      const pt = usage?.input || usage?.prompt || usage?.input_tokens || promptTokens;
      const ct = usage?.output || usage?.completion || usage?.output_tokens || estimateTokens(answer);
      const finalUsage = { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct };
      send(chunk({}, 'stop'));
      if (body.stream_options?.include_usage) {
        send({ id, object: 'chat.completion.chunk', created: Math.floor(startedAt / 1000), model, choices: [], usage: finalUsage });
      }
      res.write('data: [DONE]\n\n');
      res.end();
      logCall(ctx, {
        status: 200, stream: 1, latency_ms: Date.now() - startedAt,
        first_token_ms: firstTokenAt ? firstTokenAt - startedAt : 0,
        prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct,
      });
    } catch (e) {
      if (!res.writableEnded) {
        send({ error: { message: e.message, type: 'upstream_error' } });
        res.end();
      }
      logCall(ctx, { status: 500, stream: 1, latency_ms: Date.now() - startedAt, error: e.message });
    }
    return;
  }

  // 非流式：聚合全部文本
  try {
    let err = null;
    for await (const ev of runChat({ messages, model, opts, keyId: key.id, onAccount: (a) => { acc = a; ctx.account = a; } })) {
      if (ev.kind === 'error') { err = ev; break; }
      if (ev.kind === 'reasoning') reasoning += ev.text;
      else if (ev.kind === 'text' || ev.kind === 'command') answer += ev.text;
      else if (ev.kind === 'step' && ev.tokens) usage = ev.tokens;
      else if (ev.kind === 'done' && ev.tokens) usage = ev.tokens;
    }
    if (err) {
      logCall(ctx, {
        status: err.status || 502, latency_ms: Date.now() - startedAt,
        prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: promptTokens, error: err.message,
      });
      return json(res, err.status || 502, oaiErr(err.message, 'upstream_error', err.code));
    }
    const pt = usage?.input || usage?.prompt || usage?.input_tokens || promptTokens;
    const ct = usage?.output || usage?.completion || usage?.output_tokens || estimateTokens(answer);
    const payload = {
      id,
      object: 'chat.completion',
      created: Math.floor(startedAt / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: answer,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
        finish_reason: 'stop',
        logprobs: null,
      }],
      usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
    };
    logCall(ctx, {
      status: 200, latency_ms: Date.now() - startedAt,
      prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct,
    });
    return json(res, 200, payload);
  } catch (e) {
    logCall(ctx, { status: 500, latency_ms: Date.now() - startedAt, error: e.message });
    return json(res, 500, oaiErr(e.message, 'upstream_error'));
  }
}

/* ----------------------------- Anthropic Messages ----------------------------- */

export async function handleMessages(req, res, body) {
  const auth = authenticateKey(req);
  if (auth.error) return json(res, auth.status, auth.error);
  const { key, ip } = auth;

  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const system = typeof body?.system === 'string'
    ? body.system
    : Array.isArray(body?.system) ? body.system.map((s) => s?.text || '').join('\n') : '';

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const m of msgs) messages.push({ role: m.role, content: m.content });

  let model = body?.model || '';
  model = (getSetting('model_alias', {}) || {})[model] || model || getSetting('default_model', '');
  if (!checkModelAllowed(key, model) && !checkModelAllowed(key, body?.model)) {
    return json(res, 403, { type: 'error', error: { type: 'permission_error', message: `该密钥无权使用模型 ${model}` } });
  }

  const stream = body?.stream === true;
  const startedAt = Date.now();
  const ctx = { key, ip, model, endpoint: '/v1/messages' };
  const id = 'msg_' + crypto.randomBytes(12).toString('hex');

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  let answer = '';
  let reasoning = '';
  let firstTokenAt = 0;
  let usage = null;

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const ev = (type, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    };
    ev('message_start', {
      message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });

    try {
      for await (const e of runChat({ messages, model, signal: ac.signal, keyId: key.id, onAccount: (a) => { ctx.account = a; } })) {
        if (e.kind === 'error') {
          ev('error', { error: { type: 'upstream_error', message: e.message } });
          res.end();
          logCall(ctx, { status: e.status || 502, stream: 1, latency_ms: Date.now() - startedAt, error: e.message });
          return;
        }
        if (e.kind === 'reasoning') {
          if (!firstTokenAt) firstTokenAt = Date.now();
          reasoning += e.text;
          ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: e.text } });
          continue;
        }
        if (e.kind === 'text' || e.kind === 'command') {
          if (!firstTokenAt) firstTokenAt = Date.now();
          answer += e.text;
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: e.text } });
          continue;
        }
        if (e.kind === 'step' && e.tokens) usage = e.tokens;
        if (e.kind === 'done') { if (e.tokens) usage = e.tokens; break; }
        if (e.kind === 'stopped') break;
      }
      const pt = usage?.input || usage?.prompt || estimateTokens(buildPrompt(messages));
      const ct = usage?.output || usage?.completion || estimateTokens(answer);
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: pt, output_tokens: ct } });
      ev('message_stop', {});
      res.end();
      logCall(ctx, {
        status: 200, stream: 1, latency_ms: Date.now() - startedAt,
        first_token_ms: firstTokenAt ? firstTokenAt - startedAt : 0,
        prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct,
      });
    } catch (e) {
      if (!res.writableEnded) { ev('error', { error: { type: 'upstream_error', message: e.message } }); res.end(); }
      logCall(ctx, { status: 500, stream: 1, latency_ms: Date.now() - startedAt, error: e.message });
    }
    return;
  }

  try {
    let err = null;
    for await (const e of runChat({ messages, model, keyId: key.id, onAccount: (a) => { ctx.account = a; } })) {
      if (e.kind === 'error') { err = e; break; }
      if (e.kind === 'reasoning') reasoning += e.text;
      else if (e.kind === 'text' || e.kind === 'command') answer += e.text;
      else if (e.kind === 'step' && e.tokens) usage = e.tokens;
      else if (e.kind === 'done' && e.tokens) usage = e.tokens;
    }
    if (err) {
      logCall(ctx, { status: err.status || 502, latency_ms: Date.now() - startedAt, error: err.message });
      return json(res, err.status || 502, { type: 'error', error: { type: 'upstream_error', message: err.message } });
    }
    const pt = usage?.input || usage?.prompt || estimateTokens(buildPrompt(messages));
    const ct = usage?.output || usage?.completion || estimateTokens(answer);
    const payload = {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [
        ...(reasoning ? [{ type: 'thinking', thinking: reasoning }] : []),
        { type: 'text', text: answer },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: pt, output_tokens: ct },
    };
    logCall(ctx, { status: 200, latency_ms: Date.now() - startedAt, prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct });
    return json(res, 200, payload);
  } catch (e) {
    logCall(ctx, { status: 500, latency_ms: Date.now() - startedAt, error: e.message });
    return json(res, 500, { type: 'error', error: { type: 'upstream_error', message: e.message } });
  }
}

/* ----------------------------- Responses API ----------------------------- */

export async function handleResponses(req, res, body) {
  const auth = authenticateKey(req);
  if (auth.error) return json(res, auth.status, auth.error);
  const { key, ip } = auth;

  const input = body?.input;
  const messages = [];
  if (typeof input === 'string') messages.push({ role: 'user', content: input });
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (item?.type === 'message' || item?.role) {
        messages.push({ role: item.role || 'user', content: item.content });
      } else if (item?.type === 'input_text') {
        messages.push({ role: 'user', content: item.text });
      }
    }
  }
  if (!messages.length) return json(res, 400, oaiErr('input 不能为空'));

  const model = (getSetting('model_alias', {}) || {})[body?.model] || body?.model || getSetting('default_model', '');
  const stream = body?.stream === true;
  const startedAt = Date.now();
  const ctx = { key, ip, model, endpoint: '/v1/responses' };
  const id = 'resp_' + crypto.randomBytes(12).toString('hex');

  let answer = '';
  let reasoning = '';
  let usage = null;
  let err = null;
  for await (const e of runChat({ messages, model, keyId: key.id, onAccount: (a) => { ctx.account = a; } })) {
    if (e.kind === 'error') { err = e; break; }
    if (e.kind === 'reasoning') reasoning += e.text;
    else if (e.kind === 'text' || e.kind === 'command') answer += e.text;
    else if (e.kind === 'step' && e.tokens) usage = e.tokens;
    else if (e.kind === 'done' && e.tokens) usage = e.tokens;
  }
  if (err) {
    logCall(ctx, { status: err.status || 502, latency_ms: Date.now() - startedAt, error: err.message });
    return json(res, err.status || 502, oaiErr(err.message, 'upstream_error', err.code));
  }
  const pt = usage?.input || estimateTokens(buildPrompt(messages));
  const ct = usage?.output || estimateTokens(answer);
  const payload = {
    id,
    object: 'response',
    created_at: Math.floor(startedAt / 1000),
    model,
    status: 'completed',
    output: [{
      type: 'message',
      id: 'msg_' + id.slice(5),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: answer, annotations: [] }],
    }],
    output_text: answer,
    usage: { input_tokens: pt, output_tokens: ct, total_tokens: pt + ct },
  };
  logCall(ctx, { status: 200, latency_ms: Date.now() - startedAt, prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct });
  return json(res, 200, payload);
}

/* ----------------------------- models / usage ----------------------------- */

export async function handleModels(req, res) {
  const auth = authenticateKey(req);
  if (auth.error) return json(res, auth.status, auth.error);
  let ids = [];
  try {
    const acc = db.prepare("SELECT * FROM accounts WHERE enabled=1 AND state!='invalid' ORDER BY id LIMIT 1").get();
    ids = await listModelIds(acc ? { ...acc, cookie: acc.cookie } : null);
  } catch { /* 忽略 */ }
  if (!ids.length) ids = [getSetting('default_model', '')].filter(Boolean);
  const created = Math.floor(Date.now() / 1000);
  return json(res, 200, {
    object: 'list',
    data: ids.map((mid) => ({ id: mid, object: 'model', created, owned_by: 'codearts' })),
  });
}

export async function handleUsage(req, res) {
  const auth = authenticateKey(req);
  if (auth.error) return json(res, auth.status, auth.error);
  const k = getKey(auth.key.id);
  return json(res, 200, {
    key: k.name,
    used_tokens: k.used_tokens,
    quota: k.quota,
    remaining: k.quota > 0 ? Math.max(0, k.quota - k.used_tokens) : null,
    used_requests: k.used_requests,
    expire_at: k.expire_at || null,
    models: k.model_whitelist.length ? k.model_whitelist : 'all',
  });
}

export { json, oaiErr };
