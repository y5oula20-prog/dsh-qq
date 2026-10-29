#!/bin/bash
# 启动小柚的歌声模型（ACE-Step 1.5），给 QQ 桥的 qq_sing 用。
#
# 用法：scripts/start-acestep.sh          # 前台跑，Ctrl-C 停
#       scripts/start-acestep.sh --bg     # 后台跑，日志 /tmp/acestep-api.log
#       scripts/start-acestep.sh --stop   # 停掉
#
# 关键点（实测得出的，别乱改）：
#   - ACESTEP_DEVICE=mps：Apple 芯片走 Metal，日志里会显示 "DiT backend: MLX (native)"
#   - ACESTEP_INIT_LLM=true：**必须开 5Hz LM**。之前写 false 的理由是「歌词我们自己给，
#     用不着 LM」——实测证明那个判断是错的。同一段中文歌词、同一模型的对照：
#       thinking=false → 30 秒全是器乐，转写出来是「字幕志愿者 杨茜茜」这种幻觉；
#       thinking=true  → 真的唱出「一闪一闪亮晶晶 / 满天都是小星星」，
#                        f0 中位 292Hz(D4)、有声帧 54%、音级平均跳 5.9 半音。
#     机制：thinking=true 才走 LM 生成 audio codes 给 DiT 当条件；false 是纯 DiT
#     text2music，不保证有唱。
#   - ACESTEP_LM_MODEL_PATH 必须显式指定 1.7B：服务默认找 0.6B，本地没下，
#     不指定就会卡在联网下载。
#   - LM 走 mlx 后端，加载 1.6s，常驻内存 M3 24GB 实测够用。
#   - 不要设 MAX_CUDA_VRAM：在 MPS 上它会骗过显存探测，让服务以为有 24GB 从而错判。
#   - 权重在 checkpoints/（约 10GB），第一次启动会自动从 huggingface 下缺的部分。
set -euo pipefail

APP_DIR="${ACESTEP_APP_DIR:-$HOME/Applications/ACE-Step-1.5}"
PORT="${ACESTEP_PORT:-8001}"
LOG="/tmp/acestep-api.log"

case "${1:-}" in
  --stop)
    pkill -f "acestep/api_server.py" && echo "已停止" || echo "没在跑"
    exit 0
    ;;
esac

if [ ! -x "$APP_DIR/python_embeded/bin/python3.11" ]; then
  echo "找不到 $APP_DIR/python_embeded/bin/python3.11" >&2
  exit 1
fi
if curl -s -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "已经在跑了：http://127.0.0.1:$PORT"
  exit 0
fi

cd "$APP_DIR"
export PYTHONPATH="$APP_DIR"
export ACESTEP_DEVICE=mps
export ACESTEP_INIT_LLM=true
export ACESTEP_LM_MODEL_PATH="acestep-5Hz-lm-1.7B"
export ACESTEP_LM_BACKEND=mlx

if [ "${1:-}" = "--bg" ]; then
  nohup ./python_embeded/bin/python3.11 -u acestep/api_server.py --port "$PORT" > "$LOG" 2>&1 &
  echo "后台启动中，日志：$LOG"
  echo "起来了以后这里能看到 models_initialized:true → curl -s http://127.0.0.1:$PORT/health"
else
  exec ./python_embeded/bin/python3.11 -u acestep/api_server.py --port "$PORT"
fi
