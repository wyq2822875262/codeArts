import crypto from 'node:crypto';
import { getSetting, setSetting, verifyPassword, hashPassword } from './db.js';

const COOKIE = 'dv_session';

function secret() {
  let s = getSetting('session_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); setSetting('session_secret', s); }
  return s;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expect = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (mac.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function getSessionUser(req) {
  const token = parseCookies(req.headers.cookie || '')[COOKIE];
  if (!token) return null;
  return unsign(token);
}

export function login(res, username = 'admin') {
  const token = sign({ u: username, exp: Date.now() + 7 * 86400000 });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`);
  return token;
}

export function logout(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function checkPassword(pw) {
  return verifyPassword(pw, getSetting('admin_password_hash', ''));
}

export function changePassword(pw) {
  setSetting('admin_password_hash', hashPassword(pw));
}

export function requireAuth(req, res) {
  const u = getSessionUser(req);
  if (!u) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '未登录' }));
    return null;
  }
  return u;
}

/* ---------------- IP 规则 ---------------- */

export function normalizeIp(ip = '') {
  if (!ip) return '';
  let v = ip.replace(/^::ffff:/, '');
  if (v === '::1') v = '127.0.0.1';
  return v;
}

/**
 * 取客户端 IP。优先用 server 层校验过的 req.clientIp（只有受信代理的转发头才会被采信），
 * 避免直连时被伪造的 X-Forwarded-For 绕过 IP 白名单。
 */
export function clientIp(req) {
  if (req.clientIp) return req.clientIp;
  return normalizeIp(req.socket?.remoteAddress || '');
}

/** 支持精确 IP 与 CIDR（v4/v6）。 */
export function ipMatch(ip, rule) {
  if (!rule) return false;
  const r = rule.trim();
  if (!r.includes('/')) return normalizeIp(ip) === normalizeIp(r);
  const [net, bitsStr] = r.split('/');
  const bits = Number(bitsStr);
  const a = ipToBigInt(normalizeIp(ip));
  const b = ipToBigInt(normalizeIp(net));
  if (a === null || b === null) return false;
  const total = normalizeIp(ip).includes(':') ? 128 : 32;
  if (!Number.isFinite(bits) || bits < 0 || bits > total) return false;
  const shift = BigInt(total - bits);
  return (a >> shift) === (b >> shift);
}

function ipToBigInt(ip) {
  if (!ip) return null;
  if (ip.includes(':')) {
    const full = expandV6(ip);
    if (!full) return null;
    return BigInt('0x' + full.replace(/:/g, ''));
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isFinite(v) || v < 0 || v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function expandV6(ip) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail !== undefined ? (tail ? tail.split(':').filter(Boolean) : []) : null;
  if (t === null && h.length !== 8) return null;
  const fill = t === null ? [] : new Array(8 - h.length - t.length).fill('0');
  const all = [...h, ...fill, ...(t || [])];
  if (all.length !== 8) return null;
  return all.map((x) => x.padStart(4, '0')).join(':');
}
