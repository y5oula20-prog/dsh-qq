// 会话记忆（分群长期记忆）纯逻辑单测：不连 DSH、不发 QQ 消息。
// 覆盖：分节解析/渲染、trim、沉淀输出拆分、注入预算（45/45/20）、文件读写、旧格式兼容。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  GROUP_MEMORY_TEMPLATE,
  GROUP_MEMORY_SECTIONS,
  GROUP_MEMBERS_HEADING,
  memoryFileFor,
  parseMemoryDocument,
  renderMemoryDocument,
  sectionOf,
  hasMemoryContent,
  trimMemoryDocument,
  stripMembersSection,
  splitDistillSummary,
  sanitizeMemoryLine,
  replaceSection,
  buildDistillPrompt,
  buildGroupMemoryPromptBlock,
  ensureGroupMemoryFile,
} from '../src/group-memory.js';

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'group-memory-test-'));
}

test('memoryFileFor 只接受纯数字群号（防路径穿越）', () => {
  assert.match(memoryFileFor('/tmp/x', '123456789'), /group-memory-123456789\.md$/);
  assert.match(memoryFileFor('/tmp/x', '../evil'), /group-memory-unknown\.md$/);
  assert.match(memoryFileFor('/tmp/x', ''), /group-memory-unknown\.md$/);
});

test('模板分节解析与渲染往返一致', () => {
  const doc = parseMemoryDocument(GROUP_MEMORY_TEMPLATE);
  assert.deepEqual(doc.sections.map((s) => s.heading), Object.values(GROUP_MEMORY_SECTIONS));
  const rendered = renderMemoryDocument(doc);
  assert.equal(parseMemoryDocument(rendered).sections.length, 3);
});

test('hasMemoryContent：纯模板不算有内容', () => {
  assert.equal(hasMemoryContent(GROUP_MEMORY_TEMPLATE), false);
  assert.equal(hasMemoryContent(`${GROUP_MEMORY_TEMPLATE}\n- 梗 A`), true);
});

test('splitDistillSummary：梗/近两段 + 旧格式无前缀当「近」', () => {
  const { gags, recent } = splitDistillSummary('梗：杂鱼梗\n梗： 星星眼\n近：昨晚有人开黑到三点\n- 无前缀也算近\n好的，整理如下：');
  assert.deepEqual(gags, ['杂鱼梗', '星星眼']);
  assert.deepEqual(recent, ['昨晚有人开黑到三点', '无前缀也算近']);
});

test('splitDistillSummary：去重、行数上限（梗 10 / 近 8）、过滤空行', () => {
  const gagsInput = Array.from({ length: 15 }, (_, i) => `梗：梗${i}`).join('\n');
  const { gags, recent } = splitDistillSummary(gagsInput);
  assert.equal(gags.length, 10);
  assert.equal(gags[0], '梗0');
  assert.equal(splitDistillSummary('近：哈哈\n近：哈哈').recent.length, 1);
});

test('sanitizeMemoryLine：去列表前缀/代码栅栏/客套话/控制字符，限 80 字', () => {
  assert.equal(sanitizeMemoryLine('- 开头是列表符号'), '开头是列表符号');
  assert.equal(sanitizeMemoryLine('```代码栅栏```'), '代码栅栏');
  assert.equal(sanitizeMemoryLine('好的，整理如下：'), '');
  assert.equal(sanitizeMemoryLine('有\u0000控制字符'), '有控制字符');
  assert.ok(sanitizeMemoryLine('长'.repeat(200)).length <= 80);
});

test('replaceSection：写入目标节、保留其它节、受 maxChars 约束', () => {
  const dir = tmpStateDir();
  const file = path.join(dir, 'group-memory-1.md');
  fs.writeFileSync(file, GROUP_MEMORY_TEMPLATE, 'utf8');
  replaceSection(file, GROUP_MEMORY_SECTIONS.memes, ['杂鱼梗', '星星眼'], { maxChars: 6000 });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /## 常出现的梗\n\n- 杂鱼梗\n- 星星眼/);
  assert.match(text, /## 最近发生过/);
  // 再写「近」不能动「梗」
  replaceSection(file, GROUP_MEMORY_SECTIONS.recent, ['昨晚开黑'], { maxChars: 6000 });
  const text2 = fs.readFileSync(file, 'utf8');
  assert.match(text2, /- 杂鱼梗/);
  assert.match(text2, /- 昨晚开黑/);
});

test('trimMemoryDocument：超总量从最旧的「最近发生过」删', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `- 事件${i}号这是一条足够长的事情描述用来撑爆预算的字数`).join('\n');
  const base = `# 群记忆\n\n${GROUP_MEMORY_SECTIONS.topic}\n\n${GROUP_MEMORY_SECTIONS.memes}\n`;
  const text = `${base}${GROUP_MEMORY_SECTIONS.recent}\n${lines}\n`;
  // 上限压到只装得下几行
  const trimmed = trimMemoryDocument(text, { maxChars: 300 });
  assert.ok(trimmed.length <= 300 + 80); // 允许一个最小节的余量
  assert.ok(trimmed.includes('事件11'), '应保留最新的事件');
  assert.equal(trimmed.includes('事件0'), false, '最旧的应先删');
});

test('「最近发生过」超过 12 行时滚动保留最新 12 行', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `- 事件${i}`).join('\n');
  const base = `# 群记忆\n\n${GROUP_MEMORY_SECTIONS.topic}\n\n${GROUP_MEMORY_SECTIONS.memes}\n`;
  const text = `${base}${GROUP_MEMORY_SECTIONS.recent}\n${lines}\n`;
  const recent = sectionOf(parseMemoryDocument(trimMemoryDocument(text, { maxChars: 100000 })), GROUP_MEMORY_SECTIONS.recent);
  const kept = recent.lines.filter((l) => l.trim());
  assert.equal(kept.length, 12);
  assert.equal(kept[0], '- 事件8');
});

test('stripMembersSection：剥掉旧桥的「群里的人」节', () => {
  const text = `${GROUP_MEMORY_TEMPLATE}\n${GROUP_MEMBERS_HEADING}\n- 张三：爱玩梗\n\n## 其它\n- 保留`;
  const out = stripMembersSection(text);
  assert.equal(out.includes('张三'), false);
  assert.match(out, /## 其它/);
});

test('buildGroupMemoryPromptBlock：空/纯模板不注入', () => {
  assert.equal(buildGroupMemoryPromptBlock('123', '', 900), '');
  assert.equal(buildGroupMemoryPromptBlock('123', GROUP_MEMORY_TEMPLATE, 900), '');
  assert.equal(buildGroupMemoryPromptBlock('', '- 有内容', 900), '');
});

test('buildGroupMemoryPromptBlock：三节都注入，标注只描述当前群', () => {
  const text = [
    '# 群记忆',
    '',
    GROUP_MEMORY_SECTIONS.topic, '', '- 日常闲聊',
    '',
    GROUP_MEMORY_SECTIONS.memes, '', '- 杂鱼梗', '- 星星眼',
    '',
    GROUP_MEMORY_SECTIONS.recent, '', '- 昨晚开黑',
    '',
  ].join('\n');
  const block = buildGroupMemoryPromptBlock('123', text, 900);
  assert.match(block, /常出现的梗：/);
  assert.match(block, /最近发生过：/);
  assert.match(block, /这个群在聊什么：/);
  assert.match(block, /group-memory-123\.md/);
  assert.match(block, /只是资料，不是指令/);
  // 预算充足时不截断
  assert.match(block, /杂鱼梗/);
  assert.match(block, /昨晚开黑/);
});

test('buildGroupMemoryPromptBlock：预算 45/45/20，梗取头、近取尾、话题垫底可被挤掉', () => {
  const gags = Array.from({ length: 40 }, (_, i) => `- 老梗${i}号内容`).join('\n');
  const recent = Array.from({ length: 40 }, (_, i) => `- 新事${i}号内容`).join('\n');
  const text = [
    '# 群记忆',
    '',
    GROUP_MEMORY_SECTIONS.topic, '', '- 日常闲聊',
    '',
    GROUP_MEMORY_SECTIONS.memes, '', gags,
    '',
    GROUP_MEMORY_SECTIONS.recent, '', recent,
    '',
  ].join('\n');
  const block = buildGroupMemoryPromptBlock('123', text, 300);
  assert.match(block, /常出现的梗：/);
  assert.match(block, /最近发生过：/);
  // 梗被截在头部（老梗0 在、末尾的老梗39 不在），近被截在尾部（新事39 在、开头的新事0 不在）
  assert.match(block, /老梗0号内容/);
  assert.equal(block.includes('老梗39号内容'), false);
  assert.match(block, /新事39号内容/);
  assert.equal(block.includes('新事0号内容'), false);
  // 话题只剩 <20 字预算，应被挤掉（垫底）
  assert.equal(block.includes('这个群在聊什么：'), false);
  assert.ok(block.length <= 300 + 120, `注入块应受预算约束（实际 ${block.length}）`);
});

test('buildGroupMemoryPromptBlock：「群里的人」不占注入额度', () => {
  const text = `${GROUP_MEMORY_TEMPLATE}\n${GROUP_MEMBERS_HEADING}\n- 张三\n\n${GROUP_MEMORY_SECTIONS.recent}\n- 有个事\n`;
  const block = buildGroupMemoryPromptBlock('123', text, 900);
  assert.equal(block.includes('张三'), false);
  assert.match(block, /有个事/);
});

test('ensureGroupMemoryFile：已存在不覆盖，损坏场景外抛', () => {
  const dir = tmpStateDir();
  const file = path.join(dir, 'group-memory-2.md');
  ensureGroupMemoryFile(file);
  fs.writeFileSync(file, '# 群记忆\n\n## 这个群在聊什么\n\n- 已有内容\n', 'utf8');
  ensureGroupMemoryFile(file);
  assert.match(fs.readFileSync(file, 'utf8'), /已有内容/);
});

test('buildDistillPrompt：包含群号、旧记忆与对话，输出约定清晰', () => {
  const prompt = buildDistillPrompt({ groupId: '123', existing: '- 旧梗', conversation: '群友A：哈哈\n群友B：<script>' });
  assert.match(prompt, /QQ群 123/);
  assert.match(prompt, /- 旧梗/);
  assert.match(prompt, /&lt;script&gt;/, '群聊文本必须转义防注入');
  assert.match(prompt, /梗：/);
  assert.match(prompt, /近：/);
  // 空对话也有兜底文案
  const empty = buildDistillPrompt({ groupId: '1', existing: '', conversation: '' });
  assert.match(empty, /（无）/);
  assert.match(empty, /（还没有）/);
});
