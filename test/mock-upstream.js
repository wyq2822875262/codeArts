/**
 * 本地 mock 上游：模拟码道 cloudagent 协议，用于离线自测
 * 启动：node test/mock-upstream.js [port]
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 7900);
const sessions = new Map();
let seq = 0;

const models = [
  { id: 'DeepSeek-V3.2', name: 'DeepSeek-V3.2', context: 128000, maxTokens: 8192, type: 'builtin' },
  { id: 'Qwen3-Coder', name: 'Qwen3-Coder', context: 256000, maxTokens: 16384, type: 'builtin' },
];

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const method = req.method.toUpperCase();
  const cookie = req.headers.cookie || '';

  if (!p.startsWith('/rest/') && !p.startsWith('/__') && !p.startsWith('/codebaseservice') && !p.startsWith('/v1/') && !p.startsWith('/PromptCenterService')) {
    // 其它路径透传 404
    return json(res, 404, { error: 'not found', path: p });
  }

  // 无 cookie 模拟登录失效
  if (!cookie.includes('SessionID=')) {
    res.writeHead(200, { 'HW-AJAX-REDIRECT': 'https://auth.huaweicloud.com/authui/login?service=' });
    return res.end('');
  }

  if (p === '/rest/me') {
    return json(res, 200, { data: { userId: 'mock-user', domainId: 'mock-domain', id: 'u1', name: 'Mock' } });
  }

  if (p === '/PromptCenterService/v1/agent-center/agents/detail') {
    return json(res, 200, {
      data: {
        data: {
          gpts: {
            models: models.map((m) => ({
              model_name: m.name,
              model_type: m.type,
              model_parameters: {
                model_id: m.id, model_name: m.name,
                context_window: m.context, max_tokens: m.maxTokens,
                display_enabled: true,
              },
            })),
          },
        },
      },
    });
  }

  if (p === '/v1/cloudagent/sessions' && method === 'POST') {
    const id = 'sess-' + (++seq);
    sessions.set(id, { id, createdAt: Date.now(), turns: [] });
    return json(res, 200, { result: { session_id: id } });
  }

  if (p === '/v1/cloudagent/sessions' && method === 'GET') {
    return json(res, 200, { result: Array.from(sessions.values()).map((s) => ({ session_id: s.id })), total: sessions.size });
  }

  const m = p.match(/^\/codebaseservice\/v1\/cloudagent\/sessions\/([^/]+)\/messages$/);
  if (m && method === 'POST') {
    const sid = m[1];
    const body = await readBody(req);
    const prompt = body.content || '';
    const sess = sessions.get(sid) || { turns: [] };
    sess.turns.push(prompt);
    sessions.set(sid, sess);
    // 把收到的 prompt 写进响应，便于测试断言
    req.app = req.app || {};
    global.__lastPrompt = prompt;
    global.__lastSession = sid;
    const echo = `收到：${prompt.slice(-40)}`;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    ev('status', { status: 'processing' });
    await sleep(20);
    ev('thought', { part_id: 'p1', content: '思考中…' });
    await sleep(20);
    for (const piece of ['你好', '，这是', echo, '。']) {
      ev('message', { part_id: 'p2', content: piece, message_type: 'text' });
      await sleep(25);
    }
    ev('step_finish', { reason: 'stop', tokens: { input: 12, output: 18, total: 30 } });
    ev('done', { message_id: 'msg-1', tokens: { input: 12, output: 18 }, latency_ms: 180, credit_cost_for_web: 1 });
    res.end();
    return;
  }

  if (/^\/v1\/cloudagent\/sessions\/[^/]+\/messages\/stop$/.test(p)) {
    return json(res, 200, { ok: true });
  }
  if (/^\/v1\/cloudagent\/sessions\/[^/]+\/messages\/reply$/.test(p)) {
    return json(res, 200, { ok: true });
  }

  // 测试辅助：读取最近一次收到的 prompt 与所用 session
  if (p === '/__last') {
    return json(res, 200, { prompt: global.__lastPrompt || '', session: global.__lastSession || '' });
  }

  json(res, 404, { error: 'not found', path: p });
});

server.listen(PORT, () => console.log(`mock upstream on http://127.0.0.1:${PORT}`));
