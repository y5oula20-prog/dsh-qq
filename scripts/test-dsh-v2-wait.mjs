// 二代等待逻辑的「实时」端到端测试：真建一个 qq-chat-v2 会话并向 DSH 提问，
// 断言 qq_wait_for_messages 出现在该 preset 的可用工具面里。需要 DSH 正在运行。
// （纯逻辑单测见 scripts/test-v2-wait.mjs，两者不重复。）
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from '../src/dsh-client.js';
import { resolveDshBaseUrl } from '../src/lib/dsh-endpoint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function main() {
  let auth;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    auth = {
      token: cfg.dsh?.authToken || discoverDshLaunchToken(),
      header: cfg.dsh?.authHeader,
      prefix: cfg.dsh?.authPrefix
    };
  } catch {}
  // 桌面版 0.2.1 起端口是随机回环号（这台机器 51000/51001/51002），不能写死 3080。
  const baseUrl = process.env.DSH_BASE_URL || (await resolveDshBaseUrl(undefined)).url;
  const api = new NodeApiClient(baseUrl, undefined, auth);
  // 探测会话的 cwd 用系统临时目录：state/ 的 ACL 被 harden-state-acl.mjs 收紧过，
  // 沙箱里写不进去（见 scripts/probe-auth.mjs 的同款说明）。
  const cwd = path.join(os.tmpdir(), 'qq-bridge-self-test-v2-wait');
  fs.mkdirSync(cwd, { recursive: true });
  const created = unwrap(await api.sessions.create({ cwd, agentPreset: 'qq-chat-v2' }), 'session.create');
  const sessionId = created.sessionId;
  console.log('SESSION_CREATED', sessionId);

  const stream = api.events.mux({});
  const collector = createTurnCollector();
  // 竞态：follow 流从「登记期望」到 DSH 真正打开单会话流之间有几十毫秒，
  // 而 prompt 是紧接着发的 —— turn/start 可能落在这个空档里，只出现在开场快照的
  // records 里，live 通道第一次见到的就是 turn/end。此时 collector 没有该回合，
  // push() 返回 null，脚本会一路等到 120s 超时（历史上就是这么偶发失败的）。
  // 修法：照抄桥接 rebuildInFlightCollector 的口径 —— 只回放「有 start 无 end」
  // 的回合，已结束的历史回合一律不喂，否则会拿旧文本当成这一轮的结果。
  const seedFromSnapshot = (snapshot) => {
    const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
    if (!records.length) return 0;
    const eventOf = (entry) => (entry?.type === 'event' ? entry.event : entry);
    const open = new Set();
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type === 'turn/start') open.add(event.data?.turn);
      else if (event?.type === 'turn/end') open.delete(event.data?.turn);
    }
    let restored = 0;
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type !== 'turn/start' && event?.type !== 'assistant/message') continue;
      if (!open.has(event.data?.turn)) continue;
      collector.push(event);
      restored += 1;
    }
    if (restored) console.log('SEEDED_FROM_SNAPSHOT', restored);
    return restored;
  };
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待回复超时（120s）')), 120_000);
    (async () => {
      for await (const envelope of stream) {
        const frame = envelope.payload;
        if (frame.type === 'session/snapshot' && frame.sessionId === sessionId) {
          seedFromSnapshot(frame.snapshot);
        }
        if (frame.type === 'session/event' && frame.sessionId === sessionId) {
          const ended = collector.push(frame.event);
          if (ended) {
            clearTimeout(timer);
            resolve(ended);
            return;
          }
        }
        if (frame.type === 'stream/error') {
          clearTimeout(timer);
          reject(new Error('事件流错误: ' + JSON.stringify(frame.error)));
          return;
        }
      }
    })().catch((error) => { clearTimeout(timer); reject(error); });
  });

  stream.follow(sessionId);
  const accepted = unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: '请只输出你当前可用的工具名列表（JSON 数组），不要调用任何工具，不要发送消息。只输出 JSON。' }] }), 'session.prompt');
  console.log('PROMPT_ACCEPTED', JSON.stringify(accepted).slice(0, 120));
  const ended = await done;
  const text = ended.text || '';
  console.log('TOOLS_TEXT_START');
  console.log(text.slice(0, 3000));
  console.log('TOOLS_TEXT_END');
  const hasWait = text.includes('qq_wait_for_messages');
  console.log('HAS_qq_wait_for_messages=' + hasWait);
  console.log('RESULT=' + (hasWait ? 'WAIT_TOOL_VISIBLE' : 'CHECK_FAILED'));
}

main().catch((e) => { console.error(e); process.exit(1); });
