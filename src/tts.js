// 语音合成（TTS）：把一段文字变成可以当语音条发出去的 mp3。
//
// 为什么要单独一个模块：`bridge.js` 已经 1.3 万行，TTS 是一段边界清楚、
// 可以单测的能力（文字 → 文件路径），塞进去只会更难维护。
//
// 引擎选择（2026-10 实测，macOS）：
//   - edge-tts：微软 Edge 的在线神经语音，免费、无需 key、中文自然度明显高于 macOS `say`。
//     本机实测 6.1 秒中文音频约 1.6 秒合成完。唯一的代价是**要联网**。
//   - macOS `say`：完全离线，但 `Tingting` 之类的声音机器感重，只当兜底。
//
// 安全边界：本模块只负责「文字 → 语音库里的一个 mp3 文件」，不决定发给谁。
// 发送仍然走 bridge.js 的 sendVoiceV2 / sendVoiceForV2，限流与守卫都在那边。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// 中文常用音色：给模型看的枚举，避免它瞎猜带歪整段语音。
export const TTS_VOICE_PRESETS = [
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', tone: '活泼少女（默认，最贴小柚）', gender: 'female' },
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', tone: '温柔知性', gender: 'female' },
  { id: 'zh-CN-XiaomoNeural', name: '晓墨', tone: '沉稳（可演儿童/少年）', gender: 'female' },
  { id: 'zh-CN-XiaohanNeural', name: '晓涵', tone: '温柔', gender: 'female' },
  { id: 'zh-CN-XiaoshuangNeural', name: '晓双', tone: '童声', gender: 'female' },
  { id: 'zh-CN-YunxiNeural', name: '云希', tone: '少年（男）', gender: 'male' },
  { id: 'zh-CN-YunjianNeural', name: '云健', tone: '男声', gender: 'male' }
];

const VOICE_ID_RE = /^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9]+Neural$/;

/** 找 edge-tts 可执行文件：配置 > 常见安装位置 > PATH。 */
export function resolveEdgeTtsBin(configured) {
  const fromCfg = String(configured ?? '').trim();
  if (fromCfg) {
    if (fs.existsSync(fromCfg)) return fromCfg;
    throw new Error(`tts.bin 指向的 edge-tts 不存在：${fromCfg}`);
  }
  const cands = [
    path.join(os.homedir(), '.local', 'bin', 'edge-tts'),
    '/opt/homebrew/bin/edge-tts',
    '/usr/local/bin/edge-tts'
  ];
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  // 最后交给 PATH 解析（execFile 会自己找），返回裸名字
  return 'edge-tts';
}

/** 把数字/字符串统一成 edge-tts 要的 `+10%` / `-5Hz` 形式。 */
export function normalizeTtsAdjust(value, unit, fallback = `+0${unit}`) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const m = raw.match(/^([+-]?)(\d+(?:\.\d+)?)\s*(%|Hz|hz)?$/);
  if (!m) throw new Error(`参数格式不对：${raw}（要写成 +10${unit} 或 -5${unit}）`);
  const sign = m[1] === '-' ? '-' : '+';
  const num = Number(m[2]);
  return `${sign}${num}${unit}`;
}

/** 去掉会干扰合成的字符：CQ 码、控制字符、超长换行。 */
export function sanitizeSpeechText(text, maxChars = 200) {
  let s = String(text ?? '');
  s = s.replace(/\[CQ:[^\]]*\]/gi, ' ');
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) throw new Error('没有可合成的内容（文字为空）');
  if (s.length > maxChars) s = s.slice(0, maxChars);
  return s;
}

/**
 * 合成一段语音到 outDir，返回 { path, bytes, voice, text, engine }。
 * 同名同文会复用已有文件（按内容哈希），避免反复调在线接口。
 */
export async function synthesizeSpeech({
  text,
  outDir,
  voice = 'zh-CN-XiaoyiNeural',
  rate,
  pitch,
  volume,
  engine = 'edge-tts',
  bin,
  maxChars = 200,
  timeoutMs = 60000,
  force = false
} = {}) {
  if (!outDir) throw new Error('缺少 outDir（语音库目录）');
  fs.mkdirSync(outDir, { recursive: true });
  const clean = sanitizeSpeechText(text, maxChars);
  if (!VOICE_ID_RE.test(voice)) throw new Error(`音色 id 不合法：${voice}（形如 zh-CN-XiaoyiNeural）`);
  const rateArg = normalizeTtsAdjust(rate, '%');
  const pitchArg = normalizeTtsAdjust(pitch, 'Hz');
  const volumeArg = normalizeTtsAdjust(volume, '%');
  const hash = crypto.createHash('sha1').update(`${engine}|${voice}|${rateArg}|${pitchArg}|${volumeArg}|${clean}`).digest('hex').slice(0, 10);
  const outPath = path.join(outDir, `tts-${hash}.mp3`);
  if (!force) {
    try {
      const st = fs.statSync(outPath);
      if (st.size > 1024) return { path: outPath, bytes: st.size, voice, text: clean, engine, reused: true };
    } catch {}
  }

  if (engine === 'say') {
    // 离线兜底：macOS say 输出 AIFF，再用 ffmpeg 转 mp3。
    const aiff = outPath.replace(/\.mp3$/, '.aiff');
    await execFileP('/usr/bin/say', ['-v', 'Tingting', '-o', aiff, clean], { timeout: timeoutMs });
    const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
    await execFileP(ffmpeg, ['-y', '-loglevel', 'error', '-i', aiff, '-codec:a', 'libmp3lame', '-q:a', '4', outPath], { timeout: timeoutMs });
    try { fs.unlinkSync(aiff); } catch {}
    const st = fs.statSync(outPath);
    return { path: outPath, bytes: st.size, voice: 'say:Tingting', text: clean, engine, reused: false };
  }

  const ttsBin = resolveEdgeTtsBin(bin);
  const tmp = `${outPath}.part`;
  try {
    await execFileP(ttsBin, [
      '--voice', voice,
      `--rate=${rateArg}`,
      `--pitch=${pitchArg}`,
      `--volume=${volumeArg}`,
      '--text', clean,
      '--write-media', tmp
    ], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    const st = fs.statSync(tmp);
    if (!st.size) throw new Error('edge-tts 输出了空文件（可能是网络或音色 id 问题）');
    fs.renameSync(tmp, outPath);
    return { path: outPath, bytes: st.size, voice, text: clean, engine, reused: false };
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    const msg = String(error?.stderr || error?.message || error);
    throw new Error(`TTS 合成失败（${engine}/${voice}）：${msg.slice(0, 300)}`);
  }
}

/** 列出可用中文音色（直接问 edge-tts，失败就返回内置预设）。 */
export async function listTtsVoices({ bin, timeoutMs = 30000 } = {}) {
  try {
    const ttsBin = resolveEdgeTtsBin(bin);
    const { stdout } = await execFileP(ttsBin, ['--list-voices'], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    const rows = [];
    for (const line of String(stdout).split('\n')) {
      const cols = line.split(/\s{2,}/).map((x) => x.trim()).filter(Boolean);
      if (cols.length >= 2 && VOICE_ID_RE.test(cols[0]) && /^zh-/.test(cols[0])) {
        rows.push({ id: cols[0], gender: cols[1] ?? '', tone: cols.slice(2).join(' ') });
      }
    }
    if (rows.length) return rows;
  } catch {}
  return TTS_VOICE_PRESETS.map((v) => ({ id: v.id, gender: v.gender, tone: v.tone }));
}
