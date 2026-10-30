// 断线补收（src/backfill.js）的回归测试：配置归一化、断档检测、命令类识别、
// 补收筛选（时间窗/自己发的/重复/命令/太旧）、提示文案。
//
// 只用内存数据和临时文件，不碰 state/ 里真实的桥接状态。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeBackfillConfig,
  createUpstreamGapTracker,
  createSeenMessageIds,
  selectBackfill,
  isCommandLike,
  describeDuration,
  backfillNoticeBlock,
} from '../src/backfill.js';

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✅', name); }
  else { fail += 1; console.log('  ❌', name, extra); }
};

console.log('— 配置归一化 —');
const d = normalizeBackfillConfig(undefined);
t('默认 gapMs=120000', d.gapMs === 120000, d.gapMs);
t('默认 settleMs=10000', d.settleMs === 10000, d.settleMs);
t('默认 maxAgeMinutes=360', d.maxAgeMinutes === 360, d.maxAgeMinutes);
t('默认 maxPerConversation=50', d.maxPerConversation === 50, d.maxPerConversation);
t('非法值回落默认', normalizeBackfillConfig({ gapMs: 5 }).gapMs === 120000);
t('合法值保留', normalizeBackfillConfig({ gapMs: 180000 }).gapMs === 180000);
t('enabled=false 保留', normalizeBackfillConfig({ enabled: false }).enabled === false);

console.log('— 断档检测 —');
const tmpFile = path.join(os.tmpdir(), `dsh-qq-backfill-seen-${process.pid}.json`);
const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
fs.writeFileSync(tmpFile, JSON.stringify({ lastPacketAt: twoHoursAgo }));
const tr = createUpstreamGapTracker({ file: tmpFile });
const gap1 = tr.notePacket();
t('断 2 小时被检出', !!gap1 && gap1.gapMs > 2 * 3600 * 1000 - 5000, JSON.stringify(gap1));
t('since = 断前最后一个包', !!gap1 && gap1.since === twoHoursAgo);
t('紧接的下一包不算断', tr.notePacket() === null);
t('落盘时间已更新', Number(JSON.parse(fs.readFileSync(tmpFile, 'utf8')).lastPacketAt) > twoHoursAgo);
fs.unlinkSync(tmpFile);

console.log('— 命令类识别（补收时一律不执行）—');
for (const s of ['/level L3', '123456', '同意', '确认', 'y']) t(`"${s}" 判为命令`, isCommandLike(s) === true);
for (const s of ['今天天气不错', '我同意你的看法', '好的呀']) t(`"${s}" 判为非命令`, isCommandLike(s) === false);

console.log('— 补收筛选 —');
const now = Date.now();
const mk = (id, secOffset, text, uid = '111') => ({
  message_id: id,
  time: Math.floor((now + secOffset * 1000) / 1000),
  user_id: uid,
  self_id: '999',
  sender: { user_id: uid },
  message: [{ type: 'text', data: { text } }],
});
const msgs = [
  mk(1, -3000, '一小时以前的老消息'),   // 早于 since → 丢弃
  mk(2, -600, '断线期间的普通消息'),     // 保留
  mk(3, -500, '/level L3'),              // 命令 → 跳过
  mk(4, -400, '123456'),                 // 确认码 → 跳过
  mk(5, -300, '又一条普通消息'),         // 保留
  mk(6, -200, '我自己发的', '999'),      // 自己 → 丢弃
  mk(7, -100, '重复消息'),               // 保留
  mk(7, -100, '重复消息'),               // 同 id → 去重
];
const since = now - 900 * 1000;
const r = selectBackfill(msgs, { key: 'group:1', since, now, selfId: '999', config: {} });
t('保留 3 条普通消息', r.items.length === 3, r.items.map((x) => x.event.message_id).join(','));
t('跳过 2 条命令类', r.skippedCommands.length === 2, r.skippedCommands.length);
t('按时间升序', r.items[0].timeMs < r.items[r.items.length - 1].timeMs);
t('同 id 去重', new Set(r.items.map((x) => x.event.message_id)).size === r.items.length);

const seen = createSeenMessageIds();
seen.add('group:1', 2);
const r2 = selectBackfill(msgs, { key: 'group:1', since, now, selfId: '999', seen, config: {} });
t('已处理过的消息被剔除', !r2.items.some((x) => x.event.message_id === 2));

const r3 = selectBackfill([mk(8, -3600 * 7, '七小时前')], { key: 'group:1', since: now - 8 * 3600 * 1000, now, selfId: '999', config: {} });
t('超 6 小时标 tooOld', r3.items.length === 1 && r3.items[0].tooOld === true);

const r4 = selectBackfill(Array.from({ length: 80 }, (_, i) => mk(100 + i, -800 + i, `消息${i}`)), { key: 'group:1', since, now, selfId: '999', config: {} });
t('每会话最多 50 条', r4.items.length === 50, r4.items.length);

console.log('— 提示文案 —');
t('时长 <1h', describeDuration(37 * 60 * 1000) === '约 37 分钟', describeDuration(37 * 60 * 1000));
t('时长 >1h', describeDuration(125 * 60 * 1000) === '约 2 小时 5 分', describeDuration(125 * 60 * 1000));
const note = backfillNoticeBlock({ gapMs: 2 * 3600 * 1000, count: 3, earliestAgeMs: 100 * 60 * 1000 });
t('提示含断线时长与条数', note.includes('约 2 小时') && note.includes('3 条'), note);
t('提示要求别假装刚发', note.includes('不要假装'));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
