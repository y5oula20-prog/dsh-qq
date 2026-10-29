// createTurnCollector 的纯逻辑单测：重点锁住「漏掉 turn/start 也能不丢回复」这条兜底。
// 背景：follow 流从登记订阅到 DSH 真正打开会话流之间有几十毫秒空档，紧跟其后的 prompt
// 可能让 turn/start 落进空档；此前 collector 建不出槽位，assistant/message 无处累加、
// turn/end 返回 null，整轮回复被静默丢弃（QQ 上没消息、token 照付）。
// 见 scripts/test-dsh-v2-wait.mjs 的 SEEDED_FROM_SNAPSHOT 与 src/dsh-client.js push()。
import { createTurnCollector } from '../src/dsh-client.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log('✅ ' + name); }
  else { fail += 1; console.log('❌ ' + name + (detail ? ' — ' + detail : '')); }
};
const turnStart = (turn) => ({ type: 'turn/start', data: { turn } });
const stepStart = (turn) => ({ type: 'step/start', data: { turn } });
const assistant = (turn, text) => ({ type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } });
const turnEnd = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } });

// ① 正常路径
{
  const c = createTurnCollector();
  check('① turn/start 建槽，未结束时 size=1', c.push(turnStart(1)) === null && c.size() === 1);
  check('① assistant/message 不终结回合', c.push(assistant(1, '你好')) === null);
  const ended = c.push(turnEnd(1));
  check('① turn/end 返回完整文本', ended?.turn === 1 && ended.text === '你好' && ended.reason.kind === 'completed',
    JSON.stringify(ended));
  check('① 结束后 size 归零', c.size() === 0);
}

// ② 漏掉 turn/start：只有 step/start
{
  const c = createTurnCollector();
  c.push(stepStart(1));
  check('② 只有 step/start 也能建槽', c.size() === 1);
  c.push(assistant(1, '兜底成功'));
  const ended = c.push(turnEnd(1));
  check('② 漏掉 turn/start 的回合仍能取到文本', ended?.text === '兜底成功', JSON.stringify(ended));
}

// ③ step/start 不能复活已结束的回合
{
  const c = createTurnCollector();
  c.push(turnStart(1));
  c.push(assistant(1, 'A'));
  c.push(turnEnd(1));
  c.push(stepStart(1));            // 迟到的 step/start
  check('③ 已结束回合不会被 step/start 复活', c.size() === 0);
  const late = c.push(turnEnd(1));
  check('③ 已结束回合再次 turn/end 返回 null（不重复发消息）', late === null, JSON.stringify(late));
}

// ④ assistant/chunk 不重复累加
{
  const c = createTurnCollector();
  c.push(turnStart(1));
  c.push({ type: 'assistant/chunk', data: { turn: 1, delta: '收到' } });
  c.push(assistant(1, '收到'));
  check('④ assistant/chunk 被忽略，文本不翻倍', c.push(turnEnd(1))?.text === '收到');
}

// ⑤ 多回合互不干扰
{
  const c = createTurnCollector();
  c.push(turnStart(1)); c.push(assistant(1, '一'));
  c.push(turnStart(2)); c.push(assistant(2, '二'));
  check('⑤ 两个回合并行时 size=2', c.size() === 2);
  const e2 = c.push(turnEnd(2));
  const e1 = c.push(turnEnd(1));
  check('⑤ 各自取到自己的文本', e2.text === '二' && e1.text === '一', JSON.stringify([e1, e2]));
}

// ⑥ 未知 type 一律 null
{
  const c = createTurnCollector();
  check('⑥ 未知事件返回 null', c.push({ type: 'whatever', data: {} }) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
