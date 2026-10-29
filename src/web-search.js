// 联网搜索（MCP `web_search` 的实现）。
//
// 设计目标：**优先复用 DSH 原本的联网搜索能力**，而不是自己抓 Bing 的搜索结果页。
//
// DSH 的 `web_search` 工具背后是 `@deepseek-ai/dsh-web-search-deepseek`：
// 向 DeepSeek 的 Anthropic 兼容 Messages 端点发一次带 `web_search_20250305`
// 服务端工具的请求，从 `web_search_tool_result` 里取结构化结果。本模块照同一
// 端点/模型/工具参数实现一份最小客户端，于是 QQ 里的 AI 和 DSH 里的 AI 拿到的是
// **同一路搜索结果**；搜索词只发给 DeepSeek（也就是本来就在处理这段对话的同一家），
// 不再把群聊里提炼出来的词发给 Bing。
//
// 凭据解析顺序与 DSH 一致：
//   1. config.json 的 `webSearch.apiKey`（不推荐，明文）
//   2. 环境变量 `DEEPSEEK_API_KEY`（可用 `webSearch.apiKeyEnv` 改）
//   3. DSH 的 `$DSH_HOME/.credentials.yaml` → `refs.<ref>`（DSH 的 Models 页写入的 key）
// 都没有时：回退 Bing（`cn.bing.com` 的 RSS，失败再退回 HTML），保证"永远有一个能用的搜索"。
//
// 另有独立后端 AnySearch（`webSearch.provider = "anysearch"`）：
// 走 POST https://api.anysearch.com/v1/search，Bearer 鉴权，凭据用**单独**的
// `anysearchApiKey` / `ANYSEARCH_API_KEY`，不与 DeepSeek 的 apiKey 共用。
//
// 安全边界：
// - API key 只发往**校验过**的 HTTPS 端点：必须是 https、必须解析到公网地址
//   （防止把 key 发到 localhost/内网），且禁止跟随重定向（`redirect: error`）。
// - key 永远不写日志、不进错误信息、不进返回结果。
// - 响应体有大小上限；请求有总超时；查询词在 MCP 层已清洗。
// - Bing 走 safe-fetch（SSRF 防护 + 多地址故障切换）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { URL } from 'node:url';
import YAML from 'js-yaml';
import { resolveSafeAddresses, safeFetch } from './safe-fetch.js';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';
// AnySearch：独立后端，Bearer 鉴权；免费额度下也能用，配 key 后限流更宽松。
// 与 DeepSeek 那条路的 key 刻意分开（anysearchApiKey / ANYSEARCH_API_KEY），
// 避免切换 provider 时把 DeepSeek 的 key 误发给 AnySearch。
const DEFAULT_ANYSEARCH_BASE_URL = 'https://api.anysearch.com/v1/search';
const DEFAULT_ANYSEARCH_KEY_ENV = 'ANYSEARCH_API_KEY';
const DEFAULT_TIMEOUT_MS = 35000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;
// Anthropic 兼容响应里文本块/结果块都可能有；这里只要结构化结果。
const SEARCH_TOOL_TYPE = 'web_search_20250305';

const defaultConfig = Object.freeze({
  provider: 'auto',
  apiKey: '',
  apiKeyEnv: DEFAULT_API_KEY_ENV,
  anysearchApiKey: '',
  anysearchApiKeyEnv: DEFAULT_ANYSEARCH_KEY_ENV,
  anysearchBaseURL: '',
  baseURL: '',
  model: DEFAULT_MODEL,
  maxUses: 5,
  maxTokens: 4096,
  maxResults: 8,
  timeoutMs: DEFAULT_TIMEOUT_MS
});

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 读取 config.json 里的 webSearch 段（不存在就用默认值）。 */
export function loadSearchConfig(root) {
  let file = {};
  try {
    const text = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
    file = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {}
  const raw = file?.webSearch && typeof file.webSearch === 'object' && !Array.isArray(file.webSearch) ? file.webSearch : {};
  const provider = ['deepseek', 'bing', 'anysearch'].includes(raw.provider) ? raw.provider : 'auto';
  return {
    ...defaultConfig,
    provider,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    apiKeyEnv: typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.trim() ? raw.apiKeyEnv.trim() : DEFAULT_API_KEY_ENV,
    anysearchApiKey: typeof raw.anysearchApiKey === 'string' ? raw.anysearchApiKey.trim() : '',
    anysearchApiKeyEnv: typeof raw.anysearchApiKeyEnv === 'string' && raw.anysearchApiKeyEnv.trim() ? raw.anysearchApiKeyEnv.trim() : DEFAULT_ANYSEARCH_KEY_ENV,
    anysearchBaseURL: typeof raw.anysearchBaseURL === 'string' ? raw.anysearchBaseURL.trim().replace(/\/+$/, '') : '',
    baseURL: typeof raw.baseURL === 'string' ? raw.baseURL.trim().replace(/\/+$/, '') : '',
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULT_MODEL,
    maxUses: num(raw.maxUses, defaultConfig.maxUses, 1, 5),
    maxTokens: num(raw.maxTokens, defaultConfig.maxTokens, 256, 8192),
    maxResults: num(raw.maxResults, defaultConfig.maxResults, 1, 20),
    timeoutMs: num(raw.timeoutMs, defaultConfig.timeoutMs, 5000, 120000)
  };
}

/** DSH home：与 dsh-client 的判定保持一致（`DSH_HOME` 优先）。 */
export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 从 DSH 的凭据文件里取 key。
 * 结构：`refs: { <名称>: <明文值> }`（实测；不是记录 id）。只看指定 ref，绝不遍历其它凭据。
 */
export function readDshCredential(ref) {
  const name = String(ref ?? '').trim();
  if (!name) return '';
  try {
    const doc = YAML.load(fs.readFileSync(path.join(resolveDshHome(), '.credentials.yaml'), 'utf8'));
    const value = doc?.refs?.[name];
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/** 解析搜索用的 DeepSeek key；返回 { key, source } —— key 只在这里出现，不落日志。 */
export function resolveSearchApiKey(config) {
  const literal = String(config?.apiKey ?? '').trim();
  if (literal) return { key: literal, source: 'config' };
  const envName = String(config?.apiKeyEnv || DEFAULT_API_KEY_ENV);
  const fromEnv = String(process.env[envName] ?? '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const fromDsh = readDshCredential(envName);
  if (fromDsh) return { key: fromDsh, source: 'dsh-credentials' };
  return { key: '', source: 'none' };
}

/**
 * 解析 AnySearch 的 key。
 *
 * 顺序与 DeepSeek 一路保持一致，但字段独立：
 *   config.json 的 `webSearch.anysearchApiKey` → 环境变量（`anysearchApiKeyEnv`，
 *   默认 ANYSEARCH_API_KEY）→ DSH 的 `.credentials.yaml` 里同名 ref。
 * 不复用 `apiKey`：那个字段属于 DeepSeek，混用会在一键切换 provider 时把错 key 发出去。
 */
export function resolveAnySearchKey(config) {
  const literal = String(config?.anysearchApiKey ?? '').trim();
  if (literal) return { key: literal, source: 'config' };
  const envName = String(config?.anysearchApiKeyEnv || DEFAULT_ANYSEARCH_KEY_ENV);
  const fromEnv = String(process.env[envName] ?? '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const fromDsh = readDshCredential(envName);
  if (fromDsh) return { key: fromDsh, source: 'dsh-credentials' };
  return { key: '', source: 'none' };
}

function normalizeSearchUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  // DeepSeek 的结果 URL 会带 `#1` 这类"第几条"的锚点（不是页面真实片段），去掉更干净；
  // 但真实的 `#section` 也可能有意义，所以只去纯数字锚点。
  const cleaned = s.replace(/#\d+$/, '');
  try {
    const url = new URL(cleaned);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

/** 把 Anthropic Messages 响应映射成统一结果（参照 dsh-web-search-deepseek 的实现）。 */
export function mapDeepSeekResponse(response, maxResults = 8) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const resultBlocks = blocks.filter((block) => block?.type === 'web_search_tool_result');
  if (!resultBlocks.length) {
    throw Object.assign(new Error('DeepSeek 没有返回 web_search_tool_result（可能未触发联网搜索）'), { code: 'NO_RESULT_BLOCK' });
  }
  const snippets = new Map();
  for (const block of blocks) {
    if (block?.type !== 'text') continue;
    for (const cite of block.citations ?? []) {
      const url = normalizeSearchUrl(cite?.url);
      if (!url || snippets.has(url)) continue;
      const text = String(cite?.cited_text ?? '').trim();
      if (text) snippets.set(url, text);
    }
  }
  const seen = new Set();
  const results = [];
  for (const block of resultBlocks) {
    for (const item of block?.content ?? []) {
      if (item?.type !== 'web_search_result') continue;
      const url = normalizeSearchUrl(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = String(item.title ?? '').trim().slice(0, 200);
      const snippet = String(snippets.get(url) ?? '').trim().slice(0, 500);
      results.push({
        title,
        url,
        ...(snippet ? { snippet } : {}),
        ...(item.page_age ? { publishedAt: String(item.page_age).slice(0, 40) } : {})
      });
      if (results.length >= maxResults) return results;
    }
  }
  return results;
}

/** 校验搜索端点：https + 公网地址。返回 { url, addresses }。 */
async function validateSearchEndpoint(baseURL) {
  let url;
  try {
    url = new URL(String(baseURL ?? '').trim());
  } catch {
    throw new Error('webSearch.baseURL 无效');
  }
  if (url.protocol !== 'https:') throw new Error('webSearch.baseURL 必须是 https（API key 只能发给加密端点）');
  if (url.username || url.password) throw new Error('webSearch.baseURL 不能包含凭据');
  const addresses = await resolveSafeAddresses(url.hostname);
  return { url, addresses };
}

/**
 * 向搜索端点 POST JSON（单个已校验地址）。
 * 不复用 safeFetch（它只做 GET）：这里需要 POST、禁止重定向，并把 key 只交给校验过的地址。
 * 网络层失败（连接/超时/中断）由 postJson() 换地址重试；HTTP 状态是结果，不在这里重试。
 */
function postJsonOnce(url, address, { headers, body, timeoutMs, maxBytes = MAX_RESPONSE_BYTES }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let response;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`联网搜索请求超时（${Math.round(timeoutMs / 1000)}s）`);
      finish(error);
      req?.destroy(error);
      response?.destroy();
    }, timeoutMs);
    try {
      req = https.request({
        hostname: address,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          ...headers,
          host: url.host,
          'content-length': Buffer.byteLength(body)
        },
        // 证书校验用真实域名（SNI/Host 与站点一致），连接目标才是固定 IP。
        servername: url.hostname,
        rejectUnauthorized: true,
        timeout: timeoutMs
      }, (res) => {
        response = res;
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          finish(new Error(`联网搜索端点返回重定向（HTTP ${status}），已拒绝跟随`));
          res.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxBytes) {
            finish(new Error('联网搜索响应体过大，已中止'));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (error) => finish(error));
        res.on('aborted', () => finish(new Error('联网搜索响应中断')));
        res.on('close', () => { if (!res.complete) finish(new Error('联网搜索响应中断')); });
        res.on('end', () => {
          if (settled) return;
          const text = Buffer.concat(chunks).toString('utf8');
          finish(null, { status, text });
        });
      });
      req.on('timeout', () => {
        const error = new Error(`联网搜索请求超时（${Math.round(timeoutMs / 1000)}s）`);
        finish(error);
        req.destroy(error);
        response?.destroy();
      });
      req.on('error', (error) => finish(error));
      req.end(body);
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

/** 依次尝试前两个已校验地址（同一失败形态：DNS 先给 IPv6、本机没有 IPv6 出口）。 */
async function postJson(url, addresses, options) {
  const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean);
  if (!list.length) throw new Error('没有任何可用地址');
  const deadline = Date.now() + options.timeoutMs;
  const attempts = Math.min(list.length, 2);
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 500) break;
    const budget = attempts === 1 ? options.timeoutMs : Math.min(remaining, Math.ceil(options.timeoutMs / 2));
    try {
      return await postJsonOnce(url, list[i], { ...options, timeoutMs: budget });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('联网搜索请求失败');
}

/** DeepSeek 原生联网搜索。失败时抛出带稳定 code 的错误，由调用方决定是否回退。 */
export async function deepseekSearch(query, config = defaultConfig) {
  const { key } = resolveSearchApiKey(config);
  if (!key) {
    throw Object.assign(new Error('没有可用的 DeepSeek API key'), { code: 'NO_KEY' });
  }
  const baseURL = config.baseURL || process.env.DEEPSEEK_SEARCH_BASE_URL || DEFAULT_BASE_URL;
  const { url, addresses } = await validateSearchEndpoint(baseURL);
  const endpoint = new URL(`${url.toString().replace(/\/+$/, '')}/messages`);
  const body = JSON.stringify({
    model: config.model || DEFAULT_MODEL,
    max_tokens: config.maxTokens || defaultConfig.maxTokens,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }]
    }],
    tools: [{
      type: SEARCH_TOOL_TYPE,
      name: 'web_search',
      max_uses: config.maxUses || defaultConfig.maxUses
    }]
  });
  const response = await postJson(endpoint, addresses, {
    headers: {
      'x-api-key': key,
      authorization: `Bearer ${key}`,
      'anthropic-version': DEFAULT_API_VERSION,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'qq-bridge-web-search/0.2.0'
    },
    body,
    timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS
  });
  if (response.status < 200 || response.status >= 300) {
    // 只回显 HTTP 状态与主体里的简短错误，绝不拼接请求头（里面是 key）。
    let detail = '';
    try {
      const parsed = JSON.parse(response.text);
      const message = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.message;
      if (typeof message === 'string') detail = message.slice(0, 200);
    } catch {}
    throw Object.assign(
      new Error(`DeepSeek 搜索接口 HTTP ${response.status}${detail ? `：${detail}` : ''}`),
      { code: 'HTTP_ERROR', status: response.status }
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw Object.assign(new Error('DeepSeek 搜索接口返回了无法解析的响应'), { code: 'BAD_BODY' });
  }
  return mapDeepSeekResponse(parsed, config.maxResults || defaultConfig.maxResults);
}

/**
 * 清洗摘要里的 Markdown / HTML 残渣。
 *
 * 为什么需要：AnySearch 把网页正文片段直接塞进 snippet，萌娘百科这类站的片段常常是
 * `| [![标题](https://...jpg)](https://...)` 这样的图片语法。这种文本一旦被当成
 * "词条含义"写进 state/slang.json，就会出现在给 AI 的黑话表里 —— 模型看到的是
 * 一堆图片 URL，等于没学到东西。这里只留人能读的字。
 */
export function stripResultMarkup(text) {
  return String(text ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')          // Markdown 图片：整段丢弃
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')        // Markdown 链接：只留链接文字
    .replace(/<[^>]{1,200}>/g, ' ')                 // 残留 HTML 标签
    .replace(/https?:\/\/\S+/g, ' ')                // 裸 URL
    .replace(/\|{1,}/g, ' ')                        // 表格竖线
    .replace(/[*_`>#]{1,}/g, ' ')                   // 标题/强调符号
    .replace(/\s+/g, ' ')
    .trim();
}

/** AnySearch 返回体 → 本项目统一的 results 结构。 */
export function mapAnySearchResponse(parsed, maxResults = 8) {
  const raw = Array.isArray(parsed?.data?.results)
    ? parsed.data.results
    : (Array.isArray(parsed?.results) ? parsed.results : []);
  const results = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const url = normalizeSearchUrl(item.url ?? item.link);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = stripResultMarkup(item.title).slice(0, 200);
    // AnySearch 的 content 是正文片段（比 snippet 长），snippet 缺失时拿它兜底。
    // 先清洗再截断：否则截断可能正好切在图片语法中间，留下半截 URL。
    const snippet = stripResultMarkup(item.snippet ?? item.description ?? item.content ?? '').slice(0, 500);
    results.push({ title: title || url, url, ...(snippet ? { snippet } : {}) });
    if (results.length >= maxResults) break;
  }
  return results;
}

/**
 * AnySearch 原生搜索（Bearer 鉴权）。
 * 与 deepseekSearch 一样：只发往校验过的 https 公网地址、禁止跟随重定向、key 不进日志与错误信息。
 */
export async function anysearchSearch(query, config = defaultConfig) {
  const { key } = resolveAnySearchKey(config);
  if (!key) {
    throw Object.assign(new Error('没有可用的 AnySearch API key'), { code: 'NO_KEY' });
  }
  const endpointRaw = config.anysearchBaseURL || process.env.ANYSEARCH_BASE_URL || DEFAULT_ANYSEARCH_BASE_URL;
  const { url, addresses } = await validateSearchEndpoint(endpointRaw);
  const body = JSON.stringify({
    query: String(query ?? ''),
    max_results: Math.min(20, Math.max(1, Number(config.maxResults) || defaultConfig.maxResults))
  });
  const response = await postJson(url, addresses, {
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'qq-bridge-web-search/0.3.0'
    },
    body,
    timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS
  });
  if (response.status < 200 || response.status >= 300) {
    // 只回显状态码与主体里的简短说明，绝不拼接请求头（里面是 key）。
    let detail = '';
    try {
      const parsed = JSON.parse(response.text);
      const message = typeof parsed?.message === 'string' ? parsed.message
        : (typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message);
      if (typeof message === 'string') detail = message.slice(0, 200);
    } catch {}
    throw Object.assign(
      new Error(`AnySearch 接口 HTTP ${response.status}${detail ? `：${detail}` : ''}`),
      { code: 'HTTP_ERROR', status: response.status }
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw Object.assign(new Error('AnySearch 接口返回了无法解析的响应'), { code: 'BAD_BODY' });
  }
  // 业务错误也可能带 200：只看 HTTP 状态会把 code != 0 当成"搜到了 0 条"。
  if (parsed && typeof parsed.code === 'number' && parsed.code !== 0) {
    throw Object.assign(
      new Error(`AnySearch 返回错误 ${parsed.code}${parsed.message ? `：${String(parsed.message).slice(0, 200)}` : ''}`),
      { code: 'API_ERROR', apiCode: parsed.code }
    );
  }
  return mapAnySearchResponse(parsed, config.maxResults || defaultConfig.maxResults);
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTag(block, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return match ? decodeEntities(match[1]) : '';
}

/** Bing 的 RSS 结果（比 HTML 页面稳定：没有 JS、结构固定）。 */
export function parseBingRss(xml, maxResults = 8) {
  const results = [];
  const seen = new Set();
  for (const match of String(xml ?? '').matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const url = normalizeSearchUrl(pickTag(block, 'link'));
    if (!url || seen.has(url)) continue;
    const title = pickTag(block, 'title').slice(0, 200);
    const snippet = pickTag(block, 'description').slice(0, 500);
    seen.add(url);
    results.push({ title: title || url, url, ...(snippet ? { snippet } : {}) });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Bing 的 HTML 结果页（RSS 不可用时的兜底，保持旧实现的解析口径）。 */
export function parseBingHtml(html, maxResults = 8) {
  const results = [];
  const seen = new Set();
  const blocks = String(html ?? '').split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const url = normalizeSearchUrl(decodeEntities(hrefMatch[1]));
    if (!url || seen.has(url)) continue;
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeEntities(titleMatch[1]).slice(0, 200) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeEntities(snippetMatch[1]).slice(0, 500) : '';
    seen.add(url);
    results.push({ title: title || url, url, ...(snippet ? { snippet } : {}) });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Bing 搜索（RSS 优先，HTML 兜底）。 */
export async function bingSearch(query, config = defaultConfig) {
  const maxResults = config.maxResults || defaultConfig.maxResults;
  const rss = new URL('https://cn.bing.com/search');
  rss.searchParams.set('q', query);
  rss.searchParams.set('format', 'rss');
  rss.searchParams.set('count', String(Math.min(20, maxResults)));
  rss.searchParams.set('setlang', 'zh-hans');
  rss.searchParams.set('cc', 'CN');
  try {
    const res = await safeFetch(rss.toString(), 512000);
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const results = parseBingRss(res.body, maxResults);
      if (results.length) return results;
    }
  } catch {}
  const html = new URL('https://cn.bing.com/search');
  html.searchParams.set('q', query);
  html.searchParams.set('count', String(Math.min(20, maxResults)));
  html.searchParams.set('setlang', 'zh-hans');
  html.searchParams.set('cc', 'CN');
  const res = await safeFetch(html.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Bing 搜索 HTTP ${res.statusCode}`);
  return parseBingHtml(res.body, maxResults);
}

const cache = new Map(); // `${provider}|${query}` -> { at, value }

export function clearSearchCache() {
  cache.clear();
}

/**
 * 统一入口：按配置选择 provider；`auto` 先试 DeepSeek（与 DSH 同源），失败回退 Bing。
 * `anysearch` 是显式后端（见 anysearchSearch），失败时依次回退 DeepSeek、Bing。
 * @returns {{query:string, provider:'deepseek'|'bing'|'anysearch', results:object[], fallbackFrom?:string, note?:string}}
 */
export async function webSearch(query, options = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('查询词为空');
  const config = { ...loadSearchConfig(options.root ?? process.cwd()), ...(options.config ?? {}) };
  const wanted = options.provider ?? config.provider;
  const cacheKey = `${wanted}|${q}|${config.maxResults}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const attemptDeepSeek = async () => {
    const results = await deepseekSearch(q, config);
    return { query: q, provider: 'deepseek', results };
  };
  const attemptBing = async () => {
    const results = await bingSearch(q, config);
    return { query: q, provider: 'bing', results };
  };
  const attemptAnySearch = async () => {
    const results = await anysearchSearch(q, config);
    return { query: q, provider: 'anysearch', results };
  };

  let value;
  if (wanted === 'deepseek') {
    value = await attemptDeepSeek();
  } else if (wanted === 'bing') {
    value = await attemptBing();
  } else if (wanted === 'anysearch') {
    // 显式选 AnySearch 时也保留兜底：key 失效/额度耗尽不该让整轮对话变成"搜不了"。
    try {
      value = await attemptAnySearch();
    } catch (error) {
      const reason = error?.code === 'NO_KEY'
        ? '未配置 AnySearch 搜索凭据（webSearch.anysearchApiKey）'
        : `AnySearch 不可用：${error?.message ?? error}`;
      let fallback = null;
      let fallbackError = '';
      try {
        fallback = await attemptDeepSeek();
      } catch (deepseekError) {
        try {
          fallback = await attemptBing();
        } catch (bingError) {
          fallbackError = `${deepseekError?.message ?? deepseekError}；Bing：${bingError?.message ?? bingError}`;
        }
      }
      if (!fallback) throw new Error(`${reason}；兜底也失败：${fallbackError}`);
      value = {
        ...fallback,
        fallbackFrom: 'anysearch',
        note: `${reason}，已回退 ${fallback.provider === 'deepseek' ? 'DeepSeek' : 'Bing'}`
      };
    }
  } else {
    try {
      value = await attemptDeepSeek();
    } catch (error) {
      const reason = error?.code === 'NO_KEY' ? '未配置 DeepSeek 搜索凭据' : `DeepSeek 搜索不可用：${error?.message ?? error}`;
      try {
        value = await attemptBing();
      } catch (bingError) {
        // 两个后端都失败时把**两边**的原因都带出来，否则调用方只会看到 Bing 的错，
        // 完全不知道 DeepSeek 这一路为什么不行（排查时最需要的信息）。
        throw new Error(`${reason}；Bing 兜底也失败：${bingError?.message ?? bingError}`);
      }
      value = { ...value, fallbackFrom: 'deepseek', note: `${reason}，已回退 Bing` };
    }
  }
  // 空结果必须显式说明：以前直接返回 `results: []`，模型分不清「真没搜到」和
  // 「搜索接口静默失效」，会一直换关键词重试（issue #17）。现在给出可操作的下一步。
  // ⚠️ 这段必须在 `cache.set` **之前**：note 走的是「新建对象」而不是原地改，
  // 而缓存里存的是**引用**。反过来写（先缓存、后加 note）时，5 分钟内的重复查询会命中
  // 那个没有 note 的旧对象 —— 恰好是模型最容易开始重试的场景（同一句 query 连着问）。
  if (Array.isArray(value.results) && value.results.length === 0) {
    value = { ...value, note: [value.note, '没有搜到结果（可换个说法/加限定词；仍为空就不要再重复搜索）'].filter(Boolean).join('；') };
  }
  cache.set(cacheKey, { at: Date.now(), value });
  if (cache.size > CACHE_MAX_ENTRIES) {
    for (const key of [...cache.keys()].slice(0, cache.size - CACHE_MAX_ENTRIES)) cache.delete(key);
  }
  return value;
}
