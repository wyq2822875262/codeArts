/**
 * 用真实抓包（test/fixtures/real-capture.json）校验协议层：
 * SSE 解析、事件归一化、cftk 提取与回写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseSse, extractCftk, patchCookieCftk } from '../src/upstream.js';
import { normalizeEvent, upstreamPayload } from '../src/bridge.js';

const F = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/real-capture.json'), 'utf8'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

function streamOf(text) {
  return new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
  });
}

console.log('\n[1] 真实 SSE 解析');
const events = [];
for await (const ev of parseSse(streamOf(F.sse))) events.push(ev);
check('事件条数与抓包一致', events.length === 7, String(events.length));
check('事件名序列正确',
  events.map((e) => e.event).join(',') === 'status,status,file_diff,session_title,message,step_finish,done',
  events.map((e) => e.event).join(','));
check('message 正文解析正确', events.find((e) => e.event === 'message')?.data?.content === '你好！');
check('done 带 usage', events.at(-1)?.data?.tokens?.total === 27222);

console.log('\n[2] 事件归一化');
const norm = events.map((e) => normalizeEvent(e)).filter(Boolean);
check('status 归一化', norm.some((n) => n.kind === 'status' && n.status === 'initializing'));
check('message 归一化为正文', norm.some((n) => n.kind === 'text' && n.text === '你好！'));
check('session_title 归一化为标题', norm.some((n) => n.kind === 'title' && n.title === '你好，打个招呼'));
check('step_finish 带 token 用量', norm.some((n) => n.kind === 'step' && n.tokens.total === 27222));
check('done 归一化并带 credit', norm.some((n) => n.kind === 'done' && n.credit?.credit_cost === 1.07));

console.log('\n[3] thought 事件（思维链）');
const tEvents = [];
for await (const ev of parseSse(streamOf(F.sseWithThought))) tEvents.push(ev);
const tNorm = tEvents.map((e) => normalizeEvent(e)).filter(Boolean);
check('thought 归一化为 reasoning', tNorm.some((n) => n.kind === 'reasoning' && n.text === '用户'), JSON.stringify(tNorm));

console.log('\n[4] 请求体与抓包一致');
const payload = upstreamPayload('说一句你好', 'speed', {});
check('model_id 为 slug', payload.model_id === 'speed');
check('repos 为空数组', Array.isArray(payload.repos) && payload.repos.length === 0);
check('content 透传', payload.content === '说一句你好');
const realBody = F.sendMessage.request.body;
check('字段集合与真实请求一致',
  JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(Object.keys(realBody).sort()),
  `${Object.keys(payload)} vs ${Object.keys(realBody)}`);

console.log('\n[5] cftk 提取与轮转回写');
const realCookie = 'HWWAFSESTIME=1; HWWAFSESID=2; devclouddevuibjtcftk=HCA0-889G-6BGR-8LBW-9EEI-6E04-AVBP-VGSZ; SessionID=3; cbc-sid=4';
check('从 cookie 提取 cftk', extractCftk(realCookie) === 'HCA0-889G-6BGR-8LBW-9EEI-6E04-AVBP-VGSZ', extractCftk(realCookie));
const rotated = 'HBWR-V23G-WLCS-LB69-SEI9-C80K-SYLF-5TCS';
const after = patchCookieCftk(realCookie, rotated);
check('回写后 cftk 更新', extractCftk(after) === rotated, extractCftk(after));
check('回写不影响其它 cookie', after.includes('SessionID=3') && after.includes('cbc-sid=4'));
check('回写不新增重复键', (after.match(/cftk=/g) || []).length === 1);

console.log('\n[6] 协议常量与抓包一致');
check('建会话必须带 agent-type: CodeBase', F.createSession.request.headers['agent-type'] === 'CodeBase');
check('发消息必须 Accept: text/event-stream', F.sendMessage.request.headers.Accept === 'text/event-stream');
check('模式头为 fastmode', F.sendMessage.request.headers['x-mode-type'] === 'fastmode');

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
