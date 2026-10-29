// 换声（RVC）：把 ACE-Step 唱出来的声音，换成小柚自己的音色。
//
// 为什么需要这一步：
//   ACE-Step 出歌时人声是它自己"发挥"的音色，每次都不一样——第一首是清亮少女，
//   第二首可能就偏成熟。说话走的是 edge-tts 晓伊（固定音色），唱歌却是另一个人，
//   听起来不像同一个角色。RVC 只换音色、保留旋律与咬字，正好补这一刀。
//
// 环境约束（实测，三条缺一不可）：
//   1. OMP_NUM_THREADS=1 —— faiss 的 IndexIVFFlat 在多线程下会 segfault（exit 139）
//   2. RVC_FORCE_CPU=1   —— MPS 后端会 segfault，必须强制 CPU。前提是打过补丁：
//      rvc_python/configs/config.py 的 has_mps() 开头要认这个变量
//   3. TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1 —— torch 2.14 默认 weights_only=True，
//      fairseq 的 hubert checkpoint 反序列化会失败
//   4. NUMBA_CACHE_DIR=/tmp/... —— numba 默认把缓存写进 site-packages，那个目录被
//      WorkBuddy 的 safe-delete 钩子盯着，写临时文件会被拦并要求确认，表现为
//      librosa 导入失败、RVC 输出 0 字节。指到 /tmp 就没事。
//
// 性能：40 秒的歌在 M3 CPU 上约 30 秒。CPU 单线程跑，不抢 GPU 也不影响出歌。
//
// ★ 为什么要先分离人声（2026-10-29 补）：
//   最开始是把整首歌直接喂给 RVC，结果伴奏被当成"人声"一起重唱了——实测低频 <150Hz
//   从 -18.5dB 掉到 -33.9dB（贝斯底鼓被压平）、f0 中位从 182Hz 飘到 330Hz、峰值冲到
//   +0.3dBFS 削波、响度掉 3LUFS。人耳听到的就是"音色对了但不流畅"。
//   RVC 是换声模型不是混音模型，官方 README 也写明输入必须是"干净人声"。
//   正解：demucs 分离 → 只对干声换声 → 和原伴奏混回去。混完频响与原声几乎一致
//   （低频 -17.2dB、1kHz -26.9dB、响度 -13.0 LUFS），只有音色变了。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import os from 'node:os';

export function defaultRvcConfig(cfg) {
  const r = cfg ?? {};
  return {
    enabled: r.enabled !== false,
    // rvc_python 装在独立 venv 里，用的是 Python 3.10（3.11 的 fairseq 会崩，3.12 装不上）
    venvPython: String(r.venvPython || path.join(os.homedir(), 'Applications', 'rvc', '.venv310', 'bin', 'python')),
    workDir: String(r.workDir || path.join(os.homedir(), 'Applications', 'rvc')),
    modelPath: String(r.modelPath || 'FeiyuVoice-RVC-v1.pth'),
    indexPath: String(r.indexPath || 'FeiyuVoice-RVC-v1.index'),
    // FeiyuVoice 官方 README 推荐值：RMVPE 取基频、index 0.3、protect 0.33
    f0Method: String(r.f0Method || 'rmvpe'),
    indexRate: Number(r.indexRate) >= 0 ? Number(r.indexRate) : 0.3,
    protect: Number(r.protect) > 0 ? Number(r.protect) : 0.33,
    pitchShift: Number.isFinite(Number(r.pitchShift)) ? Number(r.pitchShift) : 0,
    timeoutMs: Number(r.timeoutMs) > 0 ? Number(r.timeoutMs) : 600000,
    // 先分离人声再换声。关掉的话会退化成"整首换声"，伴奏会被毁（见文件头注释）
    separate: r.separate !== false,
    // 说话（TTS 出来的干净单声道）要不要也换成这个音色。
    // TTS 本来就没有伴奏，不需要分离——直接换，省 6 秒。
    speech: r.speech !== false,
    // demucs 的模型名。htdemucs 是默认档，质量/速度平衡最好
    demucsModel: String(r.demucsModel || 'htdemucs'),
    // 混音时伴奏留多少。1 = 原样，调小一点人声更突出
    accompanimentGain: Number.isFinite(Number(r.accompanimentGain)) ? Number(r.accompanimentGain) : 1,
    // 混完做响度归一，避免比原曲小一截
    normalizeLoudness: r.normalizeLoudness !== false,
    ffmpegPath: String(r.ffmpegPath || ''),
    // 常驻服务地址。配了就先试服务（2.3s），不通再退回 CLI（6.9s）。
    // 说话场景对延迟敏感，服务模式基本是必须的；唱歌不差这几秒，CLI 也行。
    serverUrl: String(r.serverUrl ?? 'http://127.0.0.1:8020'),
    // 服务不可用时是否退回 CLI。关掉的话服务挂了就直接失败（调试时有用）
    fallbackToCli: r.fallbackToCli !== false,
    // 默认保留源文件：源是刚出的歌，删了就没法重发或事后对比
    keepSource: r.keepSource !== false
  };
}

/** rvc_python 的命令行参数。抽出来方便测试和排查。 */
export function buildRvcArgs({ inPath, outPath, modelPath, indexPath, f0Method = 'rmvpe', indexRate = 0.3, protect = 0.33, pitchShift = 0 }) {
  return [
    '-m', 'rvc_python', 'cli',
    '-i', inPath,
    '-o', outPath,
    '-mp', modelPath,
    '-ip', indexPath,
    '-de', 'cpu:0',
    '-v', 'v2',
    '-me', f0Method,
    '-ir', String(indexRate),
    '-pr', String(protect),
    ...(pitchShift ? ['-pi', String(pitchShift)] : [])
  ];
}

/** 跑一个子进程，失败时把最后几行 stderr 一起抛出来（排查比裸 error 有用得多）。 */
function run(cmd, args, { cwd, timeout, env, signal, label }) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      if (signal?.aborted) return reject(new Error(`${label}已取消`));
      if (error) {
        const detail = String(stderr || stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-4).join(' | ');
        return reject(new Error(`${label}失败：${error.message}${detail ? `（${detail}）` : ''}`));
      }
      resolve({ stdout, stderr });
    });
    if (signal) signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
  });
}

/**
 * 通过常驻服务换声。服务不通/没起就返回 null，交给调用方决定是否退 CLI。
 * 为什么要服务：CLI 每次要重新 import torch+fairseq 再加载 55MB 模型，一句 3 秒的话
 * 光启动就 4.5 秒；常驻后稳定 2.3 秒。说话是即时交互，这几秒是体验分水岭。
 */
async function serverConvert({ inPath, outPath, cfg: c, signal }) {
  if (!c.serverUrl) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(c.timeoutMs, 300000));
    if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    const res = await fetch(`${c.serverUrl.replace(/\/$/, '')}/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ in: inPath, out: outPath }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.ok) return null;
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) return null;
    return { ms: Number(data.ms) || 0 };
  } catch {
    return null;
  }
}

function resolveFfmpeg(cfgFfmpeg) {
  if (cfgFfmpeg && fs.existsSync(cfgFfmpeg)) return cfgFfmpeg;
  for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
}

/**
 * 分离人声与伴奏。输出 vocals.wav / no_vocals.wav 两个 44.1kHz 立体声文件。
 * 用的是 demucs（装在 RVC 那个 venv 里，因为它同时有 torch 和 librosa）。
 */
async function separateStems({ inPath, outDir, cfg: c, signal }) {
  const destDir = path.join(outDir, 'stems', path.basename(inPath).replace(/\.[^.]+$/, ''));
  fs.mkdirSync(destDir, { recursive: true });
  // demucs 会自己建 <out>/<model>/<track>/ 目录，所以传父目录，拿回来再找
  const root = path.join(outDir, 'stems');
  await run(
    c.venvPython,
    ['-m', 'demucs', '--two-stems=vocals', '-n', c.demucsModel, '-o', root, inPath],
    {
      cwd: c.workDir,
      timeout: c.timeoutMs,
      env: { OMP_NUM_THREADS: '2', TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD: '1' },
      signal,
      label: '分离人声'
    }
  );
  const found = path.join(root, c.demucsModel, path.basename(inPath).replace(/\.[^.]+$/, ''));
  const vocals = path.join(found, 'vocals.wav');
  const accompaniment = path.join(found, 'no_vocals.wav');
  if (!fs.existsSync(vocals) || !fs.existsSync(accompaniment)) {
    throw new Error(`分离没产出文件（找的是 ${found}）`);
  }
  return { vocals, accompaniment, dir: destDir };
}

/**
 * 把换好声的干声和原伴奏混回去，顺手做响度归一。
 * normalize=0 是必须的：ffmpeg 的 amix 默认会把两路各除以输入数，整体音量会掉一半。
 */
async function remixStems({ vocalsPath, accompanimentPath, outPath, cfg: c, signal }) {
  const ffmpeg = resolveFfmpeg(c.ffmpegPath);
  const gain = Number(c.accompanimentGain) > 0 ? Number(c.accompanimentGain) : 1;
  const filters = [
    '[0:a]aresample=48000,aformat=channel_layouts=stereo[v]',
    `[1:a]aresample=48000,aformat=channel_layouts=stereo,volume=${gain}[i]`,
    '[v][i]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[m]',
    c.normalizeLoudness
      ? '[m]alimiter=limit=0.95,loudnorm=I=-14:TP=-1.0:LRA=11[out]'
      : '[m]alimiter=limit=0.95[out]'
  ].join(';');
  await run(
    ffmpeg,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', vocalsPath, '-i', accompanimentPath,
      '-filter_complex', filters, '-map', '[out]', '-c:a', 'libmp3lame', '-q:a', '2', outPath],
    { timeout: c.timeoutMs, signal, label: '混音' }
  );
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) throw new Error('混音没有产出有效文件');
}

/**
 * 把一段音频的人声换成模型音色。
 *
 * 默认走「分离 → 只换干声 → 混回伴奏」；separate=false 时退回整首直转（会毁伴奏，仅供对比）。
 * @returns {Promise<{path:string, bytes:number, ms:number, separated:boolean}>}
 */
export async function convertVoice({ inPath: rawInPath, outDir: rawOutDir, cfg: rawCfg = {}, signal = null } = {}) {
  const c = defaultRvcConfig(rawCfg);
  if (!c.enabled) throw new Error('换声功能已关闭（socialV2.rvc.enabled=false）');
  // ★ 必须转成绝对路径：子进程的 cwd 是 workDir（rvc 目录），相对路径会在那边找不到文件。
  //   找不到时的报错极具误导性（AttributeError: 'tuple' object has no attribute 'dtype'），
  //   看起来像 scipy 崩了，其实是输入读不出来。
  const inPath = path.resolve(rawInPath);
  const outDir = path.resolve(rawOutDir);
  if (!fs.existsSync(inPath)) throw new Error(`换声输入文件不存在：${inPath}`);
  if (!fs.existsSync(c.venvPython)) throw new Error(`找不到 RVC 的 Python：${c.venvPython}（换声需要它，见 docs）`);
  const modelAbs = path.isAbsolute(c.modelPath) ? c.modelPath : path.join(c.workDir, c.modelPath);
  const indexAbs = path.isAbsolute(c.indexPath) ? c.indexPath : path.join(c.workDir, c.indexPath);
  if (!fs.existsSync(modelAbs)) throw new Error(`找不到 RVC 模型：${modelAbs}`);

  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(inPath).replace(/\.[^.]+$/, '');
  const t0 = Date.now();

  let source = inPath;
  let stems = null;
  if (c.separate) {
    stems = await separateStems({ inPath, outDir, cfg: c, signal });
    source = stems.vocals;
  }

  const convertedRaw = path.join(outDir, `${base}-vocal-rvc.wav`);
  // 先试常驻服务（快），没有再走 CLI（慢但自包含）
  const viaServer = await serverConvert({ inPath: source, outPath: convertedRaw, cfg: c, signal });
  if (!viaServer) {
    if (!c.fallbackToCli) throw new Error(`RVC 常驻服务不可用（${c.serverUrl}），且 fallbackToCli=false`);
    await run(
      c.venvPython,
      buildRvcArgs({
        inPath: source,
        outPath: convertedRaw,
        modelPath: modelAbs,
        indexPath: fs.existsSync(indexAbs) ? indexAbs : '',
        f0Method: c.f0Method,
        indexRate: c.indexRate,
        protect: c.protect,
        pitchShift: c.pitchShift
      }),
      {
        cwd: c.workDir,
        timeout: c.timeoutMs,
        env: {
          OMP_NUM_THREADS: '1',
          RVC_FORCE_CPU: '1',
          TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD: '1',
          NUMBA_CACHE_DIR: '/tmp/numba_cache'
        },
        signal,
        label: '换声'
      }
    );
  }
  if (!fs.existsSync(convertedRaw)) throw new Error(`换声没有产出文件：${convertedRaw}`);
  if (fs.statSync(convertedRaw).size < 1000) throw new Error('换声输出异常（不到 1KB），多半是环境变量没设对，见模块注释');

  let finalPath = convertedRaw;
  if (stems) {
    finalPath = path.join(outDir, `${base}-rvc.mp3`);
    await remixStems({
      vocalsPath: convertedRaw,
      accompanimentPath: stems.accompaniment,
      outPath: finalPath,
      cfg: c,
      signal
    });
  }

  if (c.keepSource === false) { try { fs.unlinkSync(inPath); } catch {} }
  const st = fs.statSync(finalPath);
  return { path: finalPath, bytes: st.size, ms: Date.now() - t0, separated: !!stems };
}

/**
 * 换声可用吗？给自己和运维看的一句话诊断。
 * 会顺手探一下常驻服务：服务没起也能工作（退 CLI），只是慢 4 秒，所以只算 warning。
 */
export async function rvcHealth(rawCfg = {}) {
  const c = defaultRvcConfig(rawCfg);
  const modelAbs = path.isAbsolute(c.modelPath) ? c.modelPath : path.join(c.workDir, c.modelPath);
  const problems = [];
  const warnings = [];
  if (!c.enabled) problems.push('功能已关闭（socialV2.rvc.enabled=false）');
  if (!fs.existsSync(c.venvPython)) problems.push(`缺 Python：${c.venvPython}`);
  if (!fs.existsSync(modelAbs)) problems.push(`缺模型：${modelAbs}`);

  let server = { url: c.serverUrl, up: false };
  if (c.serverUrl) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(`${c.serverUrl.replace(/\/$/, '')}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) { const d = await res.json(); server = { ...server, up: d?.ok === true }; }
    } catch { /* 服务没起就是没起，不算错误 */ }
    if (!server.up && c.fallbackToCli) {
      warnings.push(`常驻服务没起（${c.serverUrl}），换声会走 CLI：每句多等约 4 秒。起服务：./scripts/start-rvc.sh --bg`);
    } else if (!server.up) {
      problems.push(`常驻服务没起且 fallbackToCli=false（${c.serverUrl}）`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    detail: { model: modelAbs, f0Method: c.f0Method, indexRate: c.indexRate, protect: c.protect, separate: c.separate, speech: c.speech, server }
  };
}
