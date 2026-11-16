/** 用真实抓取到的 SSE 事件校验 normalizeEvent 映射 */
import { normalizeEvent } from '../src/bridge.js';

const real = [
  ['status', { status: 'initializing', turn_id: 't-1', message_id: '2122160273996767234', pool_used: false, ts: 1 }],
  ['status', { status: 'processing', turn_id: 't-1', ts: 1 }],
  ['file_diff', { diff: [], ts: 1 }],
  ['session_title', { title: '你好，打个招呼', turn_id: 't-1', ts: 1 }],
  ['thought', { content: '用户', index: 6, part_id: 'prt_1', ts: 1 }],
  ['message', { content: '你好！', index: 5, part_id: 'prt_2', ts: 1 }],
  ['step_finish', { reason: 'stop', tokens: { total: 27222, input: 24914, output: 4, reasoning: 0, cache: { write: 0, read: 2304 }, context: { tools: 0, mcp: 0, messages: 921, skills: 0, system_prompts: 26301 } }, cost: 0, ts: 1 }],
  ['done', { latency_ms: 6825, turn_id: 't-1', model: 'speed', tokens: { input: 24914, output: 4, reasoning: 0, cache: { read: 2304, write: 0 }, total: 27222, cost: 0 }, credit_cost_for_web: { credit_cost: 1.07, total_token_used: 30661 }, artifact_summary: { artifacts: [], total: 0 }, ts: 1 }],
];

for (const [ev, data] of real) {
  console.log(ev.padEnd(14), JSON.stringify(normalizeEvent({ event: ev, data })));
}
