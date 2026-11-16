import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, ROOT } from './config.js';
import { seedSettings } from './db.js';
import { handleApi } from './admin.js';
import { startSigninScheduler } from './signin-scheduler.js';
import { startKeepalive } from './keepalive.js';
import {
  handleChatCompletions, handleMessages, handleResponses, handleModels, handleUsage, json, oaiErr,
} from './gateway.js';

seedSettings();

const WEB_DIR = path.join(ROOT, 'web');
const MAX_BODY = 20 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({ _raw: raw }); }
    });
    req.on('error', reject);
  });
}

/** 资源的 mtime 当版本号：文件一改，URL 就变，浏览器必然拉新。 */
function assetVersion(rel) {
  try {
    return Math.floor(fs.statSync(path.join(WEB_DIR, rel)).mtimeMs).toString(36);
  } catch {
    return '0';
  }
}

/** 把 index.html 里的 {{XXX_V}} 占位符替换成对应静态资源的版本号。 */
function renderHtml(buf) {
  let html = buf.toString('utf8');
  if (!html.includes('{{')) return buf;
  html = html
    .replace(/\{\{APP_V\}\}/g, assetVersion('app.js'))
    .replace(/\{\{STYLE_V\}\}/g, assetVersion('style.css'));
  return Buffer.from(html, 'utf8');
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(WEB_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); res.end('forbidden'); return true; }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // SPA 回退
    const idx = path.join(WEB_DIR, 'index.html');
    if (fs.existsSync(idx)) {
      const buf = renderHtml(fs.readFileSync(idx));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
      res.end(buf);
      return true;
    }
    return false;
  }
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  // HTML 里的静态资源版本号占位符要在每次响应时按当前 mtime 替换
  const buf = ext === '.html' ? renderHtml(fs.readFileSync(file)) : fs.readFileSync(file);

  // 用 mtime+size 做 ETag：前端改完刷新就生效，同时保留 304 协商缓存省流量。
  // 之前给静态资源写死 max-age=3600，改完 CSS/JS 要等一小时才生效。
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const baseHeaders = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'no-cache, must-revalidate',
    ETag: etag,
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, baseHeaders);
    res.end();
    return true;
  }

  res.writeHead(200, { ...baseHeaders, 'Content-Length': buf.length });
  res.end(buf);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method.toUpperCase();

  // 挂在 Nginx/Caddy 后面时，客户端 IP 要用代理传的真实值，否则日志与 IP 白名单全部记成 127.0.0.1
  req.clientIp = trustedClientIp(req);

  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-api-key, api-key, anthropic-version');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    if (p === '/healthz') return json(res, 200, { ok: true, ts: Date.now(), upstream: CONFIG.upstreamBase });

    if (p.startsWith('/api/')) {
      const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? await readBody(req) : {};
      const r = await handleApi(req, res, url, body);
      if (r === null) return; // 已由内部处理（401）
      return;
    }

    if (p === '/v1/chat/completions' || p === '/chat/completions') {
      return handleChatCompletions(req, res, await readBody(req));
    }
    if (p === '/v2/chat/completions') {
      return handleChatCompletions(req, res, await readBody(req));
    }
    if (p === '/v1/messages' || p === '/messages') {
      return handleMessages(req, res, await readBody(req));
    }
    if (p === '/v1/messages/count_tokens') {
      return json(res, 200, { input_tokens: 0 });
    }
    if (p === '/v1/responses' || p === '/responses') {
      return handleResponses(req, res, await readBody(req));
    }
    if (p === '/v1/models' && method === 'GET') return handleModels(req, res);
    if (p === '/v1/usage' && method === 'GET') return handleUsage(req, res);

    if (method === 'GET' || method === 'HEAD') {
      if (serveStatic(req, res, url)) return;
    }
    json(res, 404, oaiErr('Not Found', 'invalid_request_error'));
  } catch (e) {
    console.error('[error]', p, e);
    if (!res.headersSent) json(res, 500, oaiErr(e.message || '服务器内部错误', 'server_error'));
    else { try { res.end(); } catch { /* noop */ } }
  }
});

/** 取客户端真实 IP：只有来自受信代理的请求才采信转发头，避免被伪造绕过白名单。 */
function trustedClientIp(req) {
  const sock = req.socket.remoteAddress || '';
  const direct = sock.replace(/^::ffff:/, '');
  if (!CONFIG.trustProxy) return direct;
  if (CONFIG.trustedProxies.length) {
    const norm = direct;
    const ok = CONFIG.trustedProxies.some((rule) => norm === rule || norm.startsWith(rule.replace(/\/\d+$/, '')));
    if (!ok) return direct;
  }
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (xff.length) return xff[0].replace(/^::ffff:/, '');
  const real = req.headers['x-real-ip'];
  if (real) return String(real).replace(/^::ffff:/, '');
  return direct;
}

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`\n  码道反代网关已启动`);
  console.log(`  监听地址   ${CONFIG.host}:${CONFIG.port}`);
  console.log(`  管理面板   http://127.0.0.1:${CONFIG.port}/`);
  console.log(`  上游地址   ${CONFIG.upstreamBase}`);
  console.log(`  OpenAI 兼容 http://127.0.0.1:${CONFIG.port}/v1`);
  console.log(`  反向代理   ${CONFIG.trustProxy ? '已启用（采信 X-Forwarded-For）' : '未启用（直接用对端地址）'}`);
  if (CONFIG.adminPassword === 'admin123') {
    console.log(`  ⚠ 管理员密码仍是默认值，公网部署前务必在设置中修改或设 ADMIN_PASSWORD`);
  }
  startSigninScheduler();
  startKeepalive();
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
}
