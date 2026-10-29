// 语音识别（ASR）：把别人发来的 QQ 语音条变成文字，让模型"听懂"。
//
// 两条路，优先级从便宜到贵：
//   1. `fetch_ptt_text`：QQ 自己的语音转文字（服务器侧已经转好），零成本、零模型、中文最准。
//      实测限制：**自己发出去的**语音没有转写（retcode=100「消息中不包含语音」），只对收到的有效。
//   2. 本地 whisper：把语音条下载下来自己转。离线、可离线归档，但要多下 1.5GB 模型，
//      只在 QQ 转写拿不到时兜底。
//
// 安全边界：本模块只读语音字节并返回文本，不外发、不落盘到别处（临时文件在 os.tmpdir）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export function defaultAsrConfig(cfg) {
  const a = cfg ?? {};
  return {
    enabled: a.enabled !== false,
    engine: a.engine === 'whisper' ? 'whisper' : a.engine === 'both' ? 'both' : 'qq',
    whisperBin: String(a.whisperBin ?? '').trim(),
    whisperModel: String(a.whisperModel || 'mlx-community/whisper-large-v3-turbo'),
    whisperLanguage: String(a.whisperLanguage || 'zh'),
    timeoutMs: Number(a.timeoutMs) > 0 ? Number(a.timeoutMs) : 120000
  };
}

/**
 * QQ 服务器侧的语音转写。返回 { text, via:'qq' } 或 null。
 *
 * 为什么要重试：QQ 的转写是懒生成的。消息刚到时 fetch_ptt_text 会返回
 * `获取语音转文字结果失败`，过几秒再问就有了（实测首次失败、第二次成功）。
 * 所以这里短轮询几次，而不是一次问不到就放弃。
 */
export async function qqTranscribe({ httpUrl, accessToken, messageId, timeoutMs = 30000, attempts = 3, gapMs = 700 }) {
  if (!messageId) return null;
  const base = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  for (let i = 0; i < Math.max(1, attempts); i += 1) {
    try {
      const res = await fetch(`${base}/fetch_ptt_text`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
        },
        body: JSON.stringify({ message_id: String(messageId) }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.status === 'ok' && body.retcode === 0) {
        const text = String(body.data?.text ?? '').trim();
        if (text) return { text, via: 'qq' };
      }
    } catch {
      /* 网络抖动也不能打断消息处理，继续下一轮 */
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, gapMs));
  }
  return null;
}

/**
 * 从 record 段里把音频取到本地临时文件。
 *
 * 顺序：网关 get_record → 段里的 url（http/https）→ 段里的 path（本机可读时）。
 * 任何一步失败都返回 null，绝不抛——识别失败只应让模型看到「[语音]」，不该打断整条消息。
 */
export async function fetchRecordAudio({ httpUrl, accessToken, segment, timeoutMs = 30000 }) {
  const d = segment?.data ?? {};
  const base = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const headers = accessToken ? { authorization: `Bearer ${accessToken}` } : {};
  const tmpDir = path.join(os.tmpdir(), 'dsh-asr');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
  const stamp = crypto.randomBytes(4).toString('hex');

  const writeBuf = (buf, ext) => {
    const p = path.join(tmpDir, `rec-${stamp}${ext}`);
    fs.writeFileSync(p, buf);
    return p;
  };

  // 1) 网关的 get_record：参数在不同 NapCat 版本间有出入，逐个试。
  const fileName = d.file || d.file_name || '';
  const attempts = [
    { file: fileName, out_format: 'mp3' },
    { file: fileName, file_id: d.file_id, out_format: 'mp3' },
    { message_id: d.message_id, file: fileName, out_format: 'mp3' }
  ].filter((x) => x.file || x.message_id);
  for (const payload of attempts) {
    try {
      const res = await fetch(`${base}/get_record`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) continue;
      const out = body.data?.file ? String(body.data.file) : '';
      if (out.startsWith('base64://')) return writeBuf(Buffer.from(out.slice(9), 'base64'), '.mp3');
      if (/^https?:\/\//i.test(out)) {
        const r2 = await fetch(out, { signal: AbortSignal.timeout(timeoutMs) });
        if (r2.ok) return writeBuf(Buffer.from(await r2.arrayBuffer()), '.mp3');
      }
      if (out && fs.existsSync(out)) return out;
    } catch {}
  }

  // 2) 段里直接给了 http url
  if (/^https?:\/\//i.test(String(d.url ?? ''))) {
    try {
      const r = await fetch(d.url, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return writeBuf(Buffer.from(await r.arrayBuffer()), '.mp3');
    } catch {}
  }

  // 3) 段里给了本机路径（NapCat 与桥同机时常见；容器里通常是读不到的）
  for (const p of [d.path, d.file].filter(Boolean).map(String)) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

/** 本地 whisper 转写。bin 缺省时依次找 mlx_whisper / whisper-cpp / whisper。 */
/** 找一个能用的 ffmpeg：whisper 只吃 wav/mp3 这类常见容器，QQ 语音常是 amr/silk。 */
function resolveFfmpeg() {
  const cands = [process.env.FFMPEG_PATH, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].filter(Boolean);
  return cands.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || null;
}

/**
 * 把任意音频转成 16k 单声道 wav 再喂 whisper。
 * 为什么必须先转：QQ 语音条多数是 amr/silk，mlx_whisper 交给 ffmpeg 时对 silk 直接失败，
 * amr 也常报 "could not find codec parameters"；统一转一遍最省事，且 16k 是 whisper 的原生采样率。
 */
async function toWav16k(audioPath) {
  const ff = resolveFfmpeg();
  if (!ff) return audioPath;
  const out = path.join(os.tmpdir(), `asr-${crypto.randomBytes(4).toString('hex')}.wav`);
  try {
    await execFileP(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', audioPath, '-ac', '1', '-ar', '16000', '-f', 'wav', out], { timeout: 60000 });
    return fs.existsSync(out) && fs.statSync(out).size > 1000 ? out : audioPath;
  } catch {
    try { fs.unlinkSync(out); } catch {}
    return audioPath;
  }
}

export async function localTranscribe({ audioPath, bin, model, language = 'zh', timeoutMs = 120000 }) {
  if (!audioPath) return null;
  const cands = [
    bin,
    path.join(os.homedir(), '.local', 'bin', 'mlx_whisper'),
    '/opt/homebrew/bin/whisper-cli',
    '/opt/homebrew/bin/whisper'
  ].filter(Boolean);
  const found = cands.find((c) => {
    try { return fs.existsSync(c); } catch { return false; }
  });
  if (!found) return null;
  const wav = await toWav16k(audioPath);
  try {
    const env = { ...process.env };
    // HuggingFace 直连在本机不通，统一走镜像（已验证 hf-mirror.com 可达）
    if (!env.HF_ENDPOINT) env.HF_ENDPOINT = 'https://hf-mirror.com';
    const args = found.includes('mlx_whisper')
      ? ['--model', model, '--language', language, '--output-format', 'txt', '--output-dir', path.dirname(wav), wav]
      : ['-m', model, '-l', language, '-f', wav, '-otxt', '-of', wav.replace(/\.[^.]+$/, '')];
    await execFileP(found, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env });
    const txtPath = wav.replace(/\.[^.]+$/, '') + '.txt';
    if (!fs.existsSync(txtPath)) return null;
    const text = fs.readFileSync(txtPath, 'utf8').trim();
    try { fs.unlinkSync(txtPath); } catch {}
    return text ? { text, via: `whisper:${path.basename(found)}` } : null;
  } catch {
    return null;
  } finally {
    if (wav !== audioPath) { try { fs.unlinkSync(wav); } catch {} }
  }
}

/**
 * 统一入口：先问 QQ，再自己转。
 * 返回 { text, via } 或 null（拿不到就老实说拿不到）。
 */
export async function transcribeVoice({ httpUrl, accessToken, messageId, segment, asr }) {
  const conf = defaultAsrConfig(asr);
  if (!conf.enabled) return null;
  if (conf.engine !== 'whisper') {
    const qq = await qqTranscribe({ httpUrl, accessToken, messageId, timeoutMs: conf.timeoutMs });
    if (qq) return qq;
  }
  if (conf.engine === 'qq') return null;
  const audio = await fetchRecordAudio({ httpUrl, accessToken, segment, timeoutMs: 30000 });
  if (!audio) return null;
  try {
    return await localTranscribe({ audioPath: audio, bin: conf.whisperBin, model: conf.whisperModel, language: conf.whisperLanguage, timeoutMs: conf.timeoutMs });
  } finally {
    try { fs.unlinkSync(audio); } catch {}
  }
}
