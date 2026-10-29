// DSH 工具名清单扫描器：从**已安装的 DSH 包/插件**里抽取真实注册的工具名，
// 与 QQ 守卫的 restrict 名单对账。
//
// 为什么要有这个脚本（而不是把清单抄死在注释里）
// ----------------------------------------------
// `tools.restrict({ deny: [name] })` 对**不存在的工具名会抛错**，而守卫是逐个
// try/catch 的 ⇒ 拼错/过期的名字 = 静默 no-op，安全边界无声地少一层。
// 反过来，DSH 每个版本都会新增工具，守卫漏掉新名字 = 该隐藏的能力留在
// 仿真会话的 schema 里。两类漂移都只能靠「拿安装包重新对账」发现。
//
// 抽取逻辑在 scripts/dsh-tool-names.mjs（唯一实现，测试与扫描器共用）；
// 本文件只是 CLI：打印、分类、给退出码。
//
// 本脚本是**只读**的：不改任何文件。
//
// 用法：
//   node scripts/scan-dsh-tool-names.mjs            # 对账并打印全部候选
//   node scripts/scan-dsh-tool-names.mjs --missing  # 只打印值得补进守卫的名字
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  collectAllToolNames, collectObservedToolNames, dshPackagesDir,
  DANGER_TOOL_RE, SAFE_MODEL_TOOLS, TOOL_NAME_RE,
} from './dsh-tool-names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 两个来源合并（见 dsh-tool-names.mjs 的 collectAllToolNames）：桌面版工具编译在
// app.asar 里，只扫安装包抽不到名字，必须叠加「会话缓存里实际下发过」的那一份。
// 「名字是否真实存在」必须用**全量**会话：QQ 侧 schema 已经被守卫隐藏过一部分
// （bash/read/write… 正是要隐藏的目标），只扫 QQ 会话会把它们全部误报成假名。
const all = collectAllToolNames();
const { names, packages, sessions } = all;
const guardPath = path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
const guard = await import(pathToFileURL(guardPath).href);
const guarded = new Set(guard.RESTRICTED_TOOL_NAMES);

const sorted = [...names.keys()].sort();

// 「漏隐藏」只看 QQ 侧会话实际下发的工具面：桌面 standard 会话有自己的工具集
// （`exit_plan_mode` 等），混进来全是假阳性。
const QQ_SIDE_PRESETS = ['qq-chat', 'qq-chat-v2', 'qq-agent-readonly', 'qq-agent-workspace', 'qq-agent-full'];
const qqSide = collectObservedToolNames({ presetFilter: QQ_SIDE_PRESETS });
const onlyFlag = process.argv.includes('--missing');

/**
 * 真实存在、但**本机部署形态没注册**的名字：与 test-preset-local-tools.mjs 里
 * NOT_REGISTERED_HERE_TOOL_NAMES 同一份口径。它们不是拼错的假名，不算失败。
 */
const NOT_REGISTERED_HERE = new Set([
  'pwsh',                       // 只在 Windows 注册（macOS 走 bash）
  'str_replace_editor',         // 可选 bundle，默认不启用
  'cordis_inspect_list',        // dsh-tool-cordis，桌面版没挂
  'cordis_inspect_query',
  'plugin_manager',             // 插件装载权，只在开发/注入器 profile
  'list_subagent_models',       // 派生 agent 家族需额外 bundle
  'ralph',
  'subagent_codex',
  'subagent_claude_code',
  'spawn_teammate',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
]);
/** 可选第三方 bundle 的工具名（装了才存在，见 test-preset-local-tools.mjs）。 */
const OPTIONAL_BUNDLE = new Set(['dsh_snapshot', 'dsh_rollback', 'incident_resolved']);

console.log(`DSH 包目录：${dshPackagesDir()}`);
console.log(`扫描包数：${packages.length}；会话缓存：${sessions} 个；抽到工具名候选：${sorted.length}；`
  + `QQ 侧会话：${qqSide.sessions} 个（${qqSide.names.size} 个工具）\n`);

/** ① 守卫名单里的名字必须真实存在，否则 restrict 抛错被吞、限制静默失效。 */
const fabricated = [...guarded]
  .filter((n) => TOOL_NAME_RE.test(n) && !n.startsWith('dev_')
    && !NOT_REGISTERED_HERE.has(n) && !OPTIONAL_BUNDLE.has(n) && !names.has(n));
console.log('=== ① 守卫名单里、但安装包中找不到的名字（restrict 会抛错并静默失效） ===');
console.log(fabricated.length ? fabricated.map((n) => `  ${n}`).join('\n') : '  (无)');

/** ② 安装包里有、守卫没覆盖的危险语义名字（可能是新版本新增的能力）。 */
// 守卫主动放行的前缀/精确名不参与「漏隐藏」判定，
// 否则 `qq_memory_*` 会被 memory 关键字误报。
const ALLOWED_PREFIXES = [...(guard.SAFE_PREFIXES ?? [])];
const ALLOWED_EXACT = new Set([...(guard.SAFE_EXACT ?? []), ...SAFE_MODEL_TOOLS]);
const isAllowed = (n) => ALLOWED_EXACT.has(n) || ALLOWED_PREFIXES.some((p) => n.startsWith(p));
const missing = [...qqSide.names].sort().filter((n) => DANGER_TOOL_RE.test(n) && !guarded.has(n)
  && !SAFE_MODEL_TOOLS.has(n) && !isAllowed(n));
console.log('\n=== ② 安装包里有、守卫名单里没有的「危险语义」名字（可能漏隐藏） ===');
console.log(missing.length ? missing.map((n) => `  ${n}  ← ${[...names.get(n)].join(', ')}`).join('\n') : '  (无)');

if (!onlyFlag) {
  console.log('\n=== ③ 全部候选名字（含来源包） ===');
  for (const n of sorted) {
    console.log(`  ${guarded.has(n) ? '[在名单]' : '[      ]'} ${n}  ← ${[...names.get(n)].join(', ')}`);
  }
}

console.log(`\n守卫名单 ${guarded.size} 个名字；其中悬空（假名）${fabricated.length} 个；候选里未覆盖的危险名 ${missing.length} 个。`);
process.exitCode = (fabricated.length === 0 && missing.length === 0) ? 0 : 1;
