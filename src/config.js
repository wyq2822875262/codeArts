import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

function loadEnvFile() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnvFile();

export const CONFIG = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 7864),
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  upstreamBase: (process.env.UPSTREAM_BASE || 'https://devcloud.cn-north-4.huaweicloud.com/chat').replace(/\/+$/, ''),
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  sessionSecret: process.env.SESSION_SECRET || '',
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 300000),
  maxConcurrency: Number(process.env.MAX_CONCURRENCY || 8),
  // 上游网页端在每次请求都会带上的标识头
  clientType: process.env.CLIENT_TYPE || 'CodeArtsWork_Web',
  clientVersion: process.env.CLIENT_VERSION || '126.11.2.20261113114147',
  agentId: process.env.AGENT_ID || 'a8bcb36232554267a5142361cc25a393',
  // 模式标识：网页端默认智速模式
  modeType: process.env.MODE_TYPE || 'fastmode',
  // 默认模型 slug（网页端 model_id 用的就是这种短名）
  defaultModelSlug: process.env.DEFAULT_MODEL_SLUG || 'speed',
  // 反向代理：挂在 Nginx/Caddy 后面时打开，才会采信 X-Forwarded-For
  trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || ''),
  // 允许的代理来源（逗号分隔，精确 IP 或网段前缀），留空表示信任任一对端
  trustedProxies: (process.env.TRUSTED_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean),
};

if (!fs.existsSync(CONFIG.dataDir)) fs.mkdirSync(CONFIG.dataDir, { recursive: true });
export const DB_FILE = path.join(CONFIG.dataDir, 'gateway.db');
