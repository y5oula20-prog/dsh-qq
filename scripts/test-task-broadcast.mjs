// 任务播报（src/task-broadcast.js）的回归测试：配置归一化、状态卡触发条件、
// 心跳兜底、群内确认白名单。只用内存数据，不碰 state/ 里真实的桥接状态。
import {
  normalizeTaskBroadcastConfig,
  createTaskBroadcast,
  startTaskBroadcast,
} from '../src/task-broadcast.js';

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✅', name); }
  else { fail += 1; console.log('  ❌', name, extra); }
};

console.log('— 配置归一化 —');
const d = normalizeTaskBroadcastConfig(undefined, { ownerQQ: '2285964993' });
t('默认 enabled', d.enabled === true);
t('默认 groups 空（值在 config.json 里给）', d.groups.length === 0);
t('默认 sessions 解析成 owner 私聊 key', d.sessions.join() === 'private:2285964993');
t('默认心跳 10 分钟', d.heartbeatMinutes === 10, d.heartbeatMinutes);
t('非法群号被滤掉', normalizeTaskBroadcastConfig({ groups: ['309224785', 'abc', '0', ''] }, {}).groups.join() === '309224785');
t('owner 写法可解析', normalizeTaskBroadcastConfig({ sessions: ['owner', 'group:123'] }, { ownerQQ: '42' }).sessions.join() === 'private:42,group:123');
t('坏会话 key 被滤掉', normalizeTaskBroadcastConfig({ sessions: ['owner', 'nonsense'] }, { ownerQQ: '42' }).sessions.join() === 'private:42');
t('心跳非法值回落', normalizeTaskBroadcastConfig({ heartbeatMinutes: 9999 }, {}).heartbeatMinutes === 10);
t('ownerQQ 缺失时 sessions 为空', normalizeTaskBroadcastConfig({}, {}).sessions.length === 0);
t('enabled=false 保留', normalizeTaskBroadcastConfig({ enabled: false }, {}).enabled === false);

console.log('— 状态卡触发 —');
const OWNER_KEY = 'private:2285964993';
let nowMs = 1_700_000_000_000;
const sent = [];
const mk = (overrides = {}) => createTaskBroadcast({
  cfg: {
    ownerQQ: '2285964993',
    taskBroadcast: { groups: ['309224785'], confirmGroups: ['309224785'], ...overrides },
  },
  log: () => {},
  now: () => nowMs,
  notifyGroup: async (text) => { sent.push(text); },
});
const tb = mk();

// 非监视会话：完全静默
tb.onTurnStart('group:999', 's1');
tb.onToolCall('group:999', 'Bash');
await tb.onTurnEnd('group:999', { text: '做完了', reasonKind: 'completed' });
t('非监视会话不播报', sent.length === 0, JSON.stringify(sent));

// 正常工作回合：开工不刷屏，回合结束发一张状态卡
tb.onTurnStart(OWNER_KEY, 's1');
t('开工不发卡', sent.length === 0);
tb.onToolCall(OWNER_KEY, 'Bash');
tb.onToolCall(OWNER_KEY, 'Bash');
tb.onToolCall(OWNER_KEY, 'Read');
nowMs += 5 * 60_000;
await tb.onTurnEnd(OWNER_KEY, { text: '已经改好 config 并重启生效。', reasonKind: 'completed' });
t('回合结束发一张卡', sent.length === 1, JSON.stringify(sent));
t('卡里汇总工具次数', /Bash×2、Read|Read、Bash×2/.test(sent[0]), sent[0]);
t('卡里带结果文本', sent[0].includes('已经改好 config'));
t('卡里带时间', /📋 小柚状态卡 · \d{2}:\d{2}/.test(sent[0]), sent[0]);

// 纯聊天回合（无工具）：不播报
tb.onTurnStart(OWNER_KEY, 's1');
nowMs += 60_000;
await tb.onTurnEnd(OWNER_KEY, { text: '哈哈哈是的', reasonKind: 'completed' });
t('纯聊天回合不播报', sent.length === 1, JSON.stringify(sent));

// 中止回合：发「为啥停」卡
tb.onTurnStart(OWNER_KEY, 's1');
tb.onToolCall(OWNER_KEY, 'Bash');
nowMs += 60_000;
await tb.onTurnEnd(OWNER_KEY, { text: '', reasonKind: 'aborted' });
t('中止回合播报为啥停', sent.length === 2 && sent[1].includes('为啥停：回合被中止'), sent[1] ?? 'nothing');

// 等拍板：立即发卡；紧跟着的回合结束不重复补卡
tb.onTurnStart(OWNER_KEY, 's1');
tb.onToolCall(OWNER_KEY, 'Bash');
nowMs += 60_000;
await tb.onAwaitingInput(OWNER_KEY, 'approval', '🔐 审批 #12：agent 请求使用工具「Bash」…');
t('等拍板立即发卡', sent.length === 3 && sent[2].includes('等你拍板') && sent[2].includes('审批 #12'), sent[2] ?? 'nothing');
nowMs += 30_000;
await tb.onTurnEnd(OWNER_KEY, { text: '', reasonKind: 'completed' });
t('拍板卡之后回合结束不重复发', sent.length === 3, JSON.stringify(sent));

// 心跳兜底：长时间还在跑 → 心跳；闲置 → 不发
tb.onTurnStart(OWNER_KEY, 's1');
tb.onToolCall(OWNER_KEY, 'Bash');
nowMs += 30_000;
tb.tick();
t('没到心跳间隔不发', sent.length === 3);
nowMs += 11 * 60_000;
tb.tick();
t('超过心跳间隔发心跳卡', sent.length === 4 && sent[3].includes('还在跑'), sent[3] ?? 'nothing');
nowMs += 60_000;
tb.tick();
t('刚发过心跳不重复', sent.length === 4);
await tb.onTurnEnd(OWNER_KEY, { text: '完成', reasonKind: 'completed' });
t('心跳后回合结束正常发状态卡', sent.length === 5 && sent[4].includes('完成'), sent[4] ?? 'nothing');

// 闲置（无活动会话）心跳静默
nowMs += 30 * 60_000;
tb.tick();
t('闲置时心跳静默', sent.length === 5, JSON.stringify(sent));

// 等待中的心跳（还在等你）
tb.onTurnStart(OWNER_KEY, 's1');
await tb.onAwaitingInput(OWNER_KEY, 'question', '1. 用方案A还是方案B？');
nowMs += 11 * 60_000;
tb.tick();
t('长时间等待发「还在等你」', sent[sent.length - 1].includes('还在等你'), sent[sent.length - 1]);

console.log('— 开关与白名单 —');
const off = createTaskBroadcast({
  cfg: { ownerQQ: '2285964993', taskBroadcast: { enabled: false, groups: ['309224785'] } },
  log: () => {},
  now: () => nowMs,
  notifyGroup: async (text) => { sent.push(text); },
});
off.onTurnStart(OWNER_KEY, 's1');
off.onToolCall(OWNER_KEY, 'Bash');
await off.onTurnEnd(OWNER_KEY, { text: 'x', reasonKind: 'completed' });
t('enabled=false 全静默', sent.length === 7, JSON.stringify([sent.length]));
t('enabled=false 时 isConfirmGroup=false', off.isConfirmGroup('309224785') === false);
const noGroup = mk({ groups: [] });
t('groups 空时不发卡', (() => { const before = sent.length; noGroup.onTurnStart(OWNER_KEY, 's2'); noGroup.onToolCall(OWNER_KEY, 'Bash'); return before === sent.length; })());
t('isConfirmGroup 只认配置里的群', tb.isConfirmGroup('309224785') === true && tb.isConfirmGroup('2160059809') === false);
t('sourceKeys 指向 owner 私聊', tb.sourceKeys().join() === OWNER_KEY);
t('groups 访问器', tb.groups().join() === '309224785');

console.log('— startTaskBroadcast 定时器 —');
const tb2 = startTaskBroadcast({ cfg: { ownerQQ: '1', taskBroadcast: { groups: [] } }, log: () => {}, notifyGroup: async () => {} });
t('创建了心跳定时器', typeof tb2._timer === 'object' && tb2._timer !== null);
tb2.stop();
t('stop() 可清定时器', tb2._timer === null);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
