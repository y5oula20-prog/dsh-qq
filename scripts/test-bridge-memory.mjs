// 逐条记忆库接进桥之后的端到端契约：召回注入、按群/按人隔离、关掉开关的行为、
// 旧桥 memory.md 的一次性迁移。全部离线、假数据（夹具里的假号 123 / 456）。
//   ① 群聊注入：召回块出现在投递的 prompt 里，位置在群梗之后、正文之前；
//   ② 隔离：A 群写的事实不会出现在 B 群；私聊事实只在私聊里出现；
//   ③ 开关：recallEnabled=false 时不注入，但写入仍然保留（重新打开即可用）；
//   ④ 迁移：旧 memory.md 只迁「事实」，反应规则留给黑话系统，且只迁一次。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const GROUP_KEY = 'group:456';
const OTHER_GROUP_KEY = 'group:789';
const OWNER_KEY = 'private:123';
const promptText = (p) => (Array.isArray(p?.content) ? p.content.map((c) => String(c?.text ?? '')).join('\n') : '');
const settle = () => new Promise((r) => setTimeout(r, 40));
const lastPrompt = (h) => promptText(h.calls.prompts.at(-1));

async function withHarness(config, run) {
  const h = await bridgeHarness({ config });
  try {
    h.setMode('reserved2');
    await run(h);
  } finally {
    await h.close();
  }
}

test('① 群聊召回：相关事实进 prompt，无关的不进', async () => {
  await withHarness({}, async (h) => {
    assert.ok(h.memoryService?.enabled, '记忆库应该开着');
    h.memoryService.store.remember({ scope: 'group', scopeId: '456', layer: 'long_term', content: '群主养了一只叫团子的猫', source: 'told' });
    h.memoryService.store.remember({ scope: 'group', scopeId: '456', layer: 'long_term', content: '上周有人通宵打游戏到三点', source: 'told' });

    await h.deliverPrompt(GROUP_KEY, '团子今天又拆家了，你说说它');
    await settle();
    const text = lastPrompt(h);
    assert.match(text, /【你记得的事】/, '应该有召回块');
    assert.match(text, /群主养了一只叫团子的猫/, '相关事实应该被召回');
    assert.ok(!text.includes('通宵打游戏'), '无关事实不该塞进来');

    // 位置：召回块在正文之前（提示词末尾才是本轮正文）
    const idxBlock = text.indexOf('【你记得的事】');
    const idxBody = text.indexOf('团子今天又拆家了');
    assert.ok(idxBlock > 0 && idxBody > idxBlock, '召回块应在正文之前');
  });
});

test('② 隔离：跨群/跨人不串味', async () => {
  await withHarness({}, async (h) => {
    h.memoryService.store.remember({ scope: 'group', scopeId: '456', layer: 'long_term', content: '这个群的暗号是菠萝披萨', source: 'told' });
    h.memoryService.store.remember({ scope: 'group', scopeId: '789', layer: 'long_term', content: '另一个群的暗号是榴莲蛋糕', source: 'told' });
    h.memoryService.store.remember({ scope: 'private', scopeId: '123', layer: 'long_term', content: '主人怕打雷', source: 'user_said' });

    await h.deliverPrompt(GROUP_KEY, '暗号是什么来着');
    await settle();
    const g = lastPrompt(h);
    assert.match(g, /菠萝披萨/);
    assert.ok(!g.includes('榴莲蛋糕'), '别的群的事不该出现');
    assert.ok(!g.includes('怕打雷'), '私聊的事不该出现在群里');

    await h.deliverPrompt(OWNER_KEY, '我有点怕打雷');
    await settle();
    const p = lastPrompt(h);
    assert.match(p, /主人怕打雷/, '私聊该记得自己的事');
    assert.ok(!p.includes('菠萝披萨'), '私聊不该带群聊记忆');
  });
});

test('③ 开关：recallEnabled=false 不注入', async () => {
  await withHarness({ memory: { recallEnabled: false } }, async (h) => {
    h.memoryService.store.remember({ scope: 'group', scopeId: '456', layer: 'long_term', content: '群主养了一只叫团子的猫', source: 'told' });
    await h.deliverPrompt(GROUP_KEY, '团子今天怎么样');
    await settle();
    assert.ok(!lastPrompt(h).includes('【你记得的事】'), '关掉开关就不该注入');
    assert.ok(!lastPrompt(h).includes('团子的猫'), '关掉开关连内容都不该有');
  });
});

test('④ 旧 memory.md 迁移：只迁事实、只迁一次', async () => {
  const legacy = [
    '# 柚宝的长期记忆',
    '',
    '## 手动记的',
    '',
    '- 2026-10-26 16:44:35 星裂是 zako',
    '- 2026-10-26 你主人喜欢女装',
    '- 2026-10-26 当有人提到“原”的时候，你就说：“我超，原！”',
    '- 2026-10-26 大群的「群看点」清单已经存在群记忆里，别在主人记忆里重复',
  ].join('\n');
  const h = await bridgeHarness({ files: { 'legacy-memory.md': legacy } });
  try {
    // 夹具默认把 legacyFile 指向不存在的文件，这里改指到临时目录里的那份
    h.cfg.memory.legacyFile = path.join(h.temp, 'legacy-memory.md');
    h.migrateLegacyMemoryOnce();
    const list = h.memoryService.store.list('global', '');
    const contents = list.map((e) => e.content);
    assert.deepEqual(contents.sort((a, b) => a.localeCompare(b)), ['星裂是 zako', '你主人喜欢女装'].sort((a, b) => a.localeCompare(b)), '只迁事实，规则与说明行都跳过');
    assert.equal(h.memoryService.store.getMeta('legacy-memory-migrated') !== null, true, '迁完要打标记');

    // 再跑一次：不能重复写
    const before = h.memoryService.store.list('global', '').length;
    h.migrateLegacyMemoryOnce();
    assert.equal(h.memoryService.store.list('global', '').length, before, '第二次不该再写');
  } finally { await h.close(); }
});
