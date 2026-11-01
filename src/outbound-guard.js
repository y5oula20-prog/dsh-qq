// 出站防呆：发送前的自检纯函数（不碰网络、不碰状态）。
//
// 由来（2026-11-01 小柚人机感复盘，实测 transcript 里抓到的两条）：
// - T140：模型把 QQ 收藏表情的文件名 `836923945_0_0_0_<32位HEX>_0_0` 当成文字发了出去；
// - T151：同一条句子跨轮次原封不动又发了一遍，读起来像复读机。
// 这里只做判定，发送端点自己决定是拦截还是软提醒。
//
// 设计原则：宁可少拦，不可误伤。短应答（嗯/草/？/好的）永远不判成重复——
// 真人本来就天天说这几个字，拦掉才是假。

/** QQ 收藏表情的真实 id 形态：`<uin>_0_0_0_<32位HEX>_0_0`。 */
export const STICKER_FILE_ID_RE = /^\d+_0_0_0_[0-9A-Fa-f]{32}_0_0$/;

/** 去掉空白与全部标点符号、统一小写，用来判断“是不是同一句话”。 */
export function normalizeOutboundText(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/[\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/** 整条消息就是一个表情库文件名（允许外层引号/空白）时返回该 id，否则 null。 */
export function stickerIdLeakIn(value) {
  const raw = String(value ?? '')
    .trim()
    .replace(/^["'`“”‘’]+/, '')
    .replace(/["'`“”‘’]+$/, '')
    .trim();
  return STICKER_FILE_ID_RE.test(raw) ? raw : null;
}

/** 一批消息里哪几条是表情库文件名泄漏；返回 { indexes, ids }。 */
export function findStickerIdLeaks(messages) {
  const indexes = [];
  const ids = [];
  (Array.isArray(messages) ? messages : []).forEach((m, i) => {
    const hit = stickerIdLeakIn(m);
    if (hit) {
      indexes.push(i);
      ids.push(hit);
    }
  });
  return { indexes, ids };
}

// 默认值都刻意宽松：10 分钟内、≥8 个字符（去标点后）、只看最近 12 条自己说的话。
export const REPEAT_GUARD_DEFAULTS = {
  enabled: true,
  windowMs: 10 * 60 * 1000,
  minChars: 8,
  lookback: 12
};

export function resolveRepeatGuard(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    enabled: cfg.enabled !== false,
    windowMs: num(cfg.windowMs, REPEAT_GUARD_DEFAULTS.windowMs),
    minChars: num(cfg.minChars, REPEAT_GUARD_DEFAULTS.minChars),
    lookback: num(cfg.lookback, REPEAT_GUARD_DEFAULTS.lookback)
  };
}

/**
 * 找出“这几条里有哪几条和最近自己说过的一模一样”。
 *
 * @param {string[]} messages      本次要发的消息
 * @param {Array}    recentMessages 二代会话的 recentMessages（含 isSelf 标记）
 * @returns {Array<{index:number,text:string,previous:string}>}
 */
export function findRepeatedMessages(messages, recentMessages, options = {}) {
  const cfg = resolveRepeatGuard(options);
  if (!cfg.enabled) return [];
  const now = Number(options.now) || Date.now();
  const said = new Map();
  const history = (Array.isArray(recentMessages) ? recentMessages : []).filter((m) => m && m.isSelf);
  for (const m of history.slice(-cfg.lookback)) {
    const at = Number(m.time) || 0;
    if (at && now - at > cfg.windowMs) continue;
    const key = normalizeOutboundText(m.text ?? m.plain);
    if (!key || said.has(key)) continue;
    said.set(key, String(m.text ?? m.plain ?? '').slice(0, 40));
  }
  if (!said.size) return [];
  const hits = [];
  (Array.isArray(messages) ? messages : []).forEach((m, i) => {
    const key = normalizeOutboundText(m);
    if (!key || Array.from(key).length < cfg.minChars) return;
    if (said.has(key)) hits.push({ index: i, text: String(m).slice(0, 40), previous: said.get(key) });
  });
  return hits;
}

/** 把重复判定结果变成一句给模型看的话（前端已经拦下时用不到，软提醒场景用）。 */
export function repeatWarningText(hits) {
  if (!Array.isArray(hits) || !hits.length) return null;
  const label = hits.length === 1 ? `第 ${hits[0].index + 1} 条` : `第 ${hits.map((h) => h.index + 1).join('、')} 条`;
  return `${label}和你刚说过的一模一样（“${hits[0].previous}”）。真人不会原封不动再说一遍：换个说法，或者干脆不说。`;
}
