// 出站防呆的单元测试：表情库 id 泄漏、跨轮次复读。
// 跑法：node scripts/test-outbound-guard.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STICKER_FILE_ID_RE,
  normalizeOutboundText,
  stickerIdLeakIn,
  findStickerIdLeaks,
  resolveRepeatGuard,
  findRepeatedMessages,
  repeatWarningText,
  REPEAT_GUARD_DEFAULTS
} from '../src/outbound-guard.js';

const LEAK_ID = '836923945_0_0_0_0278548D41D1FC132D63D936B193E4EC_0_0';

test('真实形态的表情库文件名能被识别，普通文本不会被误判', () => {
  assert.equal(stickerIdLeakIn(LEAK_ID), LEAK_ID);
  assert.equal(stickerIdLeakIn(`  ${LEAK_ID}  `), LEAK_ID);
  assert.equal(stickerIdLeakIn(`"${LEAK_ID}"`), LEAK_ID);
  assert.equal(stickerIdLeakIn('861234567_0_0_0_' + 'AB'.repeat(16) + '_0_0'), '861234567_0_0_0_' + 'AB'.repeat(16) + '_0_0');
  // 不该误伤的：
  assert.equal(stickerIdLeakIn('123_0_0_0_short_0_0'), null, '长度不对的 hex 不是表情 id');
  assert.equal(stickerIdLeakIn('我今天发了 836923945_0_0_0_' + 'A'.repeat(32) + '_0_0 这个表情'), null, '夹在话里的不算整条泄漏');
  assert.equal(stickerIdLeakIn('今天好累'), null);
  assert.equal(stickerIdLeakIn(''), null);
  assert.equal(stickerIdLeakIn(null), null);
  assert.match(LEAK_ID, STICKER_FILE_ID_RE);
});

test('一批消息里只挑出泄漏的那几条，索引从 0 开始', () => {
  const { indexes, ids } = findStickerIdLeaks(['第一句正常的', LEAK_ID, '第三句也正常']);
  assert.deepEqual(indexes, [1]);
  assert.deepEqual(ids, [LEAK_ID]);
  assert.deepEqual(findStickerIdLeaks(['都正常', '也正常']), { indexes: [], ids: [] });
  assert.deepEqual(findStickerIdLeaks(null), { indexes: [], ids: [] });
});

test('归一化：去空白、去标点、统一小写', () => {
  assert.equal(normalizeOutboundText(' 你好， 世界！ '), '你好世界');
  assert.equal(normalizeOutboundText('Hello, World.'), 'helloworld');
  assert.equal(normalizeOutboundText('嗯'), '嗯');
  assert.equal(normalizeOutboundText(undefined), '');
});

test('跨轮次复读能抓到，短应答永远不算复读', () => {
  const now = 1_800_000_000_000;
  const recent = [
    { isSelf: true, text: '诶嘿就想糊弄过去呀，至少赔我一句正经的', time: now - 60_000 },
    { isSelf: true, text: '嗯', time: now - 30_000 },
    { isSelf: true, text: '睡吧，明天还要早起呢', time: now - 20_000 }
  ];
  // 完全相同（只差标点）
  const same = findRepeatedMessages(['诶嘿就想糊弄过去呀，至少赔我一句正经的。'], recent, { now });
  assert.equal(same.length, 1);
  assert.equal(same[0].index, 0);
  // 短应答不拦
  assert.deepEqual(findRepeatedMessages(['嗯'], recent, { now }), []);
  assert.deepEqual(findRepeatedMessages(['嗯嗯'], recent, { now }), [], '去标点后仍不足 minChars 也不拦');
  // 新句子不拦
  assert.deepEqual(findRepeatedMessages(['今天风好大，窗户一直在响'], recent, { now }), []);
  // 别人说的不算：isSelf=false 的历史不参与比对
  const others = [{ isSelf: false, text: '诶嘿就想糊弄过去呀，至少赔我一句正经的', time: now - 60_000 }];
  assert.deepEqual(findRepeatedMessages(['诶嘿就想糊弄过去呀，至少赔我一句正经的'], others, { now }), []);
});

test('超出时间窗口的历史不参与比对', () => {
  const now = 1_800_000_000_000;
  const old = [{ isSelf: true, text: '这句话是半小时前说的', time: now - 30 * 60_000 }];
  assert.deepEqual(findRepeatedMessages(['这句话是半小时前说的'], old, { now }), []);
  const fresh = [{ isSelf: true, text: '这句话是一分钟前说的', time: now - 60_000 }];
  assert.equal(findRepeatedMessages(['这句话是一分钟前说的'], fresh, { now }).length, 1);
});

test('配置解析：缺省值、关掉开关、非法值回退', () => {
  assert.deepEqual(resolveRepeatGuard(undefined), REPEAT_GUARD_DEFAULTS);
  assert.equal(resolveRepeatGuard({ enabled: false }).enabled, false);
  assert.equal(resolveRepeatGuard({ minChars: 'abc' }).minChars, REPEAT_GUARD_DEFAULTS.minChars);
  assert.equal(resolveRepeatGuard({ minChars: -3 }).minChars, REPEAT_GUARD_DEFAULTS.minChars);
  assert.equal(resolveRepeatGuard({ lookback: 3 }).lookback, 3);
});

test('关掉开关后一条都不报', () => {
  const now = 1_800_000_000_000;
  const recent = [{ isSelf: true, text: '诶嘿就想糊弄过去呀，至少赔我一句正经的', time: now - 60_000 }];
  assert.deepEqual(findRepeatedMessages(['诶嘿就想糊弄过去呀，至少赔我一句正经的'], recent, { now, enabled: false }), []);
});

test('提醒文案带上条号与原话，没有命中返回 null', () => {
  assert.equal(repeatWarningText([]), null);
  assert.equal(repeatWarningText(null), null);
  const text = repeatWarningText([{ index: 0, text: 'a', previous: '原话' }]);
  assert.match(text, /第 1 条/);
  assert.match(text, /原话/);
  assert.match(text, /换个说法/);
});
