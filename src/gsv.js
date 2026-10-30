// 音色克隆说话（GPT-SoVITS）：用一段 3–10 秒的单人参考人声，克隆出「她」的声音来说任何话。
//
// 为什么加这个：edge-tts 的晓伊 + RVC 大肥鱼是一条「公开音色」链，听起来不像小柚本人。
// GPT-SoVITS 是 zero-shot 克隆——喂 5 秒兰音Reine 的干净人声，就能用她的声线念任何文字，
// 中/日/英/韩/粤都支持，想换谁就换谁（换个参考音频文件即可，不用重训）。
//
// 服务契约（api_v2.py，本地 HTTP 网关，端口 9880）：
//   POST /tts   {text, text_lang, ref_audio_path, prompt_text, prompt_lang, media_type, streaming_mode}
//                → 200 直接吐原始音频字节（media_type 决定格式，默认 wav / 32000Hz 单声道）
//                → 400 {"message":"tts failed","Exception":"..."}
//   注意：参考音频长度必须在 3–10 秒，超出会 400（"Reference audio is outside the 3-10 second range"）。
//   注意：返回不是 JSON，是音频本体；非流式模式一次吐完。
//
// 安全边界：本模块只负责「文字 + 参考音频 → 语音库里的一个文件」，不决定发给谁。
// 发送与限流都在 bridge.js 的 sendVoiceV2 / sendVoiceForV2。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function defaultGsvConfig(cfg) {
  const g = cfg ?? {};
  return {
    enabled: g.enabled === true,
    apiUrl: String(g.apiUrl || 'http://127.0.0.1:9880').replace(/\/+$/, ''),
    // 参考音频：克隆谁的声音。3–10 秒单人干净人声，绝对路径。
    refAudioPath: String(g.refAudioPath || ''),
    // 参考音频对应的文字（可选；给对了能提升相似度，不给也能出声）。
    promptText: String(g.promptText || ''),
    promptLang: String(g.promptLang || 'zh'),
    textLang: String(g.textLang || 'zh'),
    mediaType: String(g.mediaType || 'wav'),
    timeoutMs: Number(g.timeoutMs) > 0 ? Number(g.timeoutMs) : 120000,
    // 说话要不要走克隆音色。关掉就退回 edge-tts + RVC 那条链。
    speech: g.speech !== false,
    // 响度归一：GPT-SoVITS 原始输出偏响（实测 -16 LUFS），QQ 语音条听着炸。
    // 填 0 / false 关闭；默认 -19 LUFS（语音条舒服区间）。
    loudnessLufs: Number(g.loudnessLufs) === 0 || g.loudnessLufs === false
      ? 0
      : (Number(g.loudnessLufs) || -19)
  };
}

/** 服务活着吗？用 /openapi.json 探（FastAPI 自带，不触发合成）。 */
export async function gsvHealth({ apiUrl, timeoutMs = 5000 } = {}) {
  try {
    const res = await fetch(`${apiUrl}/openapi.json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => ({}));
    return { ok: !!body?.openapi, detail: body?.info ?? {} };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 用克隆音色说一段话，落盘到 outDir，返回 {path, bytes, reused}。
 * 按「参考音频 + prompt_text + 文本」做 sha1 缓存，同一句不重复合成。
 */
export async function gsvSpeak({
  apiUrl,
  text,
  refAudioPath,
  promptText = '',
  promptLang = 'zh',
  textLang = 'zh',
  mediaType = 'wav',
  outDir,
  timeoutMs = 120000,
  loudnessLufs = 0
} = {}) {
  if (!outDir) throw new Error('缺少 outDir（语音库目录）');
  if (!refAudioPath) throw new Error('缺少 refAudioPath（参考音频，3–10 秒单人声）');
  fs.mkdirSync(outDir, { recursive: true });

  const hash = crypto.createHash('sha1')
    .update(`${refAudioPath}|${promptText}|${textLang}|${text}|lu:${loudnessLufs}`)
    .digest('hex').slice(0, 10);
  const outPath = path.join(outDir, `gsv-${hash}.wav`);
  try {
    const st = fs.statSync(outPath);
    if (st.size > 1024) return { path: outPath, bytes: st.size, reused: true };
  } catch {}

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiUrl}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        text_lang: textLang,
        ref_audio_path: refAudioPath,
        prompt_text: promptText,
        prompt_lang: promptLang,
        media_type: mediaType,
        streaming_mode: false
      }),
      signal: ctrl.signal
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`GPT-SoVITS 合成失败（HTTP ${res.status}）：${err?.Exception || err?.message || ''}`.slice(0, 300));
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('GPT-SoVITS 返回了空音频');
    fs.writeFileSync(outPath, buf);

    // 响度归一：GPT-SoVITS 原始输出实测 -16 LUFS / 峰值 -1.5dB，发到 QQ 听着炸。
    // 用 ffmpeg loudnorm 拉到目标 LUFS（默认 -19），失败就照发原音，不让整条语音作废。
    if (loudnessLufs) {
      try {
        const normed = await normalizeLoudness(outPath, loudnessLufs);
        if (normed) return { path: outPath, bytes: normed, reused: false, normalized: true };
      } catch {}
    }
    return { path: outPath, bytes: fs.statSync(outPath).size, reused: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把音频响度拉到 targetLufs（原地覆盖）。失败返回 null，调用方照发原音。
 * QQ 语音条舒服区间约 -19 ~ -20 LUFS；GPT-SoVITS 原始输出约 -16 LUFS 明显偏响。
 */
async function normalizeLoudness(filePath, targetLufs) {
  const { spawnSync } = await import('node:child_process');
  const ffmpeg = process.env.FFMPEG_PATH ||
    ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
      .find((p) => { try { return fs.existsSync(p); } catch { return false; } }) ||
    'ffmpeg';

  // 两遍 loudnorm：第一遍只测量，第二遍用 measured_* 精确对齐。
  // 单遍模式实测只能从 -16.1 拉到 -17.8（目标 -19），差 1.2 LUFS 不够。
  const probe = spawnSync(ffmpeg, [
    '-hide_banner', '-i', filePath,
    '-af', `loudnorm=I=${targetLufs}:TP=-2.0:LRA=11:print_format=json`,
    '-f', 'null', '-'
  ], { encoding: 'utf8', timeout: 60000 });
  const raw = `${probe.stderr || ''}`;
  const m = raw.lastIndexOf('{');
  const j = m >= 0 ? raw.slice(m, raw.lastIndexOf('}') + 1) : '';
  let measured = null;
  try { measured = JSON.parse(j); } catch {}
  if (!measured || !measured.input_i) return null;

  const tmp = `${filePath}.norm.wav`;
  const r = spawnSync(ffmpeg, [
    '-v', 'error', '-y', '-i', filePath,
    '-af', [
      `loudnorm=I=${targetLufs}:TP=-2.0:LRA=11`,
      `measured_I=${measured.input_i}`,
      `measured_TP=${measured.input_tp}`,
      `measured_LRA=${measured.input_lra}`,
      `measured_thresh=${measured.input_thresh}`,
      `offset=${measured.target_offset}`,
      'linear=true'
    ].join(':'),
    '-ar', '32000', '-ac', '1', tmp
  ], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0 || r.error) {
    try { fs.unlinkSync(tmp); } catch {}
    return null;
  }
  const size = fs.statSync(tmp).size;
  if (size < 1024) { try { fs.unlinkSync(tmp); } catch {} return null; }
  fs.renameSync(tmp, filePath);
  return size;
}
