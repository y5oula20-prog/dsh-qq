// QQ 会话的提示词瘦身：把「部署层写给编程 Agent 的段落」在 preset 作用域里压掉。
//
// 为什么需要它
// ------------
// 实测一次真实群聊会话（/tmp/s1.jsonl，31 轮带 schema）的 system prompt 是
// 1.5–2.2 万字，其中至少 6,000 字与「一个在 QQ 里聊天的人」毫无关系：
//
//   · `harness:identity`（order −1000）
//       "You are an AI agent powered by DeepSeek Harness." —— 这是整份提示词的第一句，
//       她每一轮睁眼先读到的是「你是个 AI agent」，第 50 个字才读到「你不是编程助手」。
//   · `dsh-ops:repository-tooling:shell` / `:file`（order 3250/3251，约 4,000 字）
//       `# Shell routing: bash → host PowerShell`、`# Repository file tools`，
//       里面逐条介绍 ops_bash / ops_read_files / ops_discover_tools 怎么用。
//       而同一份提示词的【安全规则】第 1 条写的是「你没有本地工具」——自己打自己。
//   · `dsh-ops:repository-tooling:ptc`（order 3252）、`dsh-ops:discovery-tools`（order 3253）
//       run_code / load_sdk / ops_discover_tools 的用法说明，同样用不上。
//   · `free-search:engines`（order 500，约 1,800 字）
//       advanced_search / multi_search / platform_search 全家桶的说明书；
//       QQ preset 的 tool-web 行是 `search: false, fetch: false`，
//       而检索类工具全在 qq-tool-restrict 的隐藏名单里 —— 她根本调不到。
//
// 怎么压（用官方唯一的合法办法：同名 section shadow）
// --------------------------------------------------
// `@deepseek-ai/dsh-system-prompt` 的 `section()` 文档原文：
//   "Register an ordered prompt section in the calling context's scope.
//    A scoped section shadows a global section with the same name."
// 而 `renderPrompt()` 是
//   `assembly.sections.map(...).filter(text => text.length > 0).join("\n\n")`
// 也就是说：**在 preset 作用域注册一个同名的空串 section，等于把全局那段删掉**。
//
// 为什么不用别的手段：
//   · `system-prompt/assemble` hook 改 assembly —— 官方 README 明令
//     "Do not listen to `system-prompt/assemble` to add or remove tools or text"。
//     （dsh-ops 自己只在该 hook 里做**校验**并抛错，不改文本。）
//   · 改 `~/.dsh/profiles/desktop/cordis.patch.yml` 里的 `promptPolicy: false` ——
//     那是**桌面全局**配置，会连带把我编程会话的说明书也关掉。这里要的是
//     「只对 QQ 会话生效」，所以必须落在 preset 作用域。
//   · `complete: true`（整份提示词自己写）—— 会连带丢掉 compaction、工具 SDK、
//     runtime context 等由插件动态生成的部分，等于自己维护一份提示词，放弃。
//
// 注意：这里只能 shadow **静态** section。`## MemU memory` / `## 图片、群聊与关系`
// 不是 section，是 dsh-memu-memory 用 `<memory-guide>` 消息注入的，shadow 不掉，
// 要动得去那插件的配置里关。
export const name = 'qq-prompt-trim'

export const inject = ['systemPrompt']

/**
 * 默认要压掉的 section 名（逐个核对过来源包，不是猜的）：
 *   harness:identity                    @deepseek-ai/dsh-system-prompt（order −1000）
 *   dsh-ops:repository-tooling:shell    dsh-ops/lib/index.js applyComponent('shell')
 *   dsh-ops:repository-tooling:file     dsh-ops/lib/index.js applyComponent('file')
 *   dsh-ops:repository-tooling:ptc      dsh-ops/lib/ptc/contract.js PTC_SECTION
 *   dsh-ops:discovery-tools             dsh-ops/lib/discovery/index.js
 *   free-search:engines                 dsh-free-search/lib/index.js
 *
 * 若 dsh-ops 挂了同一个 family 的第二个 owner 行，section 名会变成 `<base>:2`
 * （dsh-ops/lib/scoped-ownership.js 的 `sectionName()`）。本机 profile 只有一行，
 * 所以默认表用基名；真出现 `:2` 时把名字追加进 config.sections 即可。
 */
export const DEFAULT_TRIMMED_SECTIONS = Object.freeze([
  'harness:identity',
  'dsh-ops:repository-tooling:shell',
  'dsh-ops:repository-tooling:file',
  'dsh-ops:repository-tooling:ptc',
  'dsh-ops:discovery-tools',
  'free-search:engines',
])

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ sections?: string[], enabled?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const extra = Array.isArray(config.sections) ? config.sections.filter((n) => typeof n === 'string' && n.length > 0) : []
  const names = [...new Set([...DEFAULT_TRIMMED_SECTIONS, ...extra])]

  for (const sectionName of names) {
    ctx.effect(() => ctx.systemPrompt.section({
      // order 必须是个有限数，否则 section() 直接抛 TypeError。
      // 用 -1 让它排在所有正常段落之前：反正内容是空串，位置不影响渲染结果。
      name: sectionName,
      order: -1,
      interpolate: false,
      text: '',
    }), `qq-prompt-trim: ${sectionName}`)
  }
}
