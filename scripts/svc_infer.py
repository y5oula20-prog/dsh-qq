"""SoulX-Singer SVC：把原唱人声换成目标音色（prompt）。"""
import os, sys, argparse
import torch
sys.path.insert(0, os.getcwd())

p = argparse.ArgumentParser()
p.add_argument("--prompt", required=True)
p.add_argument("--prompt-f0", required=True)
p.add_argument("--target", required=True)
p.add_argument("--target-f0", required=True)
p.add_argument("--out-dir", required=True)
p.add_argument("--device", default="cpu")
p.add_argument("--pitch-shift", type=int, default=0)
p.add_argument("--n-steps", type=int, default=32)
p.add_argument("--cfg", type=float, default=3.0)
a = p.parse_args()

from soulxsinger.utils.file_utils import load_config
from cli.inference_svc import build_model, process

config = load_config("soulxsinger/config/soulxsinger.yaml")
args = argparse.Namespace(
    device=a.device, save_dir=a.out_dir,
    prompt_wav_path=a.prompt, target_wav_path=a.target,
    prompt_f0_path=a.prompt_f0, target_f0_path=a.target_f0,
    auto_shift=True, pitch_shift=a.pitch_shift,
    n_steps=a.n_steps, cfg=a.cfg, use_fp16=False,
)
model = build_model("pretrained_models/SoulX-Singer/model-svc.pt", config, a.device)
process(args, config, model)
print("DONE ->", os.path.join(a.out_dir, "generated.wav"))
