// QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。
//
// 本文件是 qq-agent-presets bundle 里的**唯一权威实现**，由 qq-chat / qq-chat-v2 两个
// agent preset 的 qq-tool-restrict 行共同引用（dsh/agent-presets/<preset>/qq-tool-restrict.mjs
// 只是个 re-export 壳，避免出现两份会漂移的实现）。
//
// 为什么引用方式是「包名/子路径」而不是 `./qq-tool-restrict.mjs`（DSH 0.1.7 的机制变化）：
//   0.1.5 的 preset 是 ~/.dsh/.agent-presets/<preset>/ 目录，相对名按 preset 目录解析；
//   0.1.7 的 preset 变成一条 loader 行，子行 name 按**声明它的 loader 上下文**
//   （= profile 目录 file:///…/.dsh/profiles/<profile>/）解析，因此 `./x.mjs` 会去找
//   profile 根目录下的文件（不存在）。bundle patch 文件只对 insert 行自己的 name 做
//   「相对 patch 文件锚定」（dsh-app-boot 的 anchorInsertedPluginNames），不会走进
//   preset 行的 config.plugins —— 所以守卫只能用**从 profile 目录可解析的裸说明符**。
//   该包以 link: 依赖注册在 profile package.json，node_modules junction 由
//   scripts/setup-dsh.mjs（或 dsh-super-injector 的 dev_heal_links）维护：
//   不写死任何绝对路径，仓库搬家后重建链接即可。
// 作用：
//  1) 用 tools.restrict 把本地执行/文件类工具与开发工具从**工具清单**里隐藏（注册期）；
//  2) 用 tools.guard 白名单兜底：任何不在允许范围内的工具，执行时一律拒绝。
//
// ⚠️ 第 1 条是铁律 L7 的落点，不是"附注"：仿真会话的 preset 永不包含本地工具。
//    `tools.guard` 只能拒绝**执行**，工具名仍会出现在模型的 schema 里——
//    那既不满足"仿真会话不得拥有本地执行能力"的注册期要求，也会诱导模型去调它。
//    所以本地工具必须同时出现在下面的 restrict 名单里。
import { protectedFileReason } from './protected-paths.mjs'

export const name = 'qq-tool-restrict'

export const inject = ['tools']

/**
 * 本地执行 / 文件访问 / 进程控制类工具：仿真会话**不得**拥有。
 *
 * 名字**逐个核对过** DSH 0.1.7-rc.2 实际注册的工具名（来源包见每条注释），
 * 不是凭印象列举。教训：本名单初版把 `pwsh_persistent`/`bash_persistent`/
 * `cordis`/`goal_write`/`goal_read` 当成工具名，这五个**根本不存在**——
 * 而 `tools.restrict()` 对未知名字会抛错、被下面的 try/catch 逐个吞掉，
 * 于是坏名字**静默失效**。`test-preset-local-tools.mjs` 现在会把本数组与
 * DSH 真实工具名集合求差，专门防这类拼写假名。
 *
 * 2026-09-27 针对 0.1.7-rc.2 重新对账（不是逐个打补丁）：`dsh-tool-cordis` 仍在，
 * 但 `cordis_define`/`cordis_undefine`/`cordis_run`/`cordis_stop` 四个名字**已被删除**，
 * 现在只注册 `cordis_inspect_list`/`cordis_inspect_query`——旧名字留在名单里
 * 只会换来四条静默失效的 restrict（正是本名单最怕的失败模式），
 * 而新名字能读宿主运行期状态，属于必须隐藏的那一类，所以是**替换**不是删除。
 * 同一轮对账还补上了 0.1.7 新增的两个能力：
 *   - `load_workspace_dependencies`（自带 Python/Node/pnpm 的绝对路径 ⇒ 等于递上执行能力）
 *   - `list_subagent_models`（派生 agent 家族，暴露宿主模型路由配置）
 *
 * 来源包（0.1.7-rc.2）：
 *   dsh-tool-pwsh / -pwsh-persistent   → pwsh（persistent 变体注册的就是 "pwsh"）
 *   dsh-tool-bash / -bash-persistent   → bash（同上）
 *   dsh-tool-fs                        → read / read_image / write / edit
 *   dsh-tool-fs-search                 → glob / grep
 *   dsh-tool-str-replace-editor        → str_replace_editor
 *   dsh-tool-workspace-dependencies    → load_workspace_dependencies
 *                                        （返回内置 Python/Node/pnpm 的绝对路径）
 *   dsh-tool-subagent                  → subagent / subagent_fork / list_subagent_models
 *   dsh-tool-subagent-control          → send_message / interrupt_agent / list_agents
 *   dsh-tool-workflow / -ralph         → workflow / ralph
 *   dsh-tool-jobs                      → job_list / job_output / job_kill
 *   dsh-tool-todo / -skill / -present  → todo_write / skill / present
 *   dsh-tool-goal                      → get_goal / create_goal / update_goal
 *   dsh-tool-cordis                    → cordis_inspect_list / cordis_inspect_query
 *                                        （读宿主运行期状态；0.1.7 已无装载类工具名）
 *   dsh-plugin-guard（web profile bundle）→ dsh_snapshot / dsh_rollback / incident_resolved
 *                                        （读写 package.json/lockfile/patch 并 **spawn pnpm**）
 *   dsh-mode-boost（已装插件，当前未进 bundles）→ dev_mode_set / _status / _subagent
 *                                        （dev_mode_subagent 会派生 agent）
 *
 * ⚠️ 硬证据：2026-08-29 的一次 **qq-chat-v2 仿真会话**记录下来的工具清单里，
 * 除了 MCP 工具就只有 `ask_user_question`、`todo_write`、`dev_mode_*`、
 * `dsh_rollback`、`dsh_snapshot`、`incident_resolved`。也就是说
 * **`dsh_snapshot`/`dsh_rollback` 真的进过仿真会话的 schema**——本名单初版漏了它们。
 *
 * 2026-09-29 针对 DSH 0.2.0-rc.2 重新对账（同样不是逐个打补丁，而是拿安装包重扫）。
 * 对账工具：`node scripts/scan-dsh-tool-names.mjs`（可重复运行；它从已安装的
 * `@deepseek-ai/dsh-*` 里抽真实工具名，与本名单求双向差）。
 * 该轮结论：**旧名字全部还在**（0 个假名，0.1.7 那次替换后没有再次改名），
 * 但 0.2.0 的包里多出 13 个「危险语义」名字是名单没覆盖的，逐条判定如下：
 *
 *   ① 真的会进仿真会话、必须隐藏的（它们在**全局层**，所有 preset 都继承）：
 *      · `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`
 *        —— `dsh-base` 的 `mcp-resources` 行**默认启用**（cordis.patch.yml 里没有
 *        disabled），所以每个 QQ 会话都会继承这三个工具。`read_mcp_resource` 的
 *        `server` 参数可以指向**任意已配置的 MCP server**：用户一旦挂了
 *        filesystem 之类的能力型 MCP，QQ 群就通过它拿到了文件读取权。
 *        这正是 L7 要挡的那类越权路径，因此必须从 schema 里隐藏。
 *   ② 会派生 agent / 执行外部代码（当前只在 DSH 自带 preset 里挂载，QQ preset 不挂；
 *      列进来是**回归网**：别的 composition 一旦把它们推进全局层就被挡住）：
 *      · `subagent_codex` / `subagent_claude_code`（Codex / Claude Code 子智能体）
 *      · `spawn_teammate` / `team_task_create|get|list|update`（实验性 Team 模式）
 *   ③ 等于把插件装载权交出去 ⇒ 任意代码执行：
 *      · `plugin_manager`（安装/卸载/启停插件，内部会 spawn pnpm）
 *   ④ 无人值守的自我调度（`dsh-schedule`，0.2.0 起是可选 bundle）：
 *      · `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`
 */
const LOCAL_EXECUTION_TOOLS = [
  // shell / 进程
  'pwsh', 'bash',
  // 文件读写
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  // 文件检索
  'glob', 'grep',
  // 自带运行时（Python/Node/pnpm 的绝对路径）⇒ 等于把"跑代码"递给模型
  'load_workspace_dependencies',
  // 派生 agent 与编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // 插件/cordis 运行期检查：能读宿主状态（0.1.7 起只有这两个名字）
  'cordis_inspect_list', 'cordis_inspect_query',
  // 本机文件 + 进程：plugin-guard 会改写配置并 spawn pnpm
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话/交付/任务面
  // 注意：`todo_write` 与 `ask_user_question` **故意不在**此名单——它们是下面
  // SAFE_EXACT 允许的无害模型侧工具，两边不能自相矛盾。
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // 0.2.0 新增对账（见上方长注释的 4 类判定）：
  //   ① 全局层默认启用 ⇒ 真的会进仿真会话
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  //   ② 派生 agent / 执行外部代码
  'subagent_codex', 'subagent_claude_code',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  //   ③ 插件装载权（= 任意代码执行）
  'plugin_manager',
  //   ④ 无人值守的自我调度
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 已装但当前未进 bundles 的插件（一旦加回就是新口子）
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
]

/**
 * 2026-10-28：**不是危险工具、但仿真会话用不上**的那一批 —— 专门为了省 token 藏起来。
 *
 * 为什么需要这一组（与上面的 LOCAL_EXECUTION_TOOLS 是两种不同动机）：
 *   上面那组是 L7 安全边界（不得拥有本地执行能力），名字一旦写错就是**安全漏洞**；
 *   这一组纯粹是**工具清单开销**：仿真会话实测 96 个工具 / 19,957 tokens，
 *   而鲸鱼娘 899 次工具调用里只碰过 17 个，`univer_*` / `whale_dive_*` 之外的
 *   桌面工作流工具（journal / personality / research / working_directory / 各种
 *   search 变体）在 QQ 侧**一次都没用过**，却每轮都在 schema 里占位。
 *
 * 名字来源（2026-10-28 实测，不是凭印象）：从 `~/.dsh/storages/session_projcache/
 * sessions/session-*.json` 的 `record.rows.contextHeaders.val.headers[-1].tools`
 * 里取 —— 那是模型**真实收到的** schema，比扫安装包更准（本机工具实现在 app.asar
 * 里，`scripts/scan-dsh-tool-names.mjs` 只能扫到 2 个候选）。
 *
 * ⚠️ 这批名字同样受「拼错即静默失效」影响，改之前必须用真实 schema 对一遍。
 */
const USELESS_IN_QQ_TOOLS = [
  // 本机执行面（dsh-ops 接管 bash/read 之后注册的新名字；
  // 旧的 'bash'/'read' 已不存在，但保留在上面那组里当回归网）
  'ops_bash', 'ops_read_files', 'ops_discover_tools',
  // 桌面侧边栏 / 编辑器
  'sidebar_open',
  // free-search 家族里 QQ 用不到的几个（她只用 mcp__web-search-safe__）
  'advanced_search', 'domain_search', 'free_search_test',
  'platform_search', 'multi_search', 'video_search',
  'research', 'weather', 'cache_search',
  // human-journal（桌面工作流）
  'human_read', 'journal_read', 'journal_write', 'personality_select',
  // 工作目录切换（QQ 会话不该改 cwd）
  'working_directory',
  // 2026-10-31：dsh-video-storyboard（给视频切宫格，桌面侧用）。
  // 群聊里用不上。**故意不进 READONLY_AGENT_TOOLS**：它内部 spawn ffmpeg/ffprobe，
  // 与 L1「不能执行命令」的边界相冲，宁可让 owner 在 L2/L3 用。
  'video_probe', 'video_storyboard', 'video_zoom', 'video_locate', 'video_subtitles',
  // 2026-10-31：memu 记忆（桌面侧独立记忆库）。
  // scan-dsh-tool-names.mjs 把 memu_global_* 报成「危险语义未覆盖」：它们能读宿主的
  // 全局记忆库，而 QQ 侧自有一套 memory/note_person 体系，两套不该串。
  // 2026-11-01 收窄：只留 global_*。private_* 与 status 放回白名单（见 SAFE_PREFIXES）——
  // dsh-memu-memory 的记忆规则段结尾写着「若本会话的工具列表里没有 memu_* 工具，请忽略本段」，
  // 把整族 restrict 掉等于让她被告知"别用记忆"，记忆功能实际是关的；而 private_* 绑的是
  // 本会话自己的记忆库，不跨会话，串不到桌面内容。global_* 才是跨会话的，继续关。
  'memu_global_list', 'memu_global_recall',
  // 2026-10-31：阿里云百炼 MCP（mcp-bailian）。桌面侧做批量文本/识图用的，
  // 群聊里每一次调用都会把 QQ 内容发到阿里云 —— 既用不上，也没必要开这个出口。
  // 执行期白名单本来就拒（SAFE_PREFIXES 里没有它），这里补 restrict 是为了别占 schema。
  'mcp__bailian__bailian_chat', 'mcp__bailian__bailian_embed',
  'mcp__bailian__bailian_models', 'mcp__bailian__bailian_vision',
  // 2026-11-01 L2：dsh-univer-office。原先靠 SAFE_PREFIXES 的 'univer_' 整族放行，
  // 但那等于把写盘能力交给仿真会话（output 参数是磁盘路径），而真实会话里从没用过。
  // 名字逐个取自 ~/.dsh/profiles/desktop/node_modules/dsh-univer-office/lib 的注册点。
  'univer_api', 'univer_compile_svg', 'univer_execute', 'univer_export',
  'univer_import', 'univer_inspect', 'univer_lint', 'univer_new',
  'univer_print_pdf', 'univer_resources', 'univer_screenshot', 'univer_status',
  'univer_unit', 'univer_worktree',
]

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // 本地执行面（见上）
  ...LOCAL_EXECUTION_TOOLS,
  // 用不上但占 token 的（见上，非安全动机）—— 一并从 schema 隐藏
  ...USELESS_IN_QQ_TOOLS,
  // dsh-super-injector / 开发注入器（0.1.7-rc.2 实测注册的全局工具）
  // 说明：这些名字是**运行时**才出现的（注入即注册、卸载即消失），所以只能尽力 restrict；
  // 真正的边界是下面的执行期白名单。
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 供 test-preset-local-tools.mjs 导入并与 DSH 真实工具名对账，避免两份名单漂移。
export const RESTRICTED_TOOL_NAMES = Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS])

// 执行期白名单：不在这些范围内的工具一律拒绝。
// 前缀覆盖 DSH MCP client 暴露的命名空间工具。
// 导出给 scripts/dsh-tool-names.mjs / scan-dsh-tool-names.mjs 复用：
// 「守卫主动放行」的口径只能有一份，否则扫描器会把放行的名字误报成漏隐藏。
export const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
  // 2026-11-02：长期记忆移交 DSH 侧 dsh-memu-memory 插件（memu_private_* / memu_lexicon_* /
  // memu_global_* / memu_status，13 个全局工具）。记忆的读写边界由插件的会话↔库绑定与
  // effectiveScope 执行，工具本身不落本地盘、不执行命令。
  // 2026-11-01 L2 的收窄口径继续有效：只放行**本会话**记忆面（memu_private_ 与 memu_lexicon_）。
  // 跨会话的 memu_global_* 仍在 KNOWN_DANGEROUS_GLOBAL_TOOLS 里被 restrict 掉 ——
  // 它们能读宿主的全局记忆库，QQ 侧不该串到桌面内容；执行期白名单也不会放行它们。
  'memu_private_',
  // memu_lexicon_* —— 词典是桥删掉黑话学习之后唯一还活着的那部分（术语/群梗的查询与提交），
  // 同样是本会话范围：memu_lexicon_propose 只往当前库的候选里写，不跨会话。
  'memu_lexicon_',
  // 2026-10-28：读 B 站/抖音的插件工具面（owner 明示保留）。
  //   whale_dive_* —— 读 B 站视频/字幕/弹幕/评论、抖音热门（dsh-whale-dive），纯只读、不落盘。
  // 2026-11-01 L2：`univer_` 前缀已移除。它原本是 owner 知情下放行的，理由「在 QQ 里
  //   建/改 Office 文档」，但放行它等于给仿真会话完整的写盘能力（univer_new/univer_import/
  //   univer_export/univer_screenshot 的 output 都是磁盘路径），而配额会话里 899 次工具
  //   调用中 univer_* 一次都没用过。现在它走 KNOWN_DANGEROUS_GLOBAL_TOOLS 被 restrict 隐藏。
  //   要恢复：把 'univer_' 加回这里，并把下面 univer 那 15 个名字从名单里去掉。
  'whale_dive_',
]

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，
// todo_write 仅维护任务列表。若后续 preset 不再挂载这些工具，保留无害。
export const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
  // 2026-10-28：上下文管理面。billion-context 的 compress 此前被这里挡掉，
  // 实测她调了 4 次全被拒 —— 而她的消息历史已涨到 118,644 tokens，
  // 没有压缩工具就压不下去。这几个都是**纯模型侧**操作（不读磁盘、不执行命令）：
  //   compress/decompress       —— 压缩/还原上下文
  //   search_context            —— 压缩后按关键词找回细节
  //   acp_*                     —— 看上下文水位与缓存账（只读）
  'compress',
  'decompress',
  'search_context',
  'acp_status',
  'acp_cache',
  'acp_read_original_image',
  // 2026-11-01：记忆引擎自检（只读，报引擎/记忆库/绑定状态）。放它进来是为了
  // 她（或 owner 在群里问"你记得什么"时）能自己确认记忆到底通没通。
  'memu_status',
])

/**
 * v0.3.0：L1「本地只读 Agent」（qq-agent-readonly preset）额外放行的只读工具。
 *
 * 为什么 L1 不能只靠 DSH 的 read-only 沙箱：rc.2 文档写明 Windows 上 read-only 是 partial
 * （ACL 只限制写、硬链接/NUL 等仍有缝隙），而且沙箱拒绝写入后模型可以申请「越权重试」，
 * owner 一旦误批就真的写了。L1 直接在**工具层**不给 shell 与写文件工具 —— 与操作系统无关。
 * 这里只放行：读文件、读图片、glob/grep 检索、DSH 内置联网搜索/抓取（只读）。
 */
export const READONLY_AGENT_TOOLS = Object.freeze(['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch'])

/**
 * v0.3.0：L2/L3 运维 Agent（qq-agent-workspace / qq-agent-full）的 profile。
 * 这里只负责**拒绝**派生/编排/插件/调度类工具与凭据文件读取；pwsh 与写入是否要审批由
 * qq-approval-gate.mjs 决定（守卫只能拒绝，不能要求审批）。
 */
export const OPERATOR_DENY_TOOLS = Object.freeze([
  'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents', 'spawn_teammate',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'workflow', 'ralph', 'plugin_manager', 'load_workspace_dependencies',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  'cordis_inspect_list', 'cordis_inspect_query',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
])

export function apply(ctx, config = {}) {
  // profile：默认（不配）= QQ 群友会话的最严白名单；'readonly-agent' = L1 只读 Agent；
  // 'operator' = L2/L3 运维 Agent（只拒绝派生/编排/插件类工具与凭据读取，其余交给审批闸门）。
  const readonlyAgent = config?.profile === 'readonly-agent'
  const operator = config?.profile === 'operator'
  if (operator) {
    for (const name of OPERATOR_DENY_TOOLS) {
      try { ctx.tools.restrict({ deny: [name] }) } catch (error) { console.error(`[qq-tool-restrict] skip restrict ${name}: ${error?.message ?? error}`) }
    }
    ctx.tools.guard((exec) => {
      const name = exec?.name
      if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
      if (OPERATOR_DENY_TOOLS.includes(name) || /^dev_/.test(name)) return `工具 "${name}" 不允许在运维 Agent 中使用（派生 agent / 编排 / 插件 / 调度类）`
      if (['read', 'read_image', 'glob', 'grep', 'write', 'edit', 'str_replace_editor'].includes(name)) return protectedFileReason(exec)
      return undefined
    })
    return
  }
  const extraAllowed = new Set(readonlyAgent ? READONLY_AGENT_TOOLS : [])
  // 1) 把已知危险全局工具从 schema 隐藏（restrict 只影响继承的全局层，
  //    不会误删 preset 自己注册的 scoped 工具）。
  // 逐个 restrict：当前 DSH 版本不存在的工具名会单独抛错并跳过，
  // 不会导致整批限制失败（restrict 的 unknown 校验是整批原子性的）。
  //
  // 口径（2026-09-27 实测 web profile 的全局层）：实际存在的全局工具只有
  // `dev_*`（注入器）与三个 MCP 命名空间的工具；`read`/`pwsh`/`subagent` 这类
  // 是**各 preset 行自己注册的 scoped 工具**，在 QQ preset 里根本没挂载，
  // 因此本名单主要防的是"别的 composition 把它们注册进全局层"这种回归，
  // 以及 MCP 之外的宿主工具（plugin-guard / cordis 检查工具等）。
  // 重放式 restrict：有些工具是 preset apply() **之后**才懒加载注册的
  // （实测 dsh-ops 的 ops_bash / ops_discover_tools 在 agent.ctx.plugin 的
  // `child.inject(['tools'], ...)` 回调里才 publish；dsh-better-sidebar 的
  // sidebar_open 要等 agentOpenTools 偏好为 true）。apply() 时它们还不存在，
  // restrict 会抛 unknown 被吞掉 → 工具既没隐藏、guard 又会拒绝执行 =
  // 「看得见摸不着」，白占 schema token。所以每次 tools/change 后重放一遍。
  //
  // 已成功 restrict 过的名字记进 done，不再重复调用：restrict 每次返回一个
  // disposer，无脑重放会让中途累积一堆重复的 deny 记录。
  const restrictedOnce = new Set()
  const restrictKnown = (verbose) => {
    for (const name of KNOWN_DANGEROUS_GLOBAL_TOOLS) {
      if (extraAllowed.has(name) || restrictedOnce.has(name)) continue
      try {
        ctx.tools.restrict({ deny: [name] })
        restrictedOnce.add(name)
      } catch (error) {
        // 名字不存在时跳过；执行期白名单仍然兜底。
        // 首次 apply 时这是常态（大部分名字来自其它 preset 的 scoped 层），
        // 只在 tools/change 重放后才值得看一眼是不是真的打错了。
        if (verbose) console.error(`[qq-tool-restrict] skip restrict ${name}: ${error?.message ?? error}`)
      }
    }
  }
  restrictKnown(false)
  // 两个重放点，都是 dsh-ops 自己在用的：
  //   ① `tools/change`（dsh-ops/lib/official-tool-hiding.js:209）
  //   ② `system-prompt/assemble`（同文件 :167）—— 每个 turn 组装 schema 前必走一次，
  //      是比 events 更可靠的兜底：即使某个插件注册工具时没 emit tools/change，
  //      下一轮组装前也会被这里补上 restrict。
  try {
    ctx.on('tools/change', () => restrictKnown(true))
  } catch (error) {
    console.error(`[qq-tool-restrict] tools/change 监听注册失败：${error?.message ?? error}`)
  }
  try {
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      restrictKnown(true)
      return next()
    })
  } catch (error) {
    console.error(`[qq-tool-restrict] system-prompt/assemble 监听注册失败：${error?.message ?? error}`)
  }

  // 2) 执行期白名单：任何不在允许范围内的工具调用都会被拒绝。
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
    if (SAFE_EXACT.has(name)) return
    if (extraAllowed.has(name)) return protectedFileReason(exec)
    if (SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))) return
    if (readonlyAgent) return `工具 "${name}" 不在 L1 只读 Agent 白名单内，已拒绝（L1 只允许读文件/检索/联网只读；需要写入或执行命令请让 owner 在 QQ 私聊用 /level L2 申请提升）`
    return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`
  })
}
