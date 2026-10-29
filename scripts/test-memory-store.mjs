// 记忆库纯逻辑单测：不连 DSH、不发 QQ 消息、不碰生产的 state 目录。
// 覆盖：分词、BM25 召回打分、作用域隔离、强度衰减、提示块预算、
//       沉淀输出解析（新旧格式兼容）、指纹去重、密钥过滤、旧文件迁移。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { tokenize, termFreq } from '../src/memory/tokenize.js';
import {
  recall, buildRecallBlock, scopeForSessionKey, scoreBm25, LAYER_WEIGHT,
} from '../src/memory/recall.js';
import {
  MemoryStore, decayedStrength, redactSecrets, hashContent,
  HALF_LIFE_DAYS, STRENGTH_FLOOR, SHORT_TERM_TTL_HOURS,
} from '../src/memory/store.js';
import { parseStructuredDistill, MAX_FACT_CHARS } from '../src/memory/distill.js';
import { MemoryService, parseLegacyMemoryFile, siftLegacyEntries } from '../src/memory/index.js';

function memStore() {
  return new MemoryStore(':memory:');
}

// ── 分词 ──────────────────────────────────────────────

test('tokenize：中文走二元切分，单字保留', () => {
  assert.deepEqual(tokenize('唱歌'), ['唱歌']);
  assert.deepEqual(tokenize('小柚唱歌'), ['小柚', '柚唱', '唱歌']);
  assert.deepEqual(tokenize('猫'), ['猫']);
});

test('tokenize：拉丁词小写整词，标点丢弃', () => {
  assert.deepEqual(tokenize('Hello, 世界!'), ['hello', '世界']);
  assert.deepEqual(tokenize('QQ123456789'), ['qq123456789']);
});

test('tokenize：空串与纯标点返回空数组', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('——……！？'), []);
});

test('termFreq：统计词频', () => {
  const tf = termFreq('唱歌唱歌跳舞');
  assert.equal(tf.get('唱歌'), 2);
  assert.equal(tf.get('跳舞'), 1);
});

// ── BM25 与召回 ───────────────────────────────────────

function makeEntry(over = {}) {
  const now = Date.now();
  return {
    id: over.id || `e-${Math.random().toString(36).slice(2, 8)}`,
    scope: 'group', scope_id: '1', layer: 'long_term',
    content: '', title: '', speaker: '', source: 'inferred',
    strength: 1, hits: 0, created_at: now, last_hit_at: now,
    expires_at: null, status: 'active', note: '',
    ...over,
  };
}

test('scoreBm25：命中的条目得分 > 0，无关条目不上榜', () => {
  const pool = [
    makeEntry({ id: 'a', content: '小柚喜欢唱歌' }),
    makeEntry({ id: 'b', content: '今天午饭吃了拉面' }),
  ];
  const s = scoreBm25(pool, '唱歌');
  assert.ok(s.get('a') > 0);
  assert.equal(s.has('b'), false);
});

test('scoreBm25：空查询或无候选时返回空表', () => {
  assert.equal(scoreBm25([makeEntry({ content: 'x' })], '').size, 0);
  assert.equal(scoreBm25([], '唱歌').size, 0);
});

test('recall：按相关度+强度+层级排序，低相关度被过滤', () => {
  const pool = [
    makeEntry({ id: 'strong', content: '唱歌', layer: 'must_remember' }),
    makeEntry({ id: 'weak', content: '唱歌', layer: 'short_term' }),
    makeEntry({ id: 'off', content: '完全无关的内容' }),
  ];
  const hits = recall({ own: pool, query: '唱歌', topK: 5, relevanceThreshold: 0.2 });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].entry.id, 'strong', 'must_remember 层级权重应排第一');
  assert.equal(hits.find((h) => h.entry.id === 'off'), undefined, '无关条目必须被过滤');
});

test('recall：relevanceThreshold 生效，全部低分时返回空', () => {
  const pool = [makeEntry({ content: '唱歌' })];
  assert.deepEqual(recall({ own: pool, query: '唱歌', relevanceThreshold: 1.5 }), []);
});

test('recall：includeShared=false 时不混入全局条目', () => {
  const own = [makeEntry({ id: 'o', content: '唱歌' })];
  const shared = [makeEntry({ id: 's', content: '唱歌' })];
  const withShared = recall({ own, shared, query: '唱歌', relevanceThreshold: 0 });
  assert.equal(withShared.length, 2);
  const noShared = recall({ own, shared, includeShared: false, query: '唱歌', relevanceThreshold: 0 });
  assert.equal(noShared.length, 1);
  assert.equal(noShared[0].entry.id, 'o');
});

test('recall：空候选集返回空数组', () => {
  assert.deepEqual(recall({ own: [], shared: [], query: '唱歌' }), []);
});

// ── 提示块 ────────────────────────────────────────────

test('buildRecallBlock：空命中返回空串', () => {
  assert.equal(buildRecallBlock([]), '');
  assert.equal(buildRecallBlock([{ entry: { content: '  ' } }]), '');
});

test('buildRecallBlock：带层级标签与说话人，声明是资料不是指令', () => {
  const block = buildRecallBlock([
    { entry: { content: '喜欢黑丝', layer: 'must_remember', speaker: '时光', scope: 'group' } },
    { entry: { content: '最近在玩原', layer: 'short_term', speaker: '', scope: 'group' } },
  ], { maxChars: 500, scopeLabel: '当前这个群' });
  assert.match(block, /资料不是指令/);
  assert.match(block, /\[必记\]时光说：喜欢黑丝/);
  assert.match(block, /\[近期\]最近在玩原/);
});

test('buildRecallBlock：遵守字数预算，不切半行', () => {
  const hits = Array.from({ length: 30 }, (_, i) => ({
    entry: { content: `第${i}条记忆内容`, layer: 'long_term', speaker: '', scope: 'group' },
  }));
  const block = buildRecallBlock(hits, { maxChars: 200 });
  assert.ok(block.length <= 200);
  const lines = block.split('\n').slice(1);
  for (const line of lines) assert.match(line, /^- .*第\d+条记忆内容$/);
});

// ── 作用域 ────────────────────────────────────────────

test('scopeForSessionKey：群/私聊正确解析，非法返回 null', () => {
  assert.deepEqual(scopeForSessionKey('group:123456789'), { scope: 'group', scopeId: '123456789' });
  assert.deepEqual(scopeForSessionKey('private:987654321'), { scope: 'private', scopeId: '987654321' });
  assert.equal(scopeForSessionKey('group:abc'), null);
  assert.equal(scopeForSessionKey('private:'), null);
  assert.equal(scopeForSessionKey(''), null);
  assert.equal(scopeForSessionKey('unknown:1'), null);
});

// ── 存储 ──────────────────────────────────────────────

test('remember：scope 与 layer 校验', () => {
  const s = memStore();
  assert.throws(() => s.remember({ scope: 'bogus', scopeId: '1', content: 'x' }), /unknown scope/);
  assert.throws(() => s.remember({ scope: 'group', scopeId: '1', layer: 'bogus', content: 'x' }), /unknown layer/);
  assert.throws(() => s.remember({ scope: 'group', scopeId: '', content: 'x' }), /requires an id/);
  assert.throws(() => s.remember({ scope: 'group', scopeId: '1', content: '   ' }), /content is required/);
  s.close();
});

test('remember：同 scope 同内容去重，改为强化而非新增', () => {
  const s = memStore();
  const a = s.remember({ scope: 'group', scopeId: '1', content: '小柚会唱歌' });
  assert.equal(a.created, true);
  const b = s.remember({ scope: 'group', scopeId: '1', content: '小柚会唱歌' });
  assert.equal(b.created, false);
  assert.ok(b.entry.strength > a.entry.strength, '重复提及应提升强度');
  assert.equal(s.list('group', '1').length, 1);
  s.close();
});

test('remember：不同群/不同人的同内容互不影响（作用域隔离）', () => {
  const s = memStore();
  s.remember({ scope: 'group', scopeId: '111', content: '喜欢黑丝' });
  s.remember({ scope: 'group', scopeId: '222', content: '喜欢黑丝' });
  s.remember({ scope: 'private', scopeId: '333', content: '喜欢黑丝' });
  assert.equal(s.list('group', '111').length, 1);
  assert.equal(s.list('group', '222').length, 1);
  assert.equal(s.list('private', '333').length, 1);
  assert.equal(s.stats().total, 3);
  s.close();
});

test('remember：short_term 带过期时间，long_term 不带', () => {
  const s = memStore();
  const short = s.remember({ scope: 'group', scopeId: '1', layer: 'short_term', content: '临时话题' });
  const long = s.remember({ scope: 'group', scopeId: '1', layer: 'long_term', content: '长期事实' });
  assert.ok(short.entry.expires_at > Date.now(), '短期记忆应有到期时间');
  assert.ok(Math.abs(short.entry.expires_at - Date.now() - SHORT_TERM_TTL_HOURS * 3_600_000) < 5000);
  assert.equal(long.entry.expires_at, null);
  s.close();
});

test('candidates：过期的 short_term 不进召回池，全局条目混入 shared', () => {
  const s = memStore();
  s.remember({ scope: 'group', scopeId: '1', layer: 'long_term', content: '群里的长期事实' });
  s.remember({ scope: 'global', content: '全局共享的事' });
  const { own, shared } = s.candidates('group', '1');
  assert.equal(own.length, 1);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].content, '全局共享的事');
  s.close();
});

test('hit：累加 hits 并回补强度', () => {
  const s = memStore();
  const { entry } = s.remember({ scope: 'group', scopeId: '1', content: '被想起来的事' });
  s.hit(entry.id);
  const after = s.byId(entry.id);
  assert.equal(after.hits, 1);
  assert.ok(after.strength > entry.strength);
  s.close();
});

test('archive：归档后不再出现在活跃列表', () => {
  const s = memStore();
  const { entry } = s.remember({ scope: 'group', scopeId: '1', content: '要归档的' });
  s.archive(entry.id);
  assert.equal(s.list('group', '1').length, 0);
  assert.equal(s.stats().total, 0);
  s.close();
});

// ── 衰减 ──────────────────────────────────────────────

test('decayedStrength：无时间流逝时等于原值，久远则衰减到地板', () => {
  const now = Date.now();
  const fresh = { strength: 1, layer: 'long_term', last_hit_at: now };
  assert.equal(decayedStrength(fresh, now), 1);

  const old = { strength: 1, layer: 'long_term', last_hit_at: now - 365 * 86_400_000 };
  const val = decayedStrength(old, now);
  // 一年不提的长期记忆按 30 天半衰期早该趋近 0，但地板保证它不会被彻底抹掉
  assert.equal(val, STRENGTH_FLOOR, '衰减必须停在地板，不能归零');
});

test('decayedStrength：must_remember 半衰期远长于 short_term', () => {
  const now = Date.now();
  const daysAgo = now - 30 * 86_400_000;
  const must = decayedStrength({ strength: 1, layer: 'must_remember', last_hit_at: daysAgo }, now);
  const short = decayedStrength({ strength: 1, layer: 'short_term', last_hit_at: daysAgo }, now);
  assert.ok(must > short, '必记的衰减必须慢于短期');
  assert.ok(HALF_LIFE_DAYS.must_remember > HALF_LIFE_DAYS.short_term);
});

test('LAYER_WEIGHT：必记 > 长期 > 短期', () => {
  assert.ok(LAYER_WEIGHT.must_remember > LAYER_WEIGHT.long_term);
  assert.ok(LAYER_WEIGHT.long_term > LAYER_WEIGHT.short_term);
});

// ── 密钥过滤与指纹 ────────────────────────────────────

test('redactSecrets：密钥、令牌、Cookie、密码被替换', () => {
  assert.match(redactSecrets('key 是 sk-abcdefgh12345678'), /\[REDACTED_KEY\]/);
  assert.match(redactSecrets('Bearer abcdefghijklmnopqrstuvwx.yyyyyy.zzzzzzzzzzzzzzzzzzzz'), /\[REDACTED_TOKEN\]/);
  assert.match(redactSecrets('cookie dsh-auth-AAAAAAAAAAAAAAAAAAAA'), /\[REDACTED_COOKIE\]/);
  assert.match(redactSecrets('密码：hunter2'), /\[REDACTED\]/);
  assert.equal(redactSecrets('普通聊天内容'), '普通聊天内容');
});

test('remember 写入前过滤密钥（库是明文的）', () => {
  const s = memStore();
  const { entry } = s.remember({ scope: 'group', scopeId: '1', content: '我的 key 是 sk-abcdefgh12345678' });
  assert.match(entry.content, /\[REDACTED_KEY\]/);
  assert.doesNotMatch(entry.content, /sk-abcdefgh/);
  s.close();
});

test('hashContent：忽略空白差异，不同内容不同指纹', () => {
  assert.equal(hashContent('小柚 会 唱歌'), hashContent('小柚会唱歌'));
  assert.notEqual(hashContent('小柚会唱歌'), hashContent('小柚会跳舞'));
});

// ── 沉淀解析 ──────────────────────────────────────────

test('parseStructuredDistill：梗/近/记/人 四类正确分类', () => {
  const out = parseStructuredDistill([
    '梗：杂鱼梗',
    '近：昨晚有人开黑到三点',
    '记：每周五晚上八点群里固定开黑',
    '人：时光 | 喜欢黑丝吊带',
    '好的，整理如下：',
  ].join('\n'));
  assert.deepEqual(out.gags, ['杂鱼梗']);
  assert.deepEqual(out.recent, ['昨晚有人开黑到三点']);
  assert.equal(out.facts.length, 2);
  // 按出现顺序保留：先「记：」后「人：」
  assert.deepEqual(out.facts[0], { speaker: '', content: '每周五晚上八点群里固定开黑' });
  assert.deepEqual(out.facts[1], { speaker: '时光', content: '喜欢黑丝吊带' });
});

test('parseStructuredDistill：旧格式（无前缀）全部归入近，facts 为空', () => {
  const out = parseStructuredDistill('- 无前缀也算近\n梗：老梗\n随便一句');
  assert.deepEqual(out.gags, ['老梗']);
  assert.ok(out.recent.includes('无前缀也算近'));
  assert.ok(out.recent.includes('随便一句'));
  assert.deepEqual(out.facts, []);
});

test('parseStructuredDistill：空壳前缀行被丢弃，不产生垃圾条目', () => {
  const out = parseStructuredDistill('梗：\n近：\n记：\n人： | \n人：时光 | ');
  assert.deepEqual(out.gags, []);
  assert.deepEqual(out.recent, []);
  assert.deepEqual(out.facts, []);
});

test('parseStructuredDistill：超长事实被截断到上限', () => {
  const long = '啊'.repeat(300);
  const out = parseStructuredDistill(`记：${long}`);
  assert.equal(out.facts.length, 1);
  assert.ok(out.facts[0].content.length <= MAX_FACT_CHARS);
});

test('parseStructuredDistill：空输入不炸', () => {
  const out = parseStructuredDistill('');
  assert.deepEqual(out, { gags: [], recent: [], facts: [] });
  assert.deepEqual(parseStructuredDistill(null), { gags: [], recent: [], facts: [] });
});

// ── 服务层 ────────────────────────────────────────────

test('MemoryService：dbFile 为 null 时整体禁用，blockFor 返回空串', () => {
  const svc = new MemoryService({ dbFile: null });
  assert.equal(svc.enabled, false);
  assert.equal(svc.blockFor('group:1', '唱歌'), '');
  assert.deepEqual(svc.ingestFacts('group:1', [{ content: 'x' }]), { created: 0, reinforced: 0 });
  svc.close();
});

test('MemoryService：写入后能按会话 key 召回，隔离到自己的群', () => {
  const svc = new MemoryService({ dbFile: ':memory:' });
  svc.ingestFacts('group:111', [{ content: '这个群每周五开黑' }, { speaker: '时光', content: '时光喜欢黑丝' }]);
  const ownBlock = svc.blockFor('group:111', '周五开黑');
  assert.match(ownBlock, /每周五开黑/);
  assert.match(ownBlock, /当前这个群/);

  const otherBlock = svc.blockFor('group:222', '周五开黑');
  assert.equal(otherBlock, '', '别的群不能召回这个群的记忆');
  svc.close();
});

test('MemoryService：scope 非法的 key 不召回也不写入', () => {
  const svc = new MemoryService({ dbFile: ':memory:' });
  assert.equal(svc.blockFor('bogus', '唱歌'), '');
  assert.deepEqual(svc.ingestFacts('bogus', [{ content: 'x' }]), { created: 0, reinforced: 0 });
  svc.close();
});

test('MemoryService：重复沉淀同一句记为强化而非新增', () => {
  const svc = new MemoryService({ dbFile: ':memory:' });
  const first = svc.ingestFacts('group:111', [{ content: '周五开黑' }]);
  assert.deepEqual(first, { created: 1, reinforced: 0 });
  const second = svc.ingestFacts('group:111', [{ content: '周五开黑' }]);
  assert.deepEqual(second, { created: 0, reinforced: 1 });
  svc.close();
});

test('MemoryService：召回后 hits 增加（命中回写生效）', () => {
  const svc = new MemoryService({ dbFile: ':memory:' });
  svc.ingestFacts('group:111', [{ content: '周五开黑' }]);
  svc.blockFor('group:111', '周五开黑');
  const [entry] = svc.store.list('group', '111');
  assert.ok(entry.hits >= 1);
  svc.close();
});

test('MemoryService：recallMaxChars 生效，块不超预算', () => {
  const svc = new MemoryService({ dbFile: ':memory:', recallMaxChars: 250 });
  const facts = Array.from({ length: 20 }, (_, i) => ({ content: `周五开黑第${i}次 记得带零食` }));
  svc.ingestFacts('group:111', facts);
  const block = svc.blockFor('group:111', '周五开黑');
  assert.ok(block.length <= 250, `块长度 ${block.length} 应 <= 250`);
  svc.close();
});

test('MemoryService：迁移旧行幂等，重复调用不重复入库', () => {
  const svc = new MemoryService({ dbFile: ':memory:' });
  const lines = ['当有人提到原就说我超原', '柚宝喜欢黑丝'];
  const n1 = svc.migrateLines('group', '111', lines);
  assert.equal(n1, 2);
  const n2 = svc.migrateLines('group', '111', lines);
  assert.equal(n2, 0, '第二次迁移应全部命中指纹去重');
  svc.close();
});

// ── 旧文件迁移解析 ────────────────────────────────────

test('parseLegacyMemoryFile：解析「手动记的」下的日期前缀条目', () => {
  const text = [
    '# 柚宝的长期记忆',
    '',
    '## 手动记的',
    '',
    '- 2026-10-26 16:44:35 当有人提到“原”的时候，你就说：“我超，原！”',
    '- 2026-10-26 大群的「群看点」清单已经存在群记忆里',
    '- 2026-10-26 23:10:09 ，星裂是 zako',
    '不是列表的行被忽略',
  ].join('\n');
  const out = parseLegacyMemoryFile(text);
  assert.equal(out.length, 3);
  assert.equal(out[0].section, '手动记的');
  assert.match(out[0].content, /^当有人提到/);
  assert.equal(out[2].content, '星裂是 zako', '行首多余逗号应被去掉');
});

test('parseLegacyMemoryFile：空文件与纯标题返回空数组', () => {
  assert.deepEqual(parseLegacyMemoryFile(''), []);
  assert.deepEqual(parseLegacyMemoryFile('# 标题\n## 空节\n'), []);
});

test('siftLegacyEntries：事实迁走，「提到 X 就说 Y」的反应规则留给黑话系统', () => {
  const items = [
    { section: '手动记的', content: '当有人提到“原”的时候，你就说：“我超，原！”' },
    { section: '手动记的', content: '有人提“星裂”就回复 “zako”' },
    { section: '手动记的', content: '有人提到“原”就说“哪来的原批”' },
    { section: '手动记的', content: '当提到“妖管”，你要说：“我的第一志愿是妖管！”' },
    { section: '手动记的', content: '大群的「群看点」清单已经存在群记忆里，别在主人记忆里重复' },
    { section: '手动记的', content: '星裂是 zako' },
    { section: '手动记的', content: '你主人喜欢女装' },
    { section: '手动记的', content: '群主是一个笨蛋乌鸦' },
  ];
  const { facts, skipped } = siftLegacyEntries(items);
  assert.deepEqual(facts.map((f) => f.content), ['星裂是 zako', '你主人喜欢女装', '群主是一个笨蛋乌鸦']);
  assert.equal(skipped.rule, 4, '四条反应规则应归黑话');
  assert.equal(skipped.meta, 1, '一条旧系统说明行应丢弃');
  assert.deepEqual(siftLegacyEntries([]).facts, []);
  assert.deepEqual(siftLegacyEntries(null).facts, []);
  assert.equal(siftLegacyEntries([{ content: '   ' }]).facts.length, 0, '空内容跳过');
});

// ── 落盘（真实文件）──────────────────────────────────

test('MemoryStore：写入真实文件后可重新打开读到', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-store-'));
  const dbFile = path.join(dir, 'memory.sqlite3');
  const s1 = new MemoryStore(dbFile);
  s1.remember({ scope: 'group', scopeId: '123456789', content: '大群周五开黑' });
  s1.setMeta('schema', '1');
  s1.close();

  const s2 = new MemoryStore(dbFile);
  assert.equal(s2.list('group', '123456789').length, 1);
  assert.equal(s2.getMeta('schema'), '1');
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
