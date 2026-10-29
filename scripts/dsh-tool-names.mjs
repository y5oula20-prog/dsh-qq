// DSH 工具名抽取：**唯一实现**，供
//   · `scripts/scan-dsh-tool-names.mjs`（人工/升级时对账，打印清单）
//   · `scripts/test-preset-local-tools.mjs`（登记期断言，防拼错假名）
// 共同使用。
//
// 为什么要抽成模块：这两处过去各有一份实现，而测试那份是**模糊**的
// （`\bname:\s*['"]x['"]` 全文件乱扫 + 只认少数包名前缀 + 只读包根目录的
// cordis.patch.yml）。结果 0.2.0 对账时把 10 个**真实存在**的工具名误判成
// 「假名」——`dsh-mcp-resources` 与 `dsh-experimental-tool-agent-team` 不匹配它
// 的包名白名单，`subagent_codex` 写在 `dsh-web-app/presets/*.patch.yml` 而不是
// 包根。误判方向是危险的：它会逼人把真名字从守卫名单里删掉。
//
// 抽取规则（都要求**就近锚定**，不把 `systemPrompt.section({ name: 'tool:read' })`
// 这类非工具名当工具）：
//   ① `.register(defineTool({ … name: "X" … }))` —— DSH 所有工具包的注册形状
//   ② `toolName: "X"` / `toolName: z.string().default("X")` —— 配置化工具名
//      （dsh-tool-subagent 的 subagent / subagent_fork 就是这样声明的）
//   ③ YAML patch 里的 `toolName: X` 行（任意层级 *.patch.yml，含 presets/ 子目录）
import fs from 'node:fs';
import path from 'node:path';
import { dshHome, dshModulesDir, walkAsarPackages } from './dsh-modules.mjs';

/** 名字形态：小写字母开头，允许下划线与连字符，长度合理。 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{1,40}$/;

/** DSH 自带包所在目录（`<node_modules>/@deepseek-ai`）。 */
export function dshPackagesDir() {
  return process.env.DSH_TOOL_PACKAGES || path.join(dshModulesDir(), '@deepseek-ai');
}

/** 用户安装的第三方插件目录（也会注册工具：plugin-guard / 超级注入器等）。 */
export function dshPluginDirs() {
  const home = process.env.DSH_HOME
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh') : null);
  return [home ? path.join(home, 'plugins') : null].filter((p) => p && fs.existsSync(p));
}

function walkFiles(dir, out = [], depth = 0, maxDepth = 5) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < maxDepth) walkFiles(full, out, depth + 1, maxDepth); }
    else out.push(full);
  }
  return out;
}

/** 从一个 JS/TS 源文件里抽取工具名。 */
function extractFromSource(text, source, add) {
  for (const m of text.matchAll(/\.register\(\s*defineTool\(\{[\s\S]{0,400}?\bname:\s*["']([^"']+)["']/g)) {
    add(m[1], source);
  }
  for (const m of text.matchAll(/\btoolName:\s*["']([^"']+)["']/g)) add(m[1], source);
  for (const m of text.matchAll(/\btoolName:\s*[^;\n]*?\.default\(\s*["']([^"']+)["']/g)) add(m[1], source);
  // 独立的一次性工具文件（defineTool 不挂在 .register( 上时的兜底）
  for (const m of text.matchAll(/defineTool\(\{[\s\S]{0,200}?\bname:\s*["']([^"']+)["']/g)) {
    add(m[1], source);
  }
}

/** 从 YAML patch 里抽取配置化的工具名。 */
function extractFromPatch(text, source, add) {
  for (const m of text.matchAll(/^\s*(?:-\s*)?toolName:\s*([^\s#]+)\s*$/gm)) {
    add(m[1].replace(/^['"]|['"]$/g, ''), source);
  }
}

/**
 * 抽取已安装 DSH（及其插件）里出现的全部工具名。
 *
 * @param options.packagesDir - `@deepseek-ai` 目录；缺省按 {@link dshPackagesDir} 解析。
 * @param options.pluginDirs - 第三方插件目录列表；缺省按 {@link dshPluginDirs} 解析。
 * @returns `{ names: Map<name, Set<source>>, packages: string[] }`。
 *          `packages` 是实际扫过的包/插件名，便于诊断「一个都没扫到」。
 */
export function collectDshToolNames({ packagesDir, pluginDirs } = {}) {
  const names = new Map();
  const packages = [];
  const add = (name, source) => {
    if (!TOOL_NAME_RE.test(name)) return;
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(source);
  };

  const roots = [];
  const pkgRoot = packagesDir ?? dshPackagesDir();
  if (fs.existsSync(pkgRoot)) roots.push({ dir: pkgRoot, filter: /^dsh-/ });
  for (const dir of pluginDirs ?? dshPluginDirs()) {
    // 用户的插件目录里全是插件包（含 .bak-* 备份，也一起扫：备份里的旧名字
    // 仍然说明这个名字曾经真实存在）。
    roots.push({ dir, filter: null });
  }

  for (const { dir, filter } of roots) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (filter && !filter.test(e.name)) continue;
      const pkgDir = path.join(dir, e.name);
      packages.push(e.name);
      for (const f of walkFiles(pkgDir)) {
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        if (/\.(js|mjs|cjs)$/.test(f) || f.endsWith('.d.ts')) extractFromSource(text, e.name, add);
        else if (/\.patch\.ya?ml$/.test(f)) extractFromPatch(text, e.name, add);
      }
    }
  }

  // 桌面版补充来源：DSH 安装包在 app.asar 里，磁盘上根本没有 @deepseek-ai/dsh-*。
  // 只扫磁盘会得到个位数名字（实测 2 个），于是「守卫名单里每个名字都真实存在」这条
  // 断言把全部真名误报成假名。命令行版这里返回 null，不产生任何重复扫描。
  try {
    const asarResult = walkAsarPackages(({ package: pkg, path: rel, text }) => {
      if (/\.(js|mjs|cjs|ts)$/.test(rel)) extractFromSource(text, `${pkg}(asar)`, add);
      else if (/\.patch\.ya?ml$/.test(rel)) extractFromPatch(text, `${pkg}(asar)`, add);
    });
    if (asarResult) {
      for (const p of asarResult.packages) if (!packages.includes(p)) packages.push(p);
    }
  } catch { /* asar 不可读：磁盘来源已经尽力了 */ }

  return { names, packages };
}

/** 便利包装：只要名字集合。 */
export function dshToolNameSet(options) {
  return new Set(collectDshToolNames(options).names.keys());
}

/**
 * 「危险语义」判定：与本地执行 / 文件 / 进程 / 派生 agent / 宿主运行期相关的名字。
 * 守卫**必须**覆盖它们。纯模型侧无害工具由 {@link SAFE_MODEL_TOOLS} 显式排除。
 *
 * 这是**发现用**的启发式（宁可多报，人工再判），不是安全边界本身；
 * 边界是守卫的 restrict 名单 + 执行期白名单。
 */
export const DANGER_TOOL_RE = /(pwsh|bash|shell|exec|spawn|process|terminal|pty|read|write|edit|file|fs_|glob|grep|patch|str_replace|subagent|agent_|teammate|workflow|ralph|job|skill|present|goal|plan|todo|memory|snapshot|rollback|incident|plugin|cordis|dsh_|dev_|import|install|reload|inject|stage|config|workspace|session|export|office|slash|command|schedule|voice|speech|team|mcp_resource)/;

/** 明确无害、允许出现在仿真会话 schema 里的模型侧工具。 */
export const SAFE_MODEL_TOOLS = new Set(['ask_user_question', 'todo_write']);

/**
 * 守卫名单里**故意保留、但本机可能根本没装**的工具名（来自可选 bundle 或第三方插件）。
 *
 * 为什么需要这张表：守卫名单是回归网，它要挡住「哪天某个可选 bundle 被加进来」的情况，
 * 所以名字必须提前写好；但「名字真实存在」这条断言在没装那个 bundle 的机器上必然失败，
 * 而失败方向是危险的 —— 它会逼人把真名字从守卫里删掉。
 *
 * 每一条都必须写明出处，且**只能**收录有明确包来源的名字；凭感觉写进来的名字就是
 * 真的拼写错误，应当让断言红起来。
 *
 * 桌面版实测（DSH 0.2.1-rc.3，296 个 asar 包 + 74 个会话缓存）后剩下的 4 个：
 */
export const OPTIONAL_BUNDLE_TOOLS = new Map([
  // dsh-plugin-guard（web profile bundle；桌面版没装 → asar 与会话里都没有）
  ['dsh_snapshot', 'dsh-plugin-guard'],
  ['dsh_rollback', 'dsh-plugin-guard'],
  ['incident_resolved', 'dsh-plugin-guard'],
  // Codex / Claude Code 子智能体 bundle（不在 DSH 自带包里，需要单独安装）
  ['subagent_codex', 'subagent-codex bundle'],
  ['subagent_claude_code', 'subagent-claude-code bundle'],
]);

/**
 * 从**真实会话缓存**里抽「宿主实际发给模型的工具名」。
 *
 * 为什么需要这条路：在 macOS / Windows 桌面版上，DSH 的工具实现编译进 `app.asar`，
 * profile 的 `node_modules/@deepseek-ai` 里只有 cosmokit / dsh-home-paths / schemastery
 * 三个辅助包 —— {@link collectDshToolNames} 扫出来只有个位数名字，于是「名字是否真实存在」
 * 这条断言会把**全部真实工具名**误报成假名（误判方向与拼错假名同样是危险的：
 * 它会逼人把真名字从守卫名单里删掉）。
 *
 * 会话缓存里的 `record.rows.contextHeaders.val.headers[].tools[]` 是宿主每轮组装后
 * 实际下发的 schema 清单，比扫安装包更权威，且不依赖部署形态。
 *
 * @param options.cacheDir - 会话缓存目录；缺省 `$DSH_HOME/storages/session_projcache/sessions`。
 * @param options.presetFilter - 只统计挂在这些 preset 上的会话（例如只看 QQ 侧）。
 *        不传 = 全部会话（桌面 standard 与 QQ preset 混在一起）。
 *        **判「守卫漏了什么」时必须传 QQ preset**：桌面 standard 会话有自己的工具面
 *        （`exit_plan_mode` 之类），混进来只会制造假阳性。
 * @returns `{ names: Set<string>, sessions: number }`；读不到任何会话时 `names` 为空集。
 */
export function collectObservedToolNames({ cacheDir, presetFilter } = {}) {
  const wanted = presetFilter ? new Set(presetFilter) : null;
  const dir = cacheDir || path.join(dshHome(), 'storages', 'session_projcache', 'sessions');
  const names = new Set();
  let sessions = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return { names, sessions }; }
  for (const file of entries) {
    if (!file.startsWith('session-') || !file.endsWith('.json')) continue;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
    if (wanted) {
      const preset = doc?.record?.rows?.agentPreset?.val;
      if (!wanted.has(preset)) continue;
    }
    const headers = doc?.record?.rows?.contextHeaders?.val?.headers;
    if (!Array.isArray(headers)) continue;
    let hit = false;
    for (const header of headers) {
      if (!Array.isArray(header?.tools)) continue;
      for (const tool of header.tools) {
        const name = typeof tool === 'string' ? tool : tool?.name;
        if (typeof name === 'string' && TOOL_NAME_RE.test(name)) { names.add(name); hit = true; }
      }
    }
    if (hit) sessions += 1;
  }
  return { names, sessions };
}

/** 便利包装：只要「真实下发过」的名字集合。 */
export function dshObservedToolNameSet(options) {
  return collectObservedToolNames(options).names;
}

/**
 * 合并两个来源的工具名集合：安装包源码（①） + 会话缓存里实际下发过的（②）。
 *
 * 为什么必须合并而不是二选一：
 *   · 只走 ① —— 桌面版把工具编译进 `app.asar`，profile 的 `node_modules/@deepseek-ai`
 *     里没有实现包，本机只抽到 2 个名字，于是「守卫名单里每个名字都真实存在」这条
 *     断言把**所有真名**误报成假名（误判方向与拼错假名同样危险：会逼人删掉真名字）；
 *   · 只走 ② —— 新装但还没跑过会话的工具不在里面，漏检新版本新增的危险能力。
 *
 * @returns `{ names: Map<name, Set<source>>, packages: string[], sessions: number, scanned: boolean }`。
 *          `scanned === false` 表示两个来源都没拿到东西，调用方应当「跳过」而不是判定失败。
 */
export function collectAllToolNames({ packagesDir, pluginDirs, cacheDir, presetFilter } = {}) {
  const names = new Map();
  const add = (name, source) => {
    if (!TOOL_NAME_RE.test(name)) return;
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(source);
  };

  let packages = [];
  try {
    const scanned = collectDshToolNames({ packagesDir, pluginDirs });
    packages = scanned.packages;
    for (const [name, sources] of scanned.names) for (const s of sources) add(name, s);
  } catch { /* 安装目录定位失败：交给会话来源 */ }

  let sessions = 0;
  try {
    const observed = collectObservedToolNames({ cacheDir, presetFilter });
    sessions = observed.sessions;
    for (const name of observed.names) add(name, 'observed-session');
  } catch { /* 会话缓存不可读：交给安装包来源 */ }

  return { names, packages, sessions, scanned: names.size > 0 };
}
