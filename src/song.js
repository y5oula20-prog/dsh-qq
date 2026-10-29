// 唱歌：调用本地 ACE-Step 1.5 服务（http://127.0.0.1:8001），把「歌词 + 风格」变成一首歌。
//
// 为什么走 ACE-Step 而不是继续拿 TTS 拼音符：
//   edge-tts 那套「测 f0 → 按谱面搬音高」实测能做到逐音 ±0.3 半音（sing2），
//   但 asetrate 会把共振峰一起搬，高音区明显发尖；换神经 TTS 的 --pitch 又因为
//   单字韵律在动，偏差反而放大到 ±6.5 半音。要"唱得像人"，得用真正的歌声模型。
//
// ACE-Step 1.5 的 API 契约（读自 acestep/api/http/*.py）：
//   POST /release_task   {prompt, lyrics, vocal_language, inference_steps, audio_duration, ...}
//                        → {code, data:{task_id, status:'queued'}}
//   POST /query_result   {task_id_list: '["id"]'}
//                        → {data:[{task_id, status:0排队/1运行/2完成, result:'[{"file":"..."}]'}]}
//   GET  /v1/audio?path=<file>
//
// 安全边界：本模块只管合成与落盘，不负责发给谁（发送走 bridge 的语音通道）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function defaultSongConfig(cfg) {
  const s = cfg ?? {};
  return {
    enabled: s.enabled !== false,
    apiUrl: String(s.apiUrl || 'http://127.0.0.1:8001').replace(/\/+$/, ''),
    apiKey: String(s.apiKey ?? ''),
    outDir: String(s.outDir || ''),
    model: String(s.model || 'acestep-v15-turbo'),
    lmModel: String(s.lmModel || 'acestep-5Hz-lm-1.7B'),
    // turbo 模型 8 步就够；步数越多越慢，边际收益很小
    steps: Number(s.steps) > 0 ? Number(s.steps) : 8,
    durationSec: Number(s.durationSec) > 0 ? Number(s.durationSec) : 30,
    maxDurationSec: Number(s.maxDurationSec) > 0 ? Number(s.maxDurationSec) : 180,
    // 默认风格：小柚的声音——清亮少女、钢琴/木吉他、海边的感觉
    style: String(s.style || 'female vocal, cute young girl voice, soft and gentle, anime style, acoustic pop, warm, ocean breeze, solo female singer, clear vocal'),
    vocalLanguage: String(s.vocalLanguage || 'zh'),
    // thinking=true 是「有没有人声」的开关，别关
    thinking: s.thinking !== false,
    guidanceScale: Number(s.guidanceScale) > 0 ? Number(s.guidanceScale) : 7,
    timeoutMs: Number(s.timeoutMs) > 0 ? Number(s.timeoutMs) : 900000,
    pollMs: Number(s.pollMs) > 0 ? Number(s.pollMs) : 4000
  };
}

function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/** 服务活着吗？活着顺便报一下已经加载了哪个模型。 */
export async function aceStepHealth({ apiUrl, apiKey = '', timeoutMs = 5000 } = {}) {
  try {
    const res = await fetch(`${apiUrl}/health`, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => ({}));
    return { ok: true, detail: body?.data ?? body };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** 提交一首歌。返回 task_id。 */
export async function submitSong({ apiUrl, apiKey = '', lyrics, style, durationSec = 30, steps = 8, model = '', lmModel = '', vocalLanguage = 'zh', bpm = null, keyScale = '', referenceAudioPath = null, thinking = true, guidanceScale = 7, timeoutMs = 60000 } = {}) {
  const payload = {
    prompt: String(style || '').trim(),
    lyrics: String(lyrics || '').trim(),
    // thinking=true 才会走 5Hz LM 生成 audio codes 给 DiT 当条件——这是「有没有人声」的开关。
    // 实测：false 时 30 秒全是器乐（whisper 转写是幻觉）；true 时真唱出中文歌词。
    thinking: thinking !== false,
    sample_mode: false,
    use_format: false,
    model: model || undefined,
    bpm: bpm || undefined,
    key_scale: keyScale || undefined,
    vocal_language: vocalLanguage,
    inference_steps: steps,
    guidance_scale: guidanceScale,
    audio_duration: durationSec,
    audio_format: 'mp3',
    use_random_seed: true,
    task_type: 'text2music',
    lm_model_path: lmModel || undefined,
    lm_backend: 'mlx',
    // 我们自带歌词与元信息，不让 LM 再去改写 caption/语言（那是 thinking 之外的另一个开关，
    // 开了反而可能把中文改写走样）
    use_cot_caption: false,
    use_cot_language: false,
    use_cot_metas: false,
    is_format_caption: false
  };
  if (referenceAudioPath) {
    // 注意：task_type 没有 'reference' 这个值（合法值是 text2music / cover / repaint /
    // extract / complete / lego）。参考音色靠 reference_audio_path 字段本身生效，
    // 不要为了这个去改 task_type——之前写成 'reference' 直接 400。
    payload.reference_audio_path = referenceAudioPath;
  }
  const res = await fetch(`${apiUrl}/release_task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await res.json().catch(() => ({}));
  const taskId = body?.data?.task_id;
  if (!res.ok || !taskId) {
    throw new Error(`ACE-Step 提交失败：${body?.msg || body?.message || body?.detail || `HTTP ${res.status}`}`);
  }
  return { taskId, raw: body?.data };
}

/** 轮询直到完成，返回服务器上的音频文件路径。 */
export async function waitSong({ apiUrl, apiKey = '', taskId, timeoutMs = 900000, pollMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const res = await fetch(`${apiUrl}/query_result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({ task_id_list: JSON.stringify([taskId]) }),
      signal: AbortSignal.timeout(30000)
    });
    const body = await res.json().catch(() => ({}));
    const item = Array.isArray(body?.data) ? body.data[0] : null;
    if (!item) continue;
    lastStatus = item.status;
    // 注意：完成态**不一定**带 item.status。实测 /query_result 在跑完后直接返回
    //   {task_id, result: '[{"file": "/v1/audio?path=...", ...}]'}
    // 没有顶层 status；所以判断依据是「result 里有没有 file」，status 只当辅助信号。
    let parsed = [];
    try { parsed = typeof item.result === 'string' ? JSON.parse(item.result) : item.result; } catch {}
    const hit = Array.isArray(parsed) ? parsed.find((p) => p?.file) : null;
    if (hit) return { file: hit.file, metas: hit.metas ?? null, raw: hit };
    if (Number(item.status) === 2) throw new Error('ACE-Step 跑完了但没有返回音频文件');
  }
  throw new Error(`ACE-Step 出歌超时（最后状态 ${lastStatus ?? '?'}；模型可能在加载或机器忙）`);
}

/** 把服务器上的音频拉回本地。 */
export async function fetchSongAudio({ apiUrl, apiKey = '', file, outDir, timeoutMs = 120000 } = {}) {
  // file 可能是三种形态：相对 URL（/v1/audio?path=%2F...）、完整 URL、纯文件路径
  let src;
  if (/^https?:\/\//i.test(file)) src = file;
  else if (file.startsWith('/v1/audio')) src = `${apiUrl}${file}`;
  else src = `${apiUrl}/v1/audio?${new URLSearchParams({ path: file }).toString()}`;
  const res = await fetch(src, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`下载歌曲失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error('下载回来的音频太小，可能是错误页');
  fs.mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, `song-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.mp3`);
  fs.writeFileSync(dest, buf);
  return { path: dest, bytes: buf.length };
}

/** 一把梭：提交 → 等 → 下载。 */
export async function singWithAceStep({ apiUrl, apiKey = '', lyrics, style, durationSec, steps, model, lmModel, vocalLanguage, outDir, referenceAudioPath = null, thinking = true, guidanceScale = 7, timeoutMs = 900000, pollMs = 4000 } = {}) {
  const health = await aceStepHealth({ apiUrl, apiKey });
  if (!health.ok) throw new Error(`ACE-Step 服务没起来（${apiUrl}）：${health.error}。先跑 scripts/start-acestep.sh --bg`);
  // LLM 没加载时 thinking=true 会退化成纯 DiT，人声就没保障了，这里直接报清楚
  if (thinking !== false && health.detail && health.detail.llm_initialized === false) {
    throw new Error('ACE-Step 的 5Hz LM 没加载（llm_initialized:false），这样出的歌基本没人声。重启服务时设 ACESTEP_INIT_LLM=true + ACESTEP_LM_MODEL_PATH=acestep-5Hz-lm-1.7B');
  }
  const t0 = Date.now();
  const { taskId } = await submitSong({ apiUrl, apiKey, lyrics, style, durationSec, steps, model, lmModel, vocalLanguage, referenceAudioPath, thinking, guidanceScale });
  const waited = await waitSong({ apiUrl, apiKey, taskId, timeoutMs, pollMs });
  const saved = await fetchSongAudio({ apiUrl, apiKey, file: waited.file, outDir });
  return { ...saved, taskId, ms: Date.now() - t0 };
}

/**
 * 歌词规范化：ACE-Step 认 [verse]/[chorus]/[bridge] 这类段标，
 * 中文歌词直接给也能唱，但带段标更稳（它据此分配段落与气口）。
 */
export function normalizeLyrics(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  if (/\[(verse|chorus|bridge|intro|outro)\]/i.test(raw)) return raw;
  // 没有段标：按行切成 verse / chorus，四句一段
  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  lines.forEach((line, i) => {
    if (i % 4 === 0) out.push(i === 0 ? '[verse]' : '[chorus]');
    out.push(line);
  });
  return out.join('\n');
}
