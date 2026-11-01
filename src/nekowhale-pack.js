// nekowhale 表情包（kiriyuki.com「大肥鱼」单人套组）——只读源库 + 按需下载。
//
// 和 src/sticker-lib.js 的分工：
// - sticker-lib.js 管 **QQ 账号收藏表情**（state/stickers.json），是「AI 认知层」，
//   带 localNote/tags/useCount，走 mergeStickerLibrary 跟 SnowLuma 同步。
// - 本文件管 **nekowhale 公开套组**（state/nekowhale/），是**只读外部资源**：
//   不参与 QQ 收藏同步、没有 merge 剔除逻辑、AI 不能改它的备注。
//
// 为什么必须懒加载：整包 322 张、406MB，中位 1.1MB、最大 5.8MB。
// 启动时全量镜像会（a）占几百 MB 磁盘，（b）在弱网下把启动拖成几分钟。
// 所以这里只缓存 **160KB 的元数据**，GIF 第一次真正被发送时才下载并落盘。
//
// 为什么只留「大肥鱼」单人套组：双人套组（大肥鱼和GPT娘）是「鲸鱼娘 + GPT 娘」的
// 双人互动画面，小柚是一个人设，发出来会变成「图里还有另一个角色」的语义错位。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 元数据地址，按顺序试第一个能用的。
 *
 * 为什么不是只留 raw.githubusercontent.com：它在本机直连实测 15 秒超时（走系统代理才通），
 * 而桥接是被刻意摘掉代理变量跑的（见 control-center.mjs 的 PROXY_ENV_NAMES），所以只有
 * raw 一个地址时首次启动必然拉不到元数据。jsDelivr 的 GitHub 镜像直连 846ms/160KB，稳。
 * 三个地址内容完全一致（同一仓库同一文件），失败才换下一个。
 */
export const NEKOWHALE_META_URLS = [
  'https://cdn.jsdelivr.net/gh/Loping151/dsh-nekowhale-stickers@main/meta/nekowhale.json',
  'https://fastly.jsdelivr.net/gh/Loping151/dsh-nekowhale-stickers@main/meta/nekowhale.json',
  'https://raw.githubusercontent.com/Loping151/dsh-nekowhale-stickers/main/meta/nekowhale.json'
];

/** 首选地址（对外保留，便于日志/测试引用）。真正的拉取逻辑按 NEKOWHALE_META_URLS 逐个试。 */
export const NEKOWHALE_META_URL = NEKOWHALE_META_URLS[0];

/** GIF 直链前缀（实测 200：https://kiriyuki.com/media/gif/大肥鱼/10N01_猫猫搓手.gif）。 */
export const NEKOWHALE_GIF_BASE = 'https://kiriyuki.com/media/gif';

/** 只服务这一个套组；其余套组不进本地库。 */
export const NEKOWHALE_PACK = '大肥鱼';

/** 作者署名，按 CC BY-NC 4.0 必须随资源一起保留。 */
export const NEKOWHALE_ATTRIBUTION = '表情包作者：B站 可以叫我云大人（space.bilibili.com/103739），kiriyuki.com 制作';

const SCHEMA = 'nekowhale-pack/1';

/**
 * 单行化自由文本。
 *
 * 和 sticker-lib.sanitizeStickerText 同一个理由：这些字段最终会进提示词，
 * 换行能把「一条数据」变成「一个新段落」。nekowhale 的文本虽然来自可信作者，
 * 但它走的是网络（可被中间人/仓库接管改内容），所以一视同仁地压平。
 */
function oneLine(value, max = 200) {
  const limit = Math.max(1, Number(max) || 200);
  return String(value ?? '')
    .replace(/[\s\u00a0\u3000]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .trim()
    .slice(0, limit);
}

/** 把文件名里的中文/空格编码进 URL 路径（逐段编码，保留 / 分隔）。 */
function encodePath(relPath) {
  return String(relPath || '')
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/** 由套组 id（形如 `大肥鱼/10N01_猫猫搓手`）推出 GIF 直链。 */
export function nekowhaleGifUrl(id) {
  const clean = String(id || '').replace(/^\/+/, '');
  if (!clean.includes('/')) return '';
  const pack = clean.slice(0, clean.indexOf('/'));
  const stem = clean.slice(clean.indexOf('/') + 1);
  if (pack !== NEKOWHALE_PACK || !stem) return '';
  return `${NEKOWHALE_GIF_BASE}/${encodePath(`${pack}/${stem}.gif`)}`;
}

/**
 * 归一化一条 nekowhale 表情。
 *
 * 字段直接沿用上游语义，不新建标签体系：
 * emotion（情绪，24 类）、tags[]（场景词）、use（什么时候用）、desc（画面描述）。
 * 这些都是作者原始标注，比我们自己猜的标签准。
 */
export function normalizeNekowhaleEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = String(entry.id || '').trim();
  if (!id || !id.startsWith(`${NEKOWHALE_PACK}/`)) return null;
  const stem = id.slice(NEKOWHALE_PACK.length + 1);
  if (!stem) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => oneLine(t, 24)).filter(Boolean).slice(0, 12)
    : [];
  const url = nekowhaleGifUrl(id);
  if (!url) return null;
  return {
    id,
    pack: NEKOWHALE_PACK,
    stem,
    // code 是「编号」（如 10N01），name 是中文短名（如 猫猫搓手），两个都用于精确查找。
    code: oneLine(entry.code || stem.split('_')[0] || '', 24),
    name: oneLine(entry.name || (stem.includes('_') ? stem.slice(stem.indexOf('_') + 1) : stem), 40),
    emotion: oneLine(entry.emotion, 16),
    tags,
    use: oneLine(entry.use, 120),
    desc: oneLine(entry.desc, 200),
    en: oneLine(entry.en, 120),
    url
  };
}

/** 读本地缓存的元数据。ENOENT → null（首次使用）；读坏必须 throw，不能当空库覆盖。 */
export function loadNekowhalePack(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const parsed = JSON.parse(raw);
  const stickers = (Array.isArray(parsed?.stickers) ? parsed.stickers : [])
    .map(normalizeNekowhaleEntry)
    .filter(Boolean);
  return {
    schema: String(parsed?.schema || SCHEMA),
    version: String(parsed?.version || ''),
    fetchedAt: String(parsed?.fetchedAt || ''),
    pack: NEKOWHALE_PACK,
    attribution: String(parsed?.attribution || NEKOWHALE_ATTRIBUTION),
    emotions: Array.isArray(parsed?.emotions) ? parsed.emotions.map((e) => oneLine(e, 16)).filter(Boolean) : [],
    stickers
  };
}

/** 原子写（临时文件 + rename），失败清掉临时文件，不留半截。 */
export function saveNekowhalePack(file, meta) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const payload = JSON.stringify({
    schema: SCHEMA,
    version: meta?.version || '',
    fetchedAt: meta?.fetchedAt || new Date().toISOString(),
    pack: NEKOWHALE_PACK,
    attribution: meta?.attribution || NEKOWHALE_ATTRIBUTION,
    emotions: Array.isArray(meta?.emotions) ? meta.emotions : [],
    stickers: (Array.isArray(meta?.stickers) ? meta.stickers : []).map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      emotion: s.emotion,
      tags: s.tags,
      use: s.use,
      desc: s.desc,
      en: s.en,
      url: s.url
    }))
  }, null, 2);
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

/**
 * 从远端拉元数据 → 过滤出「大肥鱼」→ 返回可直接落盘的结构。
 *
 * `fetchJson(url)` 由调用方注入（bridge 用它自己的 safeFetch，带 SSRF 防护），
 * 这样本文件不直接依赖网络实现，便于单测。
 */
export async function fetchNekowhaleMeta(fetchJson) {
  // 逐个地址试：镜像优先、raw 兜底。全部失败才抛，错误里带上每个地址的失败原因，
  // 方便下次有人看到「元数据拉取失败」时一眼知道是网络还是内容问题。
  const failures = [];
  let raw = null;
  for (const url of NEKOWHALE_META_URLS) {
    try {
      raw = await fetchJson(url);
      break;
    } catch (error) {
      failures.push(`${new URL(url).host}：${error?.message ?? error}`);
    }
  }
  if (raw === null) throw new Error(`所有元数据地址都失败（${failures.join('；')}）`);

  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const list = Array.isArray(parsed?.stickers) ? parsed.stickers : [];
  const stickers = list.map(normalizeNekowhaleEntry).filter(Boolean);
  if (!stickers.length) throw new Error('nekowhale 元数据里没有可用的「大肥鱼」表情');
  const emotions = Array.isArray(parsed?.emotions)
    ? parsed.emotions.map((e) => oneLine(e, 16)).filter(Boolean)
    : [];
  return {
    schema: SCHEMA,
    version: String(parsed?.version || ''),
    fetchedAt: new Date().toISOString(),
    // pack 必须在这里就补上：saveNekowhalePack 会写进文件，但同一次运行里
    // 调用方拿到的是这个内存对象（不过盘），漏了字段会让 bridge 里
    // listStickersForV2 的 result.nekowhale.pack 与 /api/state 显示成 null。
    pack: NEKOWHALE_PACK,
    attribution: oneLine(parsed?.attribution?.text, 200) || NEKOWHALE_ATTRIBUTION,
    emotions,
    stickers
  };
}

/** 按情绪分组，组内按 id 稳定排序（保证每次注入的代表表情不来回跳）。 */
export function groupByEmotion(meta) {
  const map = new Map();
  for (const s of Array.isArray(meta?.stickers) ? meta.stickers : []) {
    const key = s.emotion || '其他';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  for (const list of map.values()) list.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return map;
}

/**
 * 生成注入提示词的情绪目录。
 *
 * 为什么不是「把 286 张全列出来」：那会是几千字，而且每轮都在重复。
 * 这里给的是**索引**：每个情绪一行，带数量 + 代表性的一张（含 id，可以直接发）。
 * AI 想找更贴的，用 qq_list_stickers 带 query 搜（搜索会走 searchNekowhale）。
 */
export function buildNekowhaleContext(meta, { maxEmotions = 24, perEmotion = 2 } = {}) {
  const grouped = groupByEmotion(meta);
  if (!grouped.size) return '';
  const total = Array.isArray(meta?.stickers) ? meta.stickers.length : 0;
  const order = Array.isArray(meta?.emotions) && meta.emotions.length
    ? meta.emotions.filter((e) => grouped.has(e))
    : [...grouped.keys()];
  const lines = [];
  for (const emotion of order.slice(0, Math.max(1, maxEmotions))) {
    const list = grouped.get(emotion);
    if (!list?.length) continue;
    const picks = list.slice(0, Math.max(1, perEmotion)).map((s) => {
      const hint = s.use || s.name;
      return `${s.id}${hint ? `（${hint}）` : ''}`;
    });
    lines.push(`- ${emotion}（${list.length} 张）：${picks.join('；')}`);
  }
  const head = `【大肥鱼表情包】共 ${total} 张，按情绪分类如下（每类只列前几张，完整的用 qq_list_stickers 搜情绪或词，例如 query="开心"）。`;
  const tail = `（这些是${NEKOWHALE_ATTRIBUTION}，授权 CC BY-NC 4.0。）`;
  return [head, ...lines, tail].join('\n');
}

/** 搜索：emotion / tags / name / use / desc / id 全部参与匹配，query 按空格分词后需全部命中。 */
export function searchNekowhale(meta, query = '', limit = 24) {
  const list = Array.isArray(meta?.stickers) ? meta.stickers : [];
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const s of list) {
    const haystack = [s.id, s.code, s.name, s.emotion, s.use, s.desc, s.en, ...(s.tags || [])]
      .map((v) => String(v ?? '').toLowerCase())
      .join(' ');
    if (!terms.every((t) => haystack.includes(t))) continue;
    // 情绪/短名命中排在备注命中前面：搜「开心」时同情绪的那批应该更靠前。
    let score = 0;
    if (String(s.emotion).toLowerCase() === terms[0]) score += 4;
    if (String(s.name).toLowerCase().includes(terms[0])) score += 2;
    if ((s.tags || []).some((t) => String(t).toLowerCase() === terms[0])) score += 2;
    scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.s.id).localeCompare(String(b.s.id)));
  return scored.slice(0, Math.max(1, limit)).map((x) => x.s);
}

/** 精确查找：完整 id → code（10N01）→ 中文短名（猫猫搓手）。不做子串（避免发错图）。 */
export function findNekowhale(meta, ref) {
  const want = String(ref ?? '').trim();
  if (!want) return null;
  const list = Array.isArray(meta?.stickers) ? meta.stickers : [];
  const lower = want.toLowerCase();
  return list.find((s) => s.id === want)
    || list.find((s) => String(s.code).toLowerCase() === lower)
    || list.find((s) => String(s.name).toLowerCase() === lower)
    || null;
}

/** 本地 GIF 缓存路径（用 id 的 hash 做文件名，避免中文文件名在归档/同步时出问题）。 */
export function nekowhaleCachePath(dir, entry) {
  const hash = crypto.createHash('sha1').update(String(entry?.id || '')).digest('hex').slice(0, 16);
  return path.join(dir, `${hash}.gif`);
}

/**
 * 取一张表情的字节：本地有就直接读，没有就下载并落盘。
 *
 * 失败一律 throw（由调用方决定降级方式）；不在这里静默返回空 buffer——
 * 发出去一个空图比发失败更糟。
 */
export async function ensureNekowhaleGif(entry, { dir, maxBytes = 10 * 1024 * 1024, fetchBuffer }) {
  if (!entry?.url) throw new Error('表情缺少图片地址');
  const file = nekowhaleCachePath(dir, entry);
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > 0 && buf.length <= maxBytes) return { buffer: buf, file, cached: true };
    // 空文件或超限文件都是坏缓存，删掉重下。
    try { fs.unlinkSync(file); } catch {}
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (typeof fetchBuffer !== 'function') throw new Error('缺少图片下载实现');
  const fetched = await fetchBuffer(entry.url, maxBytes);
  const buf = fetched?.buffer ?? fetched;
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('下载到的表情是空的');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, buf, { mode: 0o600 });
  return { buffer: buf, file, cached: false };
}

/** 给日志/工具返回值用的轻量描述（不含整段 desc，避免日志爆掉）。 */
export function describeNekowhale(entry) {
  if (!entry) return '';
  const bits = [entry.id];
  if (entry.emotion) bits.push(entry.emotion);
  if (entry.use) bits.push(entry.use);
  return bits.join(' · ');
}
