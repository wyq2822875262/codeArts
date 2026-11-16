#!/usr/bin/env node
/**
 * 账号 Cookie 导入工具。
 *
 * 上游登录态只能在浏览器里获得（VPS 上没有浏览器），所以流程是：
 *   本地浏览器登录 → 导出 cookie → 粘到 VPS 的这里。
 *
 * 用法：
 *   node tools/import-cookie.js '<cookie 字符串>' [账号名]
 *   node tools/import-cookie.js -f cookies.txt [账号名]
 *   echo '<cookie>' | node tools/import-cookie.js - [账号名]
 *
 * cookie 字符串可以直接从浏览器 DevTools 的 Network → 任意 /chat 请求 →
 * Request Headers → Cookie 整行复制，或从 Application → Cookies 逐条拼。
 */
import fs from 'node:fs';
import { CONFIG } from '../src/config.js';
import { seedSettings, upsertAccount, getAccountByName, listAccounts } from '../src/db.js';
import { fetchMe, fetchModels, createSession, UpstreamError } from '../src/upstream.js';

seedSettings();

function usage() {
  console.error(`用法：
  node tools/import-cookie.js '<cookie>' [账号名]
  node tools/import-cookie.js -f cookies.txt [账号名]
  cat cookies.txt | node tools/import-cookie.js - [账号名]`);
  process.exit(1);
}

const args = process.argv.slice(2);
let raw = '';
let name = 'default';

if (args[0] === '-f') {
  if (!args[1]) usage();
  raw = fs.readFileSync(args[1], 'utf8');
  name = args[2] || name;
} else if (args[0] === '-') {
  raw = fs.readFileSync(0, 'utf8');
  name = args[1] || name;
} else if (args[0]) {
  raw = args[0];
  name = args[1] || name;
} else {
  usage();
}

// 容忍「Cookie: xxx」前缀、换行、以及复制时带的引号
raw = raw.trim().replace(/^["']|["']$/g, '').replace(/^Cookie:\s*/i, '').replace(/\s*\n\s*/g, ' ');
// 只留 ASCII 可见字符，粘进来的零宽字符会让请求头编码直接抛错
raw = raw.replace(/[^\t\x20-\x7E]/g, '').trim();

if (!raw.includes('=')) {
  console.error('cookie 看起来不对：没有 key=value 结构');
  process.exit(1);
}

const hasSession = /(^|;\s*)SessionID=/i.test(raw);
const hasCftk = /cftk=/i.test(raw);
if (!hasSession) {
  console.error('警告：cookie 里没有 SessionID，多半没登录或没复制全');
}
if (!hasCftk) {
  console.error('警告：cookie 里没有 cftk，上游会返回 csrf validate fail');
}

const account = {
  id: getAccountByName(name)?.id || 0,
  name,
  cookie: raw,
  cftk: (raw.match(/([A-Za-z0-9_]*cftk)=([^;]+)/i) || [])[2] || '',
};

console.log(`账号：${name}`);
console.log(`cookie：${raw.length} 字节，${raw.split(';').length} 项，cftk=${account.cftk ? '有' : '缺失'}`);
console.log('正在校验上游登录态…');

try {
  const me = await fetchMe(account);
  const domain = me?.domainName || me?.domain || me?.userName || '(已登录)';
  console.log(`  ✓ 登录态有效：${domain}`);
} catch (e) {
  const msg = e instanceof UpstreamError ? `${e.message}${e.code ? ` [${e.code}]` : ''}` : e.message;
  console.error(`  ✗ 校验失败：${msg}`);
  console.error('    请重新在浏览器登录后再导出 cookie。');
  process.exit(1);
}

// /rest/me 能过不代表对话接口能过，真正开一次会话才算数
let sessionId = '';
try {
  sessionId = (await createSession(account))?.id || '';
  if (!sessionId) throw new Error('上游未返回 session_id');
  console.log(`  ✓ 建会话成功：${sessionId.slice(0, 8)}…`);
} catch (e) {
  const msg = e instanceof UpstreamError ? `${e.message}${e.code ? ` [${e.code}]` : ''}` : e.message;
  console.error(`  ✗ 建会话失败：${msg}`);
  console.error('    账号信息可读但对话接口不可用，这份 cookie 不能用于对话。');
  process.exit(1);
}

let models = [];
try {
  models = await fetchModels(account);
  console.log(`  ✓ 可用模型：${models.length} 个`);
} catch {
  console.log('  · 模型清单拉取失败，运行时回退到内置清单');
}

const saved = upsertAccount({
  name: account.name,
  cookie: account.cookie,
  cftk: account.cftk,
  models: JSON.stringify(models),
  enabled: 1,
});

console.log(`  ✓ 已写入 ${CONFIG.dataDir}/gateway.db（账号 id=${saved?.id ?? '?'}）`);
console.log(`\n当前账号池：${listAccounts().map((a) => `${a.name}(${a.enabled ? '启用' : '停用'})`).join('、') || '空'}`);
