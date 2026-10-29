// 画画：文字 → 图片。
//
// 为什么单独一个模块：出图有三条完全不同的路（云端 API / 本地 ComfyUI / 以后可能别的），
// 而 bridge.js 只关心"拿到一张图片的字节"。把 provider 抽象放在这里，
// 换模型只是改 config，不用碰 1.4 万行的主程序。
//
// 当前支持：
//   - glm（默认）：智谱 CogView。cogview-4 质量好，cogview-3-flash 免费且够用。
//     缺点：右下角有「AI生成」水印（实测 watermark_enabled:false 无效，是烧在像素里的）。
//   - comfy：本地 ComfyUI（http://127.0.0.1:8188）。质量上限最高、无水印，但要自己装模型。
//
// 安全边界：这个模块只负责"生成图片字节"，不负责发给谁；发送走 bridge 的图片通道。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const GLM_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/images/generations';

export const DRAW_MODEL_PRESETS = [
  { id: 'cogview-4', label: 'CogView-4（质量好，付费，有水印）', watermark: true, free: false },
  { id: 'cogview-4-250304', label: 'CogView-4 250304（同上，定版）', watermark: true, free: false },
  { id: 'cogview-3-flash', label: 'CogView-3-Flash（免费，快，有水印）', watermark: true, free: true },
  { id: 'comfy', label: '本地 ComfyUI（无水印，需自己装模型）', watermark: false, free: true }
];

// CogView 支持的尺寸；选错会直接被 API 拒。
export const COGVIEW_SIZES = ['1024x1024', '768x1344', '864x1152', '1152x864', '1344x768', '1440x1440', '1280x720', '720x1280'];

/** 小柚自己的长相基线：风格可以变，但这些特征要保持一致，否则每张图她都换个人。 */
export const DEFAULT_CHARACTER_SHEET =
  '1girl, solo, long blue hair, wavy hair, blue eyes, pale skin, white maid headdress, ' +
  'white and navy blue maid dress, frilly apron, whale tail motive, cute, soft smile';

export function defaultDrawConfig(cfg) {
  const d = cfg ?? {};
  return {
    enabled: d.enabled !== false,
    provider: ['glm', 'comfy'].includes(d.provider) ? d.provider : 'glm',
    model: String(d.model || 'cogview-4'),
    size: COGVIEW_SIZES.includes(String(d.size)) ? String(d.size) : '1024x1024',
    // 提示词前缀：固定画风 + 角色基线，模型只写"场景/动作"，这样出图风格稳定。
    promptPrefix: String(d.promptPrefix ?? 'masterpiece, best quality, anime style, soft lighting, detailed'),
    characterSheet: String(d.characterSheet ?? DEFAULT_CHARACTER_SHEET),
    // 负面提示词：CogView 不吃 negative prompt，但本地 ComfyUI 吃，保留在配置里备用。
    negativePrompt: String(d.negativePrompt ?? 'lowres, bad anatomy, bad hands, extra fingers, watermark, text'),
    saveDir: path.resolve(d.saveDir || '.'),
    maxPerHour: Number(d.maxPerHour) >= 0 ? Number(d.maxPerHour) : 6,
    sendToChat: d.sendToChat !== false,
    apiKeyEnv: String(d.apiKeyEnv || 'GLM_API_KEY'),
    comfyUrl: String(d.comfyUrl || 'http://127.0.0.1:8188'),
    comfyWorkflow: String(d.comfyWorkflow || ''),
    // 学画：出图前先去图库确认画风词（见 art-tags.js），默认开启。
    learn: d.learn !== false,
    learnDir: path.resolve(d.learnDir || d.saveDir || '.'),
    timeoutMs: Number(d.timeoutMs) > 0 ? Number(d.timeoutMs) : 180000
  };
}

/** 把「用户想要的一幕」拼成真正喂给模型的提示词。 */
export function buildImagePrompt({ scene, style, characterSheet, promptPrefix, withCharacter = true, extra } = {}) {
  const parts = [];
  if (promptPrefix) parts.push(String(promptPrefix).trim());
  if (withCharacter && characterSheet) parts.push(String(characterSheet).trim());
  if (style) parts.push(String(style).trim());
  if (extra) parts.push(String(extra).trim());
  if (scene) parts.push(String(scene).trim());
  const joined = parts.filter(Boolean).join(', ');
  if (!joined) throw new Error('提示词为空：给一句想画什么（scene）');
  return joined.slice(0, 1500);
}

function detectImageExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return 'png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/** 写盘：按真实字节判断扩展名（CogView 返回的是 JPEG 但有时挂 .png 的名字，按名字存会读不出来）。 */
export function saveImage(buf, outDir, { prefix = 'draw' } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const ext = detectImageExt(buf) || 'jpg';
  const name = `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
  const full = path.join(outDir, name);
  fs.writeFileSync(full, buf);
  return { path: full, bytes: buf.length, ext };
}

/**
 * GLM CogView 出图。返回 { buffer, mimeType, model, prompt }。
 * 注意：url 有效期有限（当天），所以拿到就立刻下载字节，不要只存 url。
 */
export async function generateWithGlm({ prompt, model = 'cogview-4', size = '1024x1024', apiKey, timeoutMs = 180000, watermark = false }) {
  if (!apiKey) throw new Error('缺少 GLM API key（环境变量 GLM_API_KEY 或 ~/.dsh/.credentials.yaml）');
  const started = Date.now();
  const res = await fetch(GLM_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt, size, watermark_enabled: watermark === true }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || `HTTP ${res.status}`;
    throw new Error(`CogView 出图失败：${msg}`);
  }
  const url = body?.data?.[0]?.url;
  if (!url) throw new Error('CogView 没有返回图片地址');
  const img = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!img.ok) throw new Error(`下载生成的图片失败：HTTP ${img.status}`);
  const buffer = Buffer.from(await img.arrayBuffer());
  const ext = detectImageExt(buffer);
  if (!ext) throw new Error('下载回来的内容不是图片（可能是错误页）');
  return { buffer, mimeType: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg', model, prompt, url, ms: Date.now() - started };
}

/**
 * 本地 ComfyUI 出图（/prompt 提交一个 workflow，轮询 /history 拿结果）。
 * workflow 是 ComfyUI 导出的 API 格式 JSON；仓库里不放模型，用户自己准备。
 */
export async function generateWithComfy({ prompt, negative, workflowPath, comfyUrl = 'http://127.0.0.1:8188', timeoutMs = 300000 }) {
  if (!workflowPath || !fs.existsSync(workflowPath)) throw new Error(`找不到 ComfyUI workflow：${workflowPath || '(未配置 socialV2.draw.comfyWorkflow)'}`);
  const wf = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  // 把提示词灌进 workflow：找带 positive/negative 文本输入的节点。
  let injected = 0;
  for (const node of Object.values(wf)) {
    if (node?.class_type === 'CLIPTextEncode' && typeof node.inputs?.text === 'string') {
      const t = node.inputs.text.toLowerCase();
      if (t.includes('negative') || t.includes('worst') || t.includes('lowres')) node.inputs.text = negative || node.inputs.text;
      else if (injected === 0) { node.inputs.text = prompt; injected++; }
    }
  }
  if (!injected) throw new Error('workflow 里没找到可写提示词的 CLIPTextEncode 节点');
  const clientId = crypto.randomUUID();
  const submit = await fetch(`${comfyUrl}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: wf, client_id: clientId }),
    signal: AbortSignal.timeout(30000)
  });
  const sub = await submit.json().catch(() => ({}));
  const promptId = sub?.prompt_id;
  if (!submit.ok || !promptId) throw new Error(`ComfyUI 提交失败：${sub?.error?.message || submit.status}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const h = await fetch(`${comfyUrl}/history/${promptId}`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => null);
    const entry = h?.[promptId];
    if (!entry) continue;
    const outputs = entry.outputs ?? {};
    for (const out of Object.values(outputs)) {
      const img = out?.images?.[0];
      if (img?.filename) {
        const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' });
        const bin = await fetch(`${comfyUrl}/view?${q.toString()}`, { signal: AbortSignal.timeout(60000) });
        if (!bin.ok) continue;
        return { buffer: Buffer.from(await bin.arrayBuffer()), mimeType: 'image/png', model: 'comfy', prompt, ms: null };
      }
    }
  }
  throw new Error('ComfyUI 出图超时（模型可能还在加载，第一次跑会慢很多）');
}
