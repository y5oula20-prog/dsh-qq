// SVC 翻唱：把一首歌的人声换成目标音色（默认达妮娅），伴奏原样保留。
//
// 与 song.js（ACE-Step 从零生成一首歌）的区别：
//   song.js  → 文字歌词 + 风格 → AI 作曲作词演唱（音色不固定）
//   cover.js → 现成的歌 → 只换唱的人（旋律、咬字、编曲全保留）
//
// 链路：demucs 分离人声/伴奏 → 切段 → RMVPE 提 f0 → SoulX-Singer SVC 换声
//       → amix 混回伴奏 → alimiter/loudnorm → mp3
//
// macOS 三个硬坑（别踩第二次）：
//   1. SoulX 要 transformers==4.41.2，gsv-env 是 4.57.6，新版 LlamaAttention
//      多一个必填 position_embeddings 会直接崩。用 --target 单独装到 soulx-tf 目录，
//      再 PYTHONPATH 前置。
//   2. --target 会连带装 numpy 2.x 顶掉 gsv-env 的 1.26，必须手动删掉
//      soulx-tf/numpy* 目录。
//   3. SVC 是纯 CPU 跑的（698M 参数，没有 MPS 路径），16 秒歌约 3 分钟。
//      所以长歌要等很久，调用方要留足超时。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = process.env.HOME || '/Users/caizhiqiang';

export function defaultCoverConfig(cfg) {
  const c = cfg ?? {};
  return {
    enabled: c.enabled !== false,
    // 源码与权重
    srcDir: path.resolve(c.srcDir || path.join(HOME, 'Applications/SoulX-Singer/src')),
    modelPath: path.resolve(c.modelPath || path.join(HOME, 'Applications/SoulX-Singer/pretrained_models/SoulX-Singer/model-svc.pt')),
    rmvpePath: path.resolve(c.rmvpePath || path.join(HOME, 'Applications/SoulX-Singer/pretrained_models/SoulX-Singer-Preprocess/rmvpe/rmvpe.pt')),
    // 跑 SVC 用的 python（gsv-env 里有 torch/librosa/omegaconf 等全部依赖）
    python: c.python || path.join(HOME, 'Applications/gsv-env/bin/python'),
    // 兼容版 transformers 目录（4.41.2）
    tfCompatDir: path.resolve(c.tfCompatDir || path.join(HOME, 'Applications/soulx-tf')),
    // 跑 demucs 用的 python（rvc venv 里装了 demucs）
    demucsPython: c.demucsPython || path.join(HOME, 'Applications/rvc/.venv310/bin/python'),
    ffmpegPath: c.ffmpegPath || '',
    // 音色参考：3–10 秒单人干净人声
    refAudioPath: c.refAudioPath || '',
    // 段长限制：太长 CPU 跑不动
    maxSeconds: Number(c.maxSeconds) > 0 ? Number(c.maxSeconds) : 120,
    defaultSeconds: Number(c.defaultSeconds) > 0 ? Number(c.defaultSeconds) : 30,
    // SVC 步数：32 是官方默认，降下来更快但更糙
    steps: Number(c.steps) > 0 ? Number(c.steps) : 32,
    // 输出响度
    loudnessLufs: Number(c.loudnessLufs) === 0 ? 0 : (Number(c.loudnessLufs) || -14),
    timeoutMs: Number(c.timeoutMs) > 0 ? Number(c.timeoutMs) : 3600000,
    workDir: path.resolve(c.workDir || path.join(HOME, 'Applications/cover-work'))
  };
}

function resolveFfmpeg(cfg) {
  if (cfg.ffmpegPath && fs.existsSync(cfg.ffmpegPath)) return cfg.ffmpegPath;
  for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
}

/** 跑一条命令，失败时把 stderr 尾部抛出来（比裸 exit code 好查）。 */
function run(cmd, args, { cwd, env, timeoutMs = 3600000, label = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`${label || cmd} 超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ out, err });
      const tail = (err || out).trim().split('\n').slice(-4).join(' / ');
      reject(new Error(`${label || path.basename(cmd)} 失败（exit ${code}）：${tail.slice(0, 400)}`));
    });
  });
}

/** 探 SVC 环境是否就绪（权重在不在、transformers 兼容目录在不在）。 */
export function coverHealth(cfg) {
  const c = defaultCoverConfig(cfg);
  const missing = [];
  if (!fs.existsSync(c.srcDir)) missing.push(`源码目录 ${c.srcDir}`);
  if (!fs.existsSync(c.modelPath)) missing.push(`SVC 权重 ${c.modelPath}`);
  if (!fs.existsSync(c.rmvpePath)) missing.push(`RMVPE ${c.rmvpePath}`);
  if (!fs.existsSync(c.python)) missing.push(`python ${c.python}`);
  if (!fs.existsSync(c.demucsPython)) missing.push(`demucs python ${c.demucsPython}`);
  if (!fs.existsSync(c.tfCompatDir)) missing.push(`transformers 兼容目录 ${c.tfCompatDir}`);
  if (!c.refAudioPath || !fs.existsSync(c.refAudioPath)) missing.push(`音色参考音频 ${c.refAudioPath || '(未配置)'}`);
  return { ok: missing.length === 0, missing };
}

/** 用 RMVPE 提取 f0 曲线，落 .npy。独立进程跑，避免污染主进程依赖。 */
async function extractF0(cfg, wavPath, npyPath) {
  const code = `
import sys, numpy as np
sys.path.insert(0, ${JSON.stringify(cfg.srcDir)})
from preprocess.tools.f0_extraction import F0Extractor
ex = F0Extractor(${JSON.stringify(cfg.rmvpePath)}, device="cpu")
f0 = ex.process(${JSON.stringify(wavPath)}, f0_path=${JSON.stringify(npyPath)})
v = f0[f0 > 0]
print("F0OK frames=%d median=%.0f" % (len(f0), float(np.median(v)) if len(v) else 0))
`;
  await run(cfg.python, ['-c', code], {
    cwd: cfg.srcDir,
    env: { PYTHONPATH: `${cfg.srcDir}:${cfg.tfCompatDir}` },
    timeoutMs: 600000,
    label: 'RMVPE 提 f0'
  });
}

/**
 * 翻唱主流程。
 * @param {object} opts
 * @param {string} opts.songPath  原曲音频（本地绝对路径）
 * @param {number} opts.startSec  从第几秒开始（默认 0）
 * @param {number} opts.durationSec 取多长（默认 cfg.defaultSeconds）
 * @param {string} opts.outDir    成品输出目录
 * @param {string} opts.tag       文件名标记
 * @param {function} opts.onStep  进度回调 (text) => void
 */
export async function coverSong({
  songPath,
  startSec = 0,
  durationSec,
  outDir,
  tag = 'cover',
  cfg: rawCfg,
  onStep = () => {}
} = {}) {
  const cfg = defaultCoverConfig(rawCfg);
  const health = coverHealth(cfg);
  if (!health.ok) throw new Error(`SVC 翻唱环境不完整：缺 ${health.missing.join('、')}`);
  if (!songPath || !fs.existsSync(songPath)) throw new Error(`原曲不存在：${songPath}`);

  const dur = Math.min(Math.max(Number(durationSec) > 0 ? Number(durationSec) : cfg.defaultSeconds, 5), cfg.maxSeconds);
  const start = Math.max(Number(startSec) || 0, 0);
  const end = start + dur;

  const work = path.join(cfg.workDir, `${tag}-${Date.now()}`);
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();

  // ① 分离人声 / 伴奏
  onStep('分离人声与伴奏');
  const sepRoot = path.join(work, 'sep');
  await run(cfg.demucsPython, [
    '-m', 'demucs', '--two-stems=vocals', '-n', 'htdemucs', '-o', sepRoot, songPath
  ], { env: { OMP_NUM_THREADS: '4' }, timeoutMs: 1800000, label: 'demucs 分离' });
  const stemDir = path.join(sepRoot, 'htdemucs', path.basename(songPath, path.extname(songPath)));
  const vocals = path.join(stemDir, 'vocals.wav');
  const accomp = path.join(stemDir, 'no_vocals.wav');
  if (!fs.existsSync(vocals)) throw new Error('demucs 没产出 vocals.wav');

  // ② 切段（人声与伴奏必须切同一段，否则混音会错位）
  onStep(`切段 ${start}–${end}s`);
  const ffmpeg = resolveFfmpeg(cfg);
  const vocalSeg = path.join(work, 'vocal_seg.wav');
  const accompSeg = path.join(work, 'accomp_seg.wav');
  for (const [src, dst] of [[vocals, vocalSeg], [accomp, accompSeg]]) {
    await run(ffmpeg, [
      '-v', 'error', '-y', '-ss', String(start), '-to', String(end),
      '-i', src, '-ar', '44100', dst
    ], { timeoutMs: 180000, label: 'ffmpeg 切段' });
  }

  // ③ f0 曲线（目标=原唱人声，参考=音色源）
  onStep('提取音高曲线');
  const refF0 = path.join(work, 'ref_f0.npy');
  await extractF0(cfg, cfg.refAudioPath, refF0);
  const tgtF0 = path.join(work, 'target_f0.npy');
  await extractF0(cfg, vocalSeg, tgtF0);

  // ④ SVC 换音色
  onStep('换音色（CPU，这一步最慢）');
  const svcOut = path.join(work, 'svc');
  fs.mkdirSync(svcOut, { recursive: true });
  // 必须用 fileURLToPath：pathname 不会解码中文路径，会把「鲸鱼工作室」变成 %E9%B2%B8...
  const inferScript = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'svc_infer.py');
  await run(cfg.python, [
    inferScript,
    '--prompt', cfg.refAudioPath,
    '--prompt-f0', refF0,
    '--target', vocalSeg,
    '--target-f0', tgtF0,
    '--out-dir', svcOut,
    '--device', 'cpu',
    '--n-steps', String(cfg.steps)
  ], {
    cwd: cfg.srcDir,
    env: { PYTHONPATH: `${cfg.srcDir}:${cfg.tfCompatDir}` },
    timeoutMs: cfg.timeoutMs,
    label: 'SVC 换声'
  });
  const svcWav = path.join(svcOut, 'generated.wav');
  if (!fs.existsSync(svcWav)) throw new Error('SVC 没产出 generated.wav');

  // ⑤ 混回伴奏 + 限幅 + 响度归一
  onStep('混回伴奏');
  const outFile = path.join(outDir, `${tag}.mp3`);
  const mixFilters = [
    '[0:a]aresample=44100,aformat=channel_layouts=stereo[v]',
    '[1:a]aresample=44100,aformat=channel_layouts=stereo[a]',
    '[v][a]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95'
  ];
  if (cfg.loudnessLufs) mixFilters[2] += `,loudnorm=I=${cfg.loudnessLufs}:TP=-1.0:LRA=11`;
  await run(ffmpeg, [
    '-v', 'error', '-y', '-i', svcWav, '-i', accompSeg,
    '-filter_complex', mixFilters.join(';'),
    '-c:a', 'libmp3lame', '-b:a', '192k', outFile
  ], { timeoutMs: 300000, label: 'ffmpeg 混音' });

  const bytes = fs.statSync(outFile).size;
  return {
    path: outFile,
    bytes,
    seconds: dur,
    ms: Date.now() - t0,
    vocalPath: svcWav,
    workDir: work
  };
}
