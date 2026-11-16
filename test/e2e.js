/**
 * 端到端自测：起 mock 上游 + 网关，跑通「加账号 → 同步模型 → 密钥鉴权 → 流式/非流式对话」
 * 用法：node test/e2e.js
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCK_PORT = 7911;
const GW_PORT = 7912;
const DATA = path.join(ROOT, '.e2e-data');

if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });

const procs = [];
function start(cmd, args, env, label) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env, PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[${label}!] ${d}`));
  procs.push(p);
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

async function main() {
  const node = process.execPath;
  start(node, ['test/mock-upstream.js', String(MOCK_PORT)], {}, 'mock');
  await sleep(400);
  start(node, ['src/server.js'], {
    PORT: String(GW_PORT),
    DATA_DIR: DATA,
    UPSTREAM_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    ADMIN_PASSWORD: 'testpw123',
  }, 'gw');
  await sleep(900);

  const B = `http://127.0.0.1:${GW_PORT}`;
  const jf = async (u, o = {}) => {
    const r = await fetch(B + u, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) } });
    const t = await r.text();
    let d; try { d = JSON.parse(t); } catch { d = t; }
    return { status: r.status, data: d, headers: r.headers };
  };

  console.log('\n[1] 登录');
  const login = await fetch(B + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'testpw123' }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
  check('登录成功并下发会话 Cookie', login.status === 200 && cookie.startsWith('dv_session='), cookie);

  const H = { Cookie: cookie };

  console.log('\n[2] 添加账号并同步模型');
  const acc = await jf('/api/accounts', {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'mock账号', cookie: 'SessionID=abc123; cbc-sid=zzz', cftk: 'tk-123' }),
  });
  check('账号创建成功', acc.status === 200 && acc.data.id > 0, JSON.stringify(acc.data));
  const accId = acc.data.id;
  await sleep(500);
  const accList = await jf('/api/accounts', { headers: H });
  check('账号列表可读', Array.isArray(accList.data) && accList.data.length === 1);
  const sync = await jf(`/api/accounts/${accId}/sync`, { method: 'POST', headers: H });
  check('同步拉取到模型', sync.data?.ok === true && sync.data.models.length === 2, JSON.stringify(sync.data).slice(0, 200));

  const models = await jf('/api/models', { headers: H });
  check('模型中心有缓存', models.data?.ids?.length === 2, JSON.stringify(models.data?.ids));

  console.log('\n[3] 密钥与鉴权');
  const key = await jf('/api/keys', { method: 'POST', headers: H, body: JSON.stringify({ name: 'k1' }) });
  check('密钥创建成功', key.status === 200 && key.data.secret?.startsWith('sk-ca-'), JSON.stringify(key.data).slice(0, 120));
  const secret = key.data.secret;

  const noauth = await jf('/v1/models');
  check('无密钥被拒绝 401', noauth.status === 401);

  const badKey = await jf('/v1/models', { headers: { Authorization: 'Bearer sk-wrong' } });
  check('错误密钥被拒绝 401', badKey.status === 401);

  const okModels = await jf('/v1/models', { headers: { Authorization: `Bearer ${secret}` } });
  check('密钥可取模型列表', okModels.status === 200 && okModels.data.data.length === 2, JSON.stringify(okModels.data).slice(0, 200));

  console.log('\n[4] 非流式对话');
  const chat = await jf('/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ model: 'DeepSeek-V3.2', messages: [{ role: 'user', content: '说句话' }] }),
  });
  const content = chat.data?.choices?.[0]?.message?.content || '';
  check('返回 200 与内容', chat.status === 200 && content.includes('收到'), JSON.stringify(chat.data).slice(0, 300));
  check('带 usage 统计', chat.data?.usage?.total_tokens > 0, JSON.stringify(chat.data?.usage));
  check('思维链被单独返回', typeof chat.data?.choices?.[0]?.message?.reasoning_content === 'string');

  console.log('\n[5] 流式对话');
  const sr = await fetch(B + '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'DeepSeek-V3.2', stream: true, messages: [{ role: 'user', content: '流式测试' }] }),
  });
  const raw = await sr.text();
  const chunks = raw.split('\n\n').filter((b) => b.startsWith('data: '));
  const hasDone = raw.includes('[DONE]');
  const hasRole = raw.includes('"role":"assistant"');
  const hasContent = raw.includes('收到') || raw.includes('你好');
  const hasFinish = raw.includes('"finish_reason":"stop"');
  check('SSE 返回 200', sr.status === 200, String(sr.status));
  check('含 data 块', chunks.length >= 3, `chunks=${chunks.length}`);
  check('首块带 role', hasRole);
  check('含正文增量', hasContent);
  check('有 finish_reason', hasFinish);
  check('以 [DONE] 结束', hasDone);

  console.log('\n[6] Anthropic Messages');
  const msg = await jf('/v1/messages', {
    method: 'POST', headers: { 'x-api-key': secret },
    body: JSON.stringify({ model: 'DeepSeek-V3.2', max_tokens: 100, messages: [{ role: 'user', content: '你好' }] }),
  });
  check('Anthropic 非流式成功', msg.status === 200 && msg.data?.content?.some((c) => c.type === 'text'), JSON.stringify(msg.data).slice(0, 200));

  console.log('\n[7] Responses API');
  const resp = await jf('/v1/responses', {
    method: 'POST', headers: { Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ model: 'DeepSeek-V3.2', input: '测试 responses' }),
  });
  check('Responses 返回 output_text', resp.status === 200 && typeof resp.data?.output_text === 'string' && resp.data.output_text.length > 0, JSON.stringify(resp.data).slice(0, 200));

  console.log('\n[8] 日志与用量');
  await sleep(200);
  const logs = await jf('/api/logs?limit=20', { headers: H });
  check('已记录调用日志', logs.data?.rows?.length >= 3, `rows=${logs.data?.rows?.length}`);
  check('日志含 token 统计', logs.data.rows.some((r) => r.total_tokens > 0));
  const ov = await jf('/api/stats/overview', { headers: H });
  check('概览统计有数据', ov.data?.today?.requests >= 3, JSON.stringify(ov.data?.today));
  const usage = await jf('/v1/usage', { headers: { Authorization: `Bearer ${secret}` } });
  check('密钥自查用量', usage.status === 200 && usage.data.used_requests >= 3, JSON.stringify(usage.data));

  console.log('\n[9] 额度与 IP 限制');
  const k2 = await jf('/api/keys', { method: 'POST', headers: H, body: JSON.stringify({ name: 'k2', quota: 1 }) });
  const s2 = k2.data.secret;
  await jf('/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${s2}` },
    body: JSON.stringify({ model: 'DeepSeek-V3.2', messages: [{ role: 'user', content: 'a' }] }),
  });
  const over = await jf('/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${s2}` },
    body: JSON.stringify({ model: 'DeepSeek-V3.2', messages: [{ role: 'user', content: 'b' }] }),
  });
  check('额度耗尽被拒 429', over.status === 429, `${over.status} ${JSON.stringify(over.data)}`);

  const k3 = await jf('/api/keys', { method: 'POST', headers: H, body: JSON.stringify({ name: 'k3', model_whitelist: ['Qwen3-Coder'] }) });
  const blocked = await jf('/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${k3.data.secret}` },
    body: JSON.stringify({ model: 'DeepSeek-V3.2', messages: [{ role: 'user', content: 'a' }] }),
  });
  check('模型白名单拦截 403', blocked.status === 403, `${blocked.status}`);

  console.log('\n[10] 多轮会话复用');
  const m1 = await jf('/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ model: 'DeepSeek-V3.2', messages: [{ role: 'user', content: '第一轮问题' }] }),
  });
  const last1 = await fetch(`http://127.0.0.1:${MOCK_PORT}/__last`, { headers: { Cookie: 'SessionID=x' } }).then((r) => r.json());
  const m2 = await jf('/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      model: 'DeepSeek-V3.2',
      messages: [
        { role: 'user', content: '第一轮问题' },
        { role: 'assistant', content: '第一轮回答' },
        { role: 'user', content: '第二轮追问' },
      ],
    }),
  });
  const last2 = await fetch(`http://127.0.0.1:${MOCK_PORT}/__last`, { headers: { Cookie: 'SessionID=x' } }).then((r) => r.json());
  check('首轮发送完整内容', last1.prompt.includes('第一轮问题'), last1.prompt.slice(0, 80));
  check('第二轮复用同一上游会话', last1.session === last2.session, `${last1.session} vs ${last2.session}`);
  check('第二轮只补最后一条 user', last2.prompt === '第二轮追问', last2.prompt.slice(0, 120));
  check('两轮均成功', m1.status === 200 && m2.status === 200);

  console.log('\n[11] 上游登录态失效');
  const accBad = await jf('/api/accounts', {
    method: 'POST', headers: H, body: JSON.stringify({ name: '坏账号', cookie: 'foo=bar' }),
  });
  await sleep(300);
  const badSync = await jf(`/api/accounts/${accBad.data.id}/sync`, { method: 'POST', headers: H });
  check('识别出登录态失效', badSync.data?.ok === false && /登录态/.test(badSync.data.error || ''), JSON.stringify(badSync.data).slice(0, 200));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  return fail === 0 ? 0 : 1;
}

main()
  .then((code) => { procs.forEach((p) => p.kill('SIGKILL')); process.exit(code); })
  .catch((e) => { console.error('自测异常：', e); procs.forEach((p) => p.kill('SIGKILL')); process.exit(1); });
