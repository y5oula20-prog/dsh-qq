// 画技学习：从公开的动漫图标签库（Safebooru，Danbooru 系）学"该怎么描述一张画"。
//
// 为什么不是直接扒 pixiv：pixiv 的公开接口要登录态，且图片有版权；
// 而 pixiv 上的画师打的就是这套 Danbooru 风格 tag（1girl / blue_hair / dutch_angle…）。
// 学 tag = 学画师怎么构图、怎么打光、怎么选景，这是能真正落到提示词里的部分。
//
// 安全与礼貌：只在需要时查、结果落本地缓存（默认 7 天），不抓图、不下载别人作品。
import fs from 'node:fs';
import path from 'node:path';

const SAFEBOORU = 'https://safebooru.org/index.php';

// 中文 → 英文 tag 的词典。只收"能稳定提升出图质量"的词，宁缺毋滥。
export const STYLE_MAP = {
  水彩: 'watercolor (medium)',
  油画: 'oil painting (medium)',
  厚涂: 'impasto',
  赛博朋克: 'cyberpunk',
  像素: 'pixel art',
  水墨: 'chinese ink painting',
  国风: 'chinese clothes',
  素描: 'sketch',
  蜡笔: 'crayon',
  漫画: 'manga',
  写实: 'realistic',
  扁平: 'flat color',
  蒸汽波: 'vaporwave',
  哥特: 'gothic',
  童话: 'fairytale',
  胶片: 'film grain',
  逆光: 'backlighting',
  特写: 'close-up',
  全身: 'full body',
  背影: 'from behind',
  俯视: 'from above',
  仰视: 'from below',
  黄昏: 'golden hour',
  清晨: 'morning',
  夜晚: 'night',
  月夜: 'moonlight',
  雨天: 'rain',
  雪: 'snow',
  樱花: 'cherry blossoms',
  海边: 'beach',
  森林: 'forest',
  星空: 'starry sky',
  花海: 'flower field',
  烟火: 'fireworks',
  咖啡店: 'cafe',
  教室: 'classroom',
  霓虹: 'neon lights',
  光斑: 'lens flare',
  柔光: 'soft lighting'
};

function cachePath(dir) {
  return path.join(dir, 'art-tags.json');
}

function readCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { tags: {}, fetchedAt: 0 };
  }
}

function writeCache(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {}
}

/** 查一个 tag 在图库里的使用量：数量越大说明画师越常用。 */
export async function lookupTag(name, { timeoutMs = 8000 } = {}) {
  // 用 name=（精确匹配）而不是 name_pattern=（前缀匹配）：
  // 后者查 golden_hour 会先撞上 golden-hourglass，学到的全是错词。
  const q = new URLSearchParams({ page: 'dapi', s: 'tag', q: 'index', name: String(name), limit: '1' });
  const res = await fetch(`${SAFEBOORU}?${q.toString()}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  const xml = await res.text();
  const m = /<tag [^>]*count="(\d+)"[^>]*name="([^"]+)"/.exec(xml);
  return m ? { name: m[2], count: Number(m[1]) } : null;
}

/**
 * 把一句中文里能认出来的词换成画师用的英文 tag。
 * 只做词典替换 —— 不做机器翻译，因为翻错一个词就会让整张图跑偏。
 */
export function localizeScene(scene) {
  const text = String(scene ?? '');
  const touched = [];
  for (const [zh, en] of Object.entries(STYLE_MAP)) {
    if (text.includes(zh) && !touched.includes(en)) touched.push(en);
  }
  // 追加而不是替换：把「黄昏的海边」换成「golden hour 的 beach」会留下断句，
  // 模型读起来更乱。保留原句 + 末尾补 tag，两条信息都在。
  return { scene: text.trim(), tags: touched };
}

/**
 * 学一批常用 tag（按使用量排序），用于给提示词补"画师会写的词"。
 * 结果缓存，避免每次都打图库接口。
 */
export async function learnTags({ dir, keywords = [], maxAgeMs = 7 * 24 * 3600 * 1000, timeoutMs = 8000 } = {}) {
  const file = cachePath(dir);
  const cache = readCache(file);
  const fresh = Date.now() - (cache.fetchedAt ?? 0) < maxAgeMs;
  const learned = new Map(Object.entries(cache.tags ?? {}));
  const missing = keywords.filter((k) => !learned.has(k));
  if (fresh && missing.length === 0) return { tags: learned, fromCache: true };
  for (const k of missing.slice(0, 6)) {
    try {
      const hit = await lookupTag(k, { timeoutMs });
      if (hit) learned.set(k, hit);
    } catch {
      // 查不到就算了：少一个 tag 不影响这张图，不能因此让整次画画失败
    }
  }
  writeCache(file, { tags: Object.fromEntries(learned), fetchedAt: Date.now() });
  return { tags: learned, fromCache: false };
}

/**
 * 出图前的一步：把场景本地化，并只保留图库里确实存在的 tag。
 * 返回拼在 scene 后面的补充词，以及这次"学到了什么"（写进日志，便于回看）。
 */
export async function enrichScene(scene, { dir, timeoutMs = 8000 } = {}) {
  const { scene: localized, tags } = localizeScene(scene);
  if (tags.length === 0) return { scene: localized, learned: [], notes: '' };
  const { tags: known } = await learnTags({ dir, keywords: tags.map((t) => t.replace(/ /g, '_')), timeoutMs });
  const verified = tags.filter((t) => {
    const hit = known.get(t.replace(/ /g, '_'));
    return hit && hit.count >= 20;
  });
  const sceneOut = verified.length ? `${localized}, ${verified.join(', ')}` : localized;
  return { scene: sceneOut, learned: verified, notes: verified.length ? `学到 ${verified.length} 个画师常用 tag：${verified.join(' / ')}` : '' };
}
