// 任务播报（P1/P2，2026-11-04 方案拍板）：把小柚在 DSH 里的工作动向以「状态卡」发到测试群，
// 并支持 owner 在群里远程拍板（回复审批 / 回答提问，路由回发起会话）。
//
// 设计（方案稿《小柚功能升级-整合方案》§6.3）：
// - 只读播报：桥接只观察自己已有的 DSH 事件流（turn/tool/question/approval），不新增任何对 DSH 的控制。
// - 事件驱动 + 心跳兜底，不每步刷屏：开工不单独发卡；状态卡在「回合结束 / 等你拍板」时发，
//   长任务期间每 heartbeatMinutes 发一条心跳。纯聊天回合（没有任何工具调用）不播报。
// - 数据源就是小柚自己的会话事件（bridge.js 的 pumpMux 里挂钩子），默认只看 owner 私聊会话
//   （cfg.taskBroadcast.sessions = ["owner"]），群友模式聊天不受影响。
// - 群内确认走白名单语义：只认「确认群里、发送者 = ownerQQ」的真实消息；审批仍走编号登记表
//   （复用 createApprovalRegistry，模型无法伪造），提问答案路由回发起会话的挂起条目。
// - 失败处理：拿不到状态/发不出去只写日志，绝不盲动；确认超时沿用登记表原有超时（自动拒绝/等你）。

const DEFAULTS = Object.freeze({
  enabled: true,
  groups: [],            // 播报群（QQ 号字符串）；空 = 不播报
  confirmGroups: [],     // 可远程拍板的群；空 = 不启用群内确认
  sessions: ['owner'],   // 播报哪些会话：'owner' = owner 私聊；也可写 'group:xxx' / 'private:xxx'
  heartbeatMinutes: 10,  // 心跳兜底间隔（5–10 分钟档）
  maxChars: 400,         // 单张卡片正文上限
  textChars: 220,        // 其中「结果/问题摘要」的截断长度
});

const TWO_LINE = '\n';

function clampNum(v, min, max, d) {
  return Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : d;
}

function asQQList(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x ?? '').trim()).filter((s) => /^[1-9]\d{0,11}$/.test(s)))];
}

/** 归一化 cfg.taskBroadcast；sessions 里的 'owner' 由调用方传入 ownerQQ 解析成具体 key。 */
export function normalizeTaskBroadcastConfig(raw, { ownerQQ = '' } = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const ownerKey = /^[1-9]\d{0,11}$/.test(String(ownerQQ ?? '')) ? `private:${String(ownerQQ)}` : null;
  const sessions = [...new Set((Array.isArray(c.sessions) ? c.sessions : DEFAULTS.sessions)
    .map((s) => {
      const t = String(s ?? '').trim();
      if (t === 'owner') return ownerKey;
      return /^(group|private):[1-9]\d{0,11}$/.test(t) ? t : null;
    })
    .filter(Boolean))];
  return {
    enabled: c.enabled !== false,
    groups: asQQList(c.groups),
    confirmGroups: asQQList(c.confirmGroups),
    sessions,
    heartbeatMinutes: clampNum(c.heartbeatMinutes, 1, 120, DEFAULTS.heartbeatMinutes),
    maxChars: clampNum(c.maxChars, 120, 2000, DEFAULTS.maxChars),
    textChars: clampNum(c.textChars, 60, 1000, DEFAULTS.textChars),
  };
}

function two(n) { return String(n).padStart(2, '0'); }
function hhmm(t) { const d = new Date(t); return `${two(d.getHours())}:${two(d.getMinutes())}`; }

function truncate(s, n) {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

/**
 * @param {object} deps
 * @param {object} deps.cfg          桥接内存配置（读 cfg.taskBroadcast；热更新时同一引用，每次取值都重读）
 * @param {(...a:any[])=>void} deps.log
 * @param {() => number} [deps.now]
 * @param {(text:string)=>Promise<void>} deps.notifyGroup  bridge 提供：把卡片发到所有播报群（管理通道语义，绕过模式/白名单）
 */
export function createTaskBroadcast({ cfg, log, now = Date.now, notifyGroup }) {
  const conf = () => normalizeTaskBroadcastConfig(cfg?.taskBroadcast, { ownerQQ: cfg?.ownerQQ });
  const enabled = () => conf().enabled && conf().groups.length > 0 && !!notifyGroup;

  // 会话动向：key -> { sinceTs, tools: Map<name,count>, lastToolAt, awaiting, lastCardAt, lastTurnText }
  const watched = new Map();

  function watchedKey(key) {
    return conf().sessions.includes(String(key));
  }
  function session(key) {
    let s = watched.get(key);
    if (!s) { s = { sinceTs: 0, tools: new Map(), lastToolAt: 0, awaiting: null, lastCardAt: 0 }; watched.set(key, s); }
    return s;
  }

  async function post(text) {
    try { await notifyGroup(text); } catch (error) { log(`任务播报发送失败：${error?.message ?? error}`); }
  }

  /** 回合结束后的状态卡。只有「动过工具」或「被中止」的回合才发：纯聊天回合（哪怕有文本）不播报，避免把私聊闲聊刷进群。 */
  function renderTurnEndCard(key, s, { text, reasonKind }) {
    const toolLine = [...s.tools.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join('、');
    if (!toolLine && reasonKind !== 'aborted') return null;
    const head = `📋 小柚状态卡 · ${hhmm(now())}`;
    const lines = [head];
    if (toolLine) lines.push(`干了啥：${toolLine}`);
    if (reasonKind === 'aborted') lines.push('为啥停：回合被中止');
    if (text && String(text).trim()) lines.push(`结果：${truncate(text, conf().textChars)}`);
    return lines.join(TWO_LINE);
  }

  return {
    /** 播报来源会话 keys（供群内确认路由）。 */
    sourceKeys: () => conf().sessions,
    /** 播报群列表（bridge 的 notifyGroup 按它逐群发送）。 */
    groups: () => conf().groups,
    /** 群内确认白名单判断（供消息入口快速拦截）。 */
    isConfirmGroup: (groupId) => conf().enabled && conf().confirmGroups.includes(String(groupId)),

    onTurnStart(key, sessionId) {
      if (!enabled() || !watchedKey(key)) return;
      const s = session(key);
      s.sinceTs = now();
      s.tools = new Map();
      s.lastToolAt = 0;
      s.awaiting = null;
    },

    onToolCall(key, toolName) {
      if (!enabled() || !watchedKey(key)) return;
      const s = session(key);
      const n = String(toolName ?? '').trim() || 'tool';
      s.tools.set(n, (s.tools.get(n) ?? 0) + 1);
      s.lastToolAt = now();
      if (!s.sinceTs) s.sinceTs = s.lastToolAt;
    },

    /** 等你拍板（审批/提问）：立即发卡，等的事一变（新回合开始）自动清除。 */
    async onAwaitingInput(key, kind, summaryText) {
      if (!enabled() || !watchedKey(key)) return;
      const s = session(key);
      s.awaiting = { kind, at: now() };
      s.lastCardAt = now();
      const title = kind === 'approval' ? '🔐 等你审批' : '❓ 等你拍板';
      const body = truncate(summaryText, conf().maxChars);
      await post(`⏸ 小柚等你拍板 · ${hhmm(now())}${TWO_LINE}${title}${body ? `${TWO_LINE}${body}` : ''}${TWO_LINE}（可直接在本群回复）`);
    },

    async onTurnEnd(key, { text, reasonKind } = {}) {
      if (!enabled() || !watchedKey(key)) return;
      const s = session(key);
      const awaiting = s.awaiting;
      s.awaiting = null;
      s.sinceTs = 0;
      const card = renderTurnEndCard(key, s, { text, reasonKind });
      s.tools = new Map();
      s.lastToolAt = 0;
      // 等拍板卡刚发过（还没人回）回合就结束了：信息重复，不补卡。其余状态卡每回合最多一张，不再节流。
      if (!card || awaiting) return;
      s.lastCardAt = now();
      await post(card);
    },

    /** 心跳兜底：每分钟 tick 一次；只在「还在跑 / 还在等」超过心跳间隔时发一条。 */
    tick() {
      if (!enabled()) return;
      const t = now();
      for (const [key, s] of watched) {
        if (!watchedKey(key)) continue;
        const heartbeatMs = conf().heartbeatMinutes * 60_000;
        if (s.awaiting) {
          if (t - s.lastCardAt < heartbeatMs) continue;
          s.lastCardAt = t;
          const waitedMin = Math.round((t - s.awaiting.at) / 60_000);
          void post(`💓 还在等你 · ${hhmm(t)}${TWO_LINE}${s.awaiting.kind === 'approval' ? '审批' : '提问'}已等 ${waitedMin} 分钟，确认超时会自动处理；也可以直接在本群回复。`);
        } else if (s.sinceTs && (s.tools.size > 0 || t - s.sinceTs > heartbeatMs)) {
          if (t - s.lastCardAt < heartbeatMs) continue;
          s.lastCardAt = t;
          const toolLine = s.lastToolAt ? `最近动作：${[...s.tools.keys()].slice(-3).join('、')}（${Math.round((t - s.lastToolAt) / 60_000)} 分钟前）` : '';
          void post(`💓 小柚还在跑 · ${hhmm(t)}${toolLine ? `${TWO_LINE}${toolLine}` : ''}${TWO_LINE}开始于 ${hhmm(s.sinceTs)}`);
        }
      }
    },

    /** 桥启动后的第一张卡（每次进程只发一次，由 bridge 在 QQ 首次连上后调用）。 */
    async announceStartup() {
      if (!enabled()) return;
      await post(`🟢 小柚任务播报已开启 · ${hhmm(now())}${TWO_LINE}之后她在被监视会话（默认 owner 私聊）里的工作动向会发到这里；需要拍板时可直接在本群回复。`);
    },

    /** 停止心跳定时器（测试用）。 */
    stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } },

    /** 内部状态快照（测试用）。 */
    _debug() {
      return { conf: conf(), watched: [...watched.entries()].map(([k, s]) => ({ key: k, ...s, tools: [...s.tools.entries()] })) };
    },
  };
}

/** 桥接线缆：创建实例并启动每分钟的心跳 tick。 */
export function startTaskBroadcast(deps) {
  const tb = createTaskBroadcast(deps);
  tb._timer = setInterval(() => { try { tb.tick(); } catch (error) { deps.log?.(`任务播报心跳出错：${error?.message ?? error}`); } }, 60_000);
  tb._timer.unref?.();
  return tb;
}
