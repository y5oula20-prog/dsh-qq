"""SoulX-Singer SVC：把原唱人声换成目标音色（prompt）。

设备优先级：mps → cpu。
MPS 在这台 M3 上比 CPU 快约 4 倍（16 秒音频 233s → 59s），音质实测无退化
（f0 中位 259 vs 258Hz，MFCC 距离 70.3 vs 71.7，歌词转写完整）。

MPS 有个必须处理的坑：不支持 float64。f0 的 .npy 默认是 float64，
直接 .to('mps') 会报
  TypeError: Cannot convert a MPS Tensor to float64 dtype
所以下面统一转 float32。
"""
import os, sys, argparse
import numpy as np
import torch

sys.path.insert(0, os.getcwd())

p = argparse.ArgumentParser()
p.add_argument("--prompt", required=True)
p.add_argument("--prompt-f0", required=True)
p.add_argument("--target", required=True)
p.add_argument("--target-f0", required=True)
p.add_argument("--out-dir", required=True)
p.add_argument("--device", default="auto", help="auto / mps / cpu")
p.add_argument("--pitch-shift", type=int, default=0)
p.add_argument("--n-steps", type=int, default=32)
p.add_argument("--cfg", type=float, default=3.0)
a = p.parse_args()


def pick_device(want):
    if want == "auto":
        return "mps" if torch.backends.mps.is_available() else "cpu"
    if want == "mps" and not torch.backends.mps.is_available():
        print("[svc] 想要 mps 但不可用，回退 cpu", flush=True)
        return "cpu"
    return want


device = pick_device(a.device)
print("[svc] device=%s" % device, flush=True)

from soulxsinger.utils.file_utils import load_config
from cli.inference_svc import build_model, process

config = load_config("soulxsinger/config/soulxsinger.yaml")

ref_f0 = a.prompt_f0
tgt_f0 = a.target_f0
if device == "mps":
    # f0 转 float32——MPS 不支持 float64
    os.makedirs(a.out_dir, exist_ok=True)
    ref_f0 = os.path.join(a.out_dir, "ref_f0_f32.npy")
    tgt_f0 = os.path.join(a.out_dir, "tgt_f0_f32.npy")
    np.save(ref_f0, np.load(a.prompt_f0).astype(np.float32))
    np.save(tgt_f0, np.load(a.target_f0).astype(np.float32))

args = argparse.Namespace(
    device=device, save_dir=a.out_dir,
    prompt_wav_path=a.prompt, target_wav_path=a.target,
    prompt_f0_path=ref_f0, target_f0_path=tgt_f0,
    auto_shift=True, pitch_shift=a.pitch_shift,
    n_steps=a.n_steps, cfg=a.cfg, use_fp16=False,
)
model = build_model("pretrained_models/SoulX-Singer/model-svc.pt", config, device)
try:
    process(args, config, model)
except Exception as e:
    # MPS 上偶发的算子不支持/内存不足，退回 CPU 再跑一遍，别让整首翻唱作废
    if device != "mps":
        raise
    print("[svc] MPS 推理失败（%s: %s），回退 cpu 重跑" % (type(e).__name__, e), flush=True)
    try:
        torch.mps.empty_cache()
    except Exception:
        pass
    args.device = "cpu"
    args.prompt_f0_path = a.prompt_f0
    args.target_f0_path = a.target_f0
    model = build_model("pretrained_models/SoulX-Singer/model-svc.pt", config, "cpu")
    process(args, config, model)

print("DONE ->", os.path.join(a.out_dir, "generated.wav"))
