// 记忆检索的分词 —— 纯函数，无依赖，可单独测。
//
// 为什么不用 SQLite 的 FTS5：实测 FTS5 在 node:sqlite(22.23.4) 里可用，但
// 默认 unicode61 分词器把中文整串当一个 token（「今天天气真好」查「天气」无结果），
// trigram 分词器能查但要 ≥3 字（「天气真」有、「天气」没有）。
// 记忆内容以中文短语为主，两字词很常见（唱歌 / 黑丝 / 女装），所以这里自己做
// CJK 二元切分，配合 BM25 打分，行为和预算都可控，也不依赖编译期的 tokenizer。

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const LATIN_WORD = /[A-Za-z0-9_]+/g;

/**
 * 抽取检索用的 token 集合。
 * - 连续中文串 → 相邻两字的 bigram（单字串保留单字）
 * - 拉丁/数字串 → 小写整词
 * - 标点、空白、emoji 一律丢弃
 */
export function tokenize(text, { bigramOnly = false } = {}) {
  const source = String(text ?? '');
  const out = [];
  if (!source) return out;

  // 先把中文段和拉丁段分开处理：逐字符扫描，遇到类别切换就断段。
  let buf = '';
  let bufIsCjk = null;
  const flush = () => {
    if (!buf) return;
    if (bufIsCjk) {
      const chars = [...buf];
      if (chars.length === 1) {
        if (!bigramOnly) out.push(chars[0]);
      } else {
        for (let i = 0; i < chars.length - 1; i += 1) out.push(chars[i] + chars[i + 1]);
      }
    } else if (!bigramOnly) {
      const lowered = buf.toLowerCase();
      if (lowered.length >= 2) out.push(lowered);
    }
    buf = '';
  };
  for (const ch of source) {
    if (CJK.test(ch)) {
      if (bufIsCjk !== true) { flush(); bufIsCjk = true; }
      buf += ch;
    } else if (/[A-Za-z0-9_]/.test(ch)) {
      if (bufIsCjk !== false) { flush(); bufIsCjk = false; }
      buf += ch;
    } else {
      flush();
      bufIsCjk = null;
    }
  }
  flush();
  return out;
}

/** 词频表：token → 出现次数 */
export function termFreq(text) {
  const tf = new Map();
  for (const token of tokenize(text)) tf.set(token, (tf.get(token) || 0) + 1);
  return tf;
}

/** 检索词里挑出来的「有效 Latin 整词」，用于给精确命中加权（如 QQ 号、昵称） */
export function latinTerms(text) {
  return [...new Set(String(text ?? '').match(LATIN_WORD) || [])]
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 2);
}
