// 沉淀输出解析 —— 在原有「梗：/近：」两段之外，扩展出可入库的长期事实。
//
// 兼容原则：模型不按新格式输出时，行为与改造前完全一致（梗/近 照旧写 group-memory.md，
// facts 为空数组）；旧格式的无前缀行仍然全归「最近发生过」。这样即使换模型、提示词漂移，
// 也不会比现在更差。

import { sanitizeMemoryLine } from '../group-memory.js';

/** 单条事实最长字数：长句进库会挤占召回预算 */
export const MAX_FACT_CHARS = 120;

/**
 * 解析沉淀输出为三组：
 * - gags    「梗：」群内黑话/玩笑（写 group-memory.md 的常出现的梗）
 * - recent  「近：」最近发生过（写 group-memory.md 的最近发生过）
 * - facts   「记：」「人：」值得长期记住的事实（写 SQLite 记忆库）
 *
 * 「人：名字 | 内容」用于标注是谁的事；「记：内容」是群级事实。
 */
export function parseStructuredDistill(summary) {
  const gags = [];
  const recent = [];
  const facts = [];

  for (const raw of String(summary ?? '').split('\n')) {
    const line = sanitizeMemoryLine(raw);
    if (!line) continue;

    const gag = /^梗[：:]\s*(.+)$/.exec(line);
    const near = /^(?:近|最近)[：:]\s*(.+)$/.exec(line);
    const person = /^人[：:]\s*([^|｜:：]{1,24})\s*[|｜:：]\s*(.+)$/.exec(line);
    const fact = /^记[：:]\s*(.+)$/.exec(line);

    if (gag) {
      gags.push(gag[1].trim());
    } else if (near) {
      recent.push(near[1].trim());
    } else if (person) {
      const content = person[2].trim();
      if (content.length >= 2) {
        facts.push({ speaker: person[1].trim(), content: content.slice(0, MAX_FACT_CHARS) });
      }
    } else if (fact) {
      const content = fact[1].trim();
      if (content.length >= 2) {
        facts.push({ speaker: '', content: content.slice(0, MAX_FACT_CHARS) });
      }
    } else if (/^梗/.test(line) || /^(?:近|最近|人|记)/.test(line)) {
      // 「梗」「近」「人」「记」后面没内容：模型输出的空壳行，丢掉
      continue;
    } else {
      recent.push(line);
    }
  }

  return {
    gags: [...new Set(gags.filter((l) => l.length >= 2))].slice(0, 10),
    recent: [...new Set(recent.filter((l) => l.length >= 2))].slice(0, 8),
    facts: dedupeFacts(facts).slice(0, 8),
  };
}

function dedupeFacts(facts) {
  const seen = new Set();
  const out = [];
  for (const f of facts) {
    const key = `${f.speaker}|${f.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/** 沉淀提示词：在原有两段要求上追加「记：」「人：」，并明确它们的用途边界 */
export function buildStructuredDistillSection() {
  return [
    '另外还有两种行（只在真的有长期价值时才写，没有就不写）：',
    '「记：」= 这个群以后还会用到的事实（约定、习惯、发生过的重要事），一行一件，不超过 60 字',
    '「人：名字 | 」= 关于某个具体成员的事（喜好、称呼、约定），名字写群里怎么叫他',
    '「记：」「人：」只写以后聊天可能用得上的；临时话题、寒暄、玩笑不要写。',
  ].join('\n');
}
