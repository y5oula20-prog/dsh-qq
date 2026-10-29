// 记忆库存储层 —— node:sqlite（Node 22 自带，零第三方依赖）。
//
// 设计要点（与 N.E.K.O / dsh-memu-memory 的取舍见 docs/决策记录.md）：
// - 作用域在 schema 里，不靠模型自觉：scope + scope_id 决定一条记忆属于哪个群/哪个人。
// - 三层：short_term（有到期时间）/ long_term / must_remember（必须有理由和来源）。
// - 强度衰减照 N.E.K.O 的证据模型简化而来：靠 last_hit_at 读时衰减，被重新提起就回补。
// - 所有写入走 redactSecrets，避免把密钥写进记忆库。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCOPES = Object.freeze(['group', 'private', 'global']);
export const LAYERS = Object.freeze(['short_term', 'long_term', 'must_remember']);
export const SOURCES = Object.freeze(['user_said', 'inferred', 'told', 'imagined']);

/** 半衰期（天）：短期记忆天然短命，must_remember 近似永久（对齐 memu 的 365 天） */
export const HALF_LIFE_DAYS = Object.freeze({
  short_term: 2,
  long_term: 30,
  must_remember: 365,
});

/** 强度地板：衰减再久也不归零，避免老记忆彻底消失后无处可查 */
export const STRENGTH_FLOOR = 0.12;

/** 短期记忆默认存活小时（对齐 memu 的 72h） */
export const SHORT_TERM_TTL_HOURS = 72;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  scope_id      TEXT NOT NULL DEFAULT '',
  layer         TEXT NOT NULL DEFAULT 'long_term',
  content       TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  speaker       TEXT NOT NULL DEFAULT '',
  speaker_id    TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'inferred',
  confidence    REAL NOT NULL DEFAULT 0.8,
  strength      REAL NOT NULL DEFAULT 1.0,
  hits          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_hit_at   INTEGER NOT NULL,
  expires_at    INTEGER,
  status        TEXT NOT NULL DEFAULT 'active',
  note          TEXT NOT NULL DEFAULT '',
  hash          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_hash ON entries(scope, scope_id, hash);
CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(scope, scope_id, status);
CREATE INDEX IF NOT EXISTS idx_entries_recent ON entries(created_at DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** 密钥/凭据过滤：库是明文 sqlite，先把敏感串挡在门外 */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED_KEY]')
    .replace(/\b([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,})/g, '[REDACTED_TOKEN]')
    .replace(/dsh-auth-[A-Za-z0-9+/=_-]{16,}/g, '[REDACTED_COOKIE]')
    // 不加 \b：\b 只认 ASCII 词字符，中文「密码」前面永远不算边界，会整条漏掉
    .replace(/(password|passwd|密码)\s*[:=：]\s*\S+/gi, '$1: [REDACTED]');
}

/** 内容指纹：同 scope 下同一句话不重复入库；空白差异（含中文里的空格）一律抹平 */
export function hashContent(content) {
  const normalized = String(content ?? '').replace(/\s+/g, '').trim();
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

function newId() {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `mem-${stamp}-${rand}`;
}

/** 打开（必要时创建）记忆库。dbFile 为 ':memory:' 时用于测试。 */
export function openStore(dbFile) {
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** 存储句柄的薄封装：把 sqlite 的同步 API 包成明确的读写方法，便于测试替换。 */
export class MemoryStore {
  constructor(dbFile) {
    this.dbFile = dbFile;
    this.db = openStore(dbFile);
    this.st = {
      insert: this.db.prepare(`
        INSERT INTO entries
          (id, scope, scope_id, layer, content, title, speaker, speaker_id, source,
           confidence, strength, hits, created_at, last_hit_at, expires_at, status, note, hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `),
      byHash: this.db.prepare('SELECT * FROM entries WHERE scope = ? AND scope_id = ? AND hash = ?'),
      byId: this.db.prepare('SELECT * FROM entries WHERE id = ?'),
      listByScope: this.db.prepare(`
        SELECT * FROM entries WHERE scope = ? AND scope_id = ? AND status = 'active'
        ORDER BY created_at DESC
      `),
      listAll: this.db.prepare(`
        SELECT * FROM entries WHERE scope = ? AND status = 'active' ORDER BY created_at DESC
      `),
      // 召回候选池：某个 scope 下所有活跃条目（含 must_remember 与未过期 short_term）
      candidates: this.db.prepare(`
        SELECT * FROM entries
        WHERE scope = ? AND scope_id = ? AND status = 'active'
          AND (expires_at IS NULL OR expires_at > ?)
      `),
      globalCandidates: this.db.prepare(`
        SELECT * FROM entries
        WHERE scope = 'global' AND status = 'active'
          AND (expires_at IS NULL OR expires_at > ?)
      `),
      touch: this.db.prepare('UPDATE entries SET hits = hits + 1, last_hit_at = ? WHERE id = ?'),
      reinforce: this.db.prepare('UPDATE entries SET strength = ?, last_hit_at = ? WHERE id = ?'),
      archive: this.db.prepare('UPDATE entries SET status = ? WHERE id = ?'),
      clearScope: this.db.prepare('DELETE FROM entries WHERE scope = ? AND scope_id = ?'),
      updateContent: this.db.prepare('UPDATE entries SET content = ?, title = ?, hash = ? WHERE id = ?'),
      count: this.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE status = 'active'"),
      countByScope: this.db.prepare(
        "SELECT COUNT(*) AS n FROM entries WHERE status = 'active' AND scope = ? AND scope_id = ?",
      ),
      meta: this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
    };
  }

  close() {
    try { this.db.close(); } catch { /* 已关闭 */ }
  }

  setMeta(key, value) {
    this.st.meta.run(String(key), String(value));
  }

  getMeta(key) {
    return this.st.getMeta.get(String(key))?.value ?? null;
  }

  /**
   * 写入一条记忆。
   * 同 scope 下内容指纹重复时不新增，而是回补强度并累加 hits（这就是「被重新提起」）。
   * @returns {{entry: object, created: boolean}}
   */
  remember({
    scope, scopeId = '', layer = 'long_term', content, title = '',
    speaker = '', speakerId = '', source = 'inferred', confidence = 0.8,
    note = '', now = Date.now(),
  }) {
    const s = String(scope || '').trim();
    if (!SCOPES.includes(s)) throw new Error(`unknown scope: ${scope}`);
    if (!LAYERS.includes(layer)) throw new Error(`unknown layer: ${layer}`);
    if (!SOURCES.includes(source)) throw new Error(`unknown source: ${source}`);
    const text = redactSecrets(String(content ?? '').trim());
    if (!text) throw new Error('content is required');
    const sid = s === 'global' ? '' : String(scopeId ?? '').trim();
    if (s !== 'global' && !sid) throw new Error(`scope ${s} requires an id`);

    const hash = hashContent(text);
    const existing = this.st.byHash.get(s, sid, hash);
    if (existing) {
      // 重复提及 = 证据强化：强度向 1 回补一点，并记一次命中时间
      const boosted = Math.min(1.5, Number(existing.strength || 1) + 0.15);
      this.st.reinforce.run(boosted, now, existing.id);
      return { entry: { ...existing, strength: boosted, last_hit_at: now }, created: false };
    }

    const expiresAt = layer === 'short_term' ? now + SHORT_TERM_TTL_HOURS * 3_600_000 : null;
    const id = newId();
    this.st.insert.run(
      id, s, sid, layer, text, redactSecrets(title), String(speaker || ''), String(speakerId || ''),
      source, Math.max(0, Math.min(1, Number(confidence) || 0.8)), 1.0, 0, now, now,
      expiresAt, 'active', redactSecrets(note), hash,
    );
    return { entry: this.st.byId.get(id), created: true };
  }

  byId(id) {
    return this.st.byId.get(String(id)) ?? null;
  }

  /** 某个 scope 下的活跃条目（新→旧） */
  list(scope, scopeId = '') {
    const sid = scope === 'global' ? '' : String(scopeId ?? '');
    return scope === 'global' ? this.st.listAll.all('global') : this.st.listByScope.all(scope, sid);
  }

  /** 召回候选池：本 scope + 全局共享，已过期/已归档的不进池 */
  candidates(scope, scopeId = '', now = Date.now()) {
    const sid = scope === 'global' ? '' : String(scopeId ?? '');
    const own = scope === 'global' ? this.st.globalCandidates.all(now) : this.st.candidates.all(scope, sid, now);
    const shared = scope === 'global' ? [] : this.st.globalCandidates.all(now);
    return { own, shared };
  }

  /** 召回命中后回写：hits+1、last_hit_at 更新、强度小幅回补 */
  hit(id, now = Date.now()) {
    const row = this.st.byId.get(String(id));
    if (!row) return;
    const boosted = Math.min(1.5, Number(row.strength || 1) + 0.1);
    this.st.touch.run(now, row.id);
    this.st.reinforce.run(boosted, now, row.id);
  }

  archive(id, status = 'archived') {
    this.st.archive.run(status, String(id));
  }

  /** 清空某个作用域的全部记忆（/记忆重置 用）。返回受影响条数。 */
  clearScope(scope, scopeId = '') {
    const sid = scope === 'global' ? '' : String(scopeId ?? '');
    const n = scope === 'global'
      ? this.st.countByScope.get('global', '').n
      : this.st.countByScope.get(scope, sid).n;
    this.st.clearScope.run(scope, sid);
    return n;
  }

  stats() {
    const byScope = {};
    for (const row of this.db.prepare(
      "SELECT scope, scope_id, COUNT(*) AS n FROM entries WHERE status = 'active' GROUP BY scope, scope_id",
    ).all()) {
      byScope[`${row.scope}:${row.scope_id}`] = row.n;
    }
    return { total: this.st.count.get().n, byScope };
  }
}

/** 强度衰减：从现在回看 last_hit_at，按半衰期衰减到地板为止 */
export function decayedStrength(entry, now = Date.now()) {
  const base = Number(entry?.strength ?? 1);
  const layer = entry?.layer || 'long_term';
  const halfLife = HALF_LIFE_DAYS[layer] ?? 30;
  const days = Math.max(0, (now - Number(entry?.last_hit_at || now)) / 86_400_000);
  const factor = Math.pow(0.5, days / halfLife);
  return Math.max(STRENGTH_FLOOR, base * factor);
}
