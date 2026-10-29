#!/usr/bin/env bash
# GPT-SoVITS 音色克隆说话服务：用一段 3–10 秒参考人声克隆音色来念文字。
#
# 为什么需要它：音色克隆（zero-shot）比 edge-tts + RVC 大肥鱼更"像小柚本人"，
# 参考音频换成谁的声音就克隆谁，不用重训。服务端一次加载 BERT/CNHuBERT/VITS 权重，
# 之后每句只跑一次推理（本机 CPU 首词约 6 秒，再跑约 3 秒）。
#
# 用法：
#   ./scripts/start-gsv.sh --bg     后台起（默认 9880 端口）
#   ./scripts/start-gsv.sh --stop   停
#   ./scripts/start-gsv.sh          前台跑，方便看日志
set -euo pipefail

APP_DIR="${GSV_APP_DIR:-$HOME/Applications/GPT-SoVITS}"
PY="${GSV_PY:-$HOME/Applications/gsv-env/bin/python}"
PORT="${GSV_PORT:-9880}"
PID_FILE="/tmp/gsv-api.pid"
LOG_FILE="/tmp/gsv-api.log"
CFG="$APP_DIR/GPT_SoVITS/configs/tts_infer.yaml"

stop() {
  if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
      echo "已停止 GPT-SoVITS 服务（pid ${pid}）"
    fi
    rm -f "$PID_FILE"
  else
    pkill -f "api_v2.py" 2>/dev/null || true
    echo "没有找到 pid 文件，已尝试按进程名清理"
  fi
}

start_bg() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "GPT-SoVITS 服务已经在跑（pid $(cat "$PID_FILE")）"
    return 0
  fi
  cd "$APP_DIR"
  # PYTHONPATH 必须指到 GPT_SoVITS 目录：AR 模块在 GPT_SoVITS/ 下，不在包路径里。
  PYTHONPATH="$APP_DIR/GPT_SoVITS" nohup "$PY" api_v2.py -a 127.0.0.1 -p "$PORT" -c "$CFG" > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "GPT-SoVITS 服务启动中（pid $(cat "$PID_FILE")，端口 ${PORT}，日志 ${LOG_FILE}）"
  # 等就绪：加载 Text2Semantic + VITS + BERT + CNHuBERT，约 10~30 秒
  for i in $(seq 1 60); do
    sleep 2
    if curl -s --max-time 2 "http://127.0.0.1:${PORT}/openapi.json" 2>/dev/null | grep -q '"openapi"'; then
      echo "就绪（约 $((i*2)) 秒）"
      return 0
    fi
  done
  echo "等了 120 秒还没就绪，看看日志：tail -20 $LOG_FILE" >&2
  return 1
}

case "${1:---bg}" in
  --stop) stop ;;
  --bg) start_bg ;;
  "") cd "$APP_DIR"; PYTHONPATH="$APP_DIR/GPT_SoVITS" exec "$PY" api_v2.py -a 127.0.0.1 -p "$PORT" -c "$CFG" ;;
  *) echo "用法：$0 [--bg|--stop]" >&2; exit 1 ;;
esac
