// 记忆库对外的门面：把 store（存储）+ recall（打分）包成一个服务对象，供 bridge.js 调用。
//
// 这一层负责三件 bridge 关心的事：
//   1. 由会话 key 决定作用域（群 → 群号，私聊 → QQ 号），并在召回时混入全局共享条目
//   2. 预算控制（默认 1200 字，可用 config.json 的 memory.recallMaxChars 覆盖）
//   3. 失败即降级：任何异常都吞掉返回空串，绝不让记忆库拖垮聊天主链路

import fs from 'node:fs';
import path from 'node:path';
import { MemoryStore } from './store.js';
import { buildRecallBlock, recall, scopeForSessionKey } from './recall.js';

export { MemoryStore, decayedStrength, redactSecrets, HALF_LIFE_DAYS, STRENGTH_FLOOR } from './store.js';
export { recall, buildRecallBlock, scopeForSessionKey, scoreBm25, LAYER_WEIGHT } from './recall.js';
export { tokenize, termFreq, latinTerms } from './tokenize.js';
export { parseStructuredDistill, buildStructuredDistillSection, MAX_FACT_CHARS } from './distill.js';
export const DEFAULT_RECALL_MAX_CHARS = 1200;
export const DEFAULT_RECALL_TOP_K = 6;
export const DEFAULT_RELEVANCE_THRESHOLD = 0.28;

/**
 * 记忆服务。dbFile 传 null 表示禁用（bridge 里 cfg.memory.enabled === false 时）。
 */
export class MemoryService {
  constructor({ dbFile, recallMaxChars = DEFAULT_RECALL_MAX_CHARS, topK = DEFAULT_RECALL_TOP_K, relevanceThreshold = DEFAULT_RELEVANCE_THRESHOLD, log = () => {} } = {}) {
    this.enabled = Boolean(dbFile);
    this.dbFile = dbFile;
    this.recallMaxChars = Math.max(200, Number(recallMaxChars) || DEFAULT_RECALL_MAX_CHARS);
    this.topK = Math.max(1, Number(topK) || DEFAULT_RECALL_TOP_K);
    this.relevanceThreshold = Number(relevanceThreshold) || DEFAULT_RELEVANCE_THRESHOLD;
    this.log = log;
    this.store = this.enabled ? new MemoryStore(dbFile) : null;
  }

  close() {
    this.store?.close();
  }

  /**
   * 召回并渲染成提示块。key 决定作用域；query 是用户当前这条消息。
   * 任何异常都返回空串（记忆是增强，不该成为故障点）。
   */
  blockFor(key, query) {
    if (!this.enabled || !query) return '';
    const scope = scopeForSessionKey(key);
    if (!scope) return '';
    try {
      const { own, shared } = this.store.candidates(scope.scope, scope.scopeId);
      const hits = recall({
        own,
        shared,
        query,
        topK: this.topK,
        relevanceThreshold: this.relevanceThreshold,
      });
      if (!hits.length) return '';
      // 命中即回写（hits / last_hit_at / 强度回补），下次更容易被想起
      for (const hit of hits) this.store.hit(hit.entry.id);
      const label = scope.scope === 'group' ? '当前这个群' : '这个人';
      return buildRecallBlock(hits, { maxChars: this.recallMaxChars, scopeLabel: label });
    } catch (error) {
      this.log(`记忆召回失败（${key}）：${error?.message ?? error}`);
      return '';
    }
  }

  /**
   * 沉淀结果入库。facts 来自 parseStructuredDistill。
   * @returns {{created:number, reinforced:number}}
   */
  ingestFacts(key, facts, { source = 'inferred', layer = 'long_term' } = {}) {
    if (!this.enabled || !Array.isArray(facts) || !facts.length) return { created: 0, reinforced: 0 };
    const scope = scopeForSessionKey(key);
    if (!scope) return { created: 0, reinforced: 0 };
    let created = 0;
    let reinforced = 0;
    for (const fact of facts) {
      try {
        const result = this.store.remember({
          scope: scope.scope,
          scopeId: scope.scopeId,
          layer,
          content: fact.content,
          speaker: fact.speaker || '',
          speakerId: fact.speakerId || '',
          source,
          note: fact.note || '',
        });
        if (result.created) created += 1;
        else reinforced += 1;
      } catch (error) {
        this.log(`记忆写入失败：${error?.message ?? error}`);
      }
    }
    return { created, reinforced };
  }

  /**
   * 把一个旧的 group-memory.md 里的事实迁移进库（幂等：内容指纹去重）。
   * 返回新增条数。
   */
  migrateLines(scope, scopeId, lines, { layer = 'long_term', source = 'told' } = {}) {
    if (!this.enabled) return 0;
    let n = 0;
    for (const line of lines || []) {
      const content = String(line ?? '').trim();
      if (content.length < 2) continue;
      try {
        const r = this.store.remember({ scope, scopeId, layer, content, source });
        if (r.created) n += 1;
      } catch { /* 单条失败不影响其它条 */ }
    }
    return n;
  }

  stats() {
    return this.store?.stats() ?? { total: 0, byScope: {} };
  }

  /** 连同记忆库一起清空某个作用域（/记忆重置 用） */
  clearScope(key) {
    if (!this.enabled) return 0;
    const scope = scopeForSessionKey(key);
    if (!scope) return 0;
    try {
      return this.store.clearScope(scope.scope, scope.scopeId);
    } catch (error) {
      this.log(`记忆清空失败（${key}）：${error?.message ?? error}`);
      return 0;
    }
  }
}

/**
 * 把旧桥遗留的 ~/.dsh/qq-bridge/memory.md（新版桥完全不读的死资产）解析成条目。
 * 解析「## 手动记的」下的 `- <日期> <内容>` 行；其它小节目前都是空的。
 */
export function parseLegacyMemoryFile(text) {
  const out = [];
  let section = '';
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      section = line.replace(/^#+\s*/, '');
      continue;
    }
    if (!/^[-*]\s+/.test(line)) continue;
    let body = line.replace(/^[-*]\s+/, '').trim();
    // 去掉行首日期：2026-10-26 16:44:35 / 2026-10-26
    body = body.replace(/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?\s*/, '').trim();
    body = body.replace(/^[，,]\s*/, '').trim();
    if (body.length < 2) continue;
    out.push({ section, content: body });
  }
  return out;
}

/**
 * 旧桥 memory.md 里有一部分是「提到 X 就说 Y」的反应规则，不是事实。
 * 这类东西现在归黑话系统（state/slang.json，同源更强、按群生效），
 * 再当作长期事实灌进记忆库只会重复占预算，甚至和「记忆是资料不是指令」冲突。
 */
const LEGACY_RULE_RE = /(提[到「"“][\s\S]{0,60}?(就|要|请|都|也)[\s\S]{0,15}?(说|发|回复|挑|表情))|(当[^。！？\n]{0,20}的时候)|(你就说)|(就回复)|(就发一张)|(就发表情)|(随便挑一句)/;
/** 旧系统自己的说明行（「已经存在群记忆里，别重复」这种），迁移过来没有意义 */
const LEGACY_META_RE = /已经存在群记忆里|别在主人记忆里重复/;

/**
 * 从旧桥 memory.md 的条目里筛出「值得当长期事实迁走」的那些。
 * 返回 {facts, skipped:{rule,meta}}，便于迁移日志交代清楚丢了多少、为什么。
 */
export function siftLegacyEntries(items) {
  const facts = [];
  const skipped = { rule: 0, meta: 0 };
  for (const item of items ?? []) {
    const content = String(item?.content ?? '').trim();
    if (!content) continue;
    if (LEGACY_META_RE.test(content)) { skipped.meta += 1; continue; }
    if (LEGACY_RULE_RE.test(content)) { skipped.rule += 1; continue; }
    facts.push({ ...item, content });
  }
  return { facts, skipped };
}

/** 记忆库默认路径：state/memory.sqlite3 */
export function defaultDbFile(stateDir) {
  return path.join(stateDir, 'memory.sqlite3');
}

/** 目录存在性检查（供 bridge 启动时打印诊断） */
export function dbFileReady(dbFile) {
  try {
    return fs.existsSync(path.dirname(dbFile));
  } catch {
    return false;
  }
}
