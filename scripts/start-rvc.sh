#!/usr/bin/env bash
# RVC 换声常驻服务：一次加载模型，之后每句只花 2.3 秒。
#
# 为什么需要它：`python -m rvc_python cli` 每次都要重新 import torch/fairseq（1.9s）
# 再加载 55MB 模型（2.5s）。说话一句 3 秒的话，光启动就 4.5 秒——聊天根本没法用。
#
# 用法：
#   ./scripts/start-rvc.sh --bg     后台起（默认 8020 端口）
#   ./scripts/start-rvc.sh --stop   停
#   ./scripts/start-rvc.sh          前台跑，方便看日志
#
# 注意：桥那边配了 fallbackToCli=true，服务没起也只是慢一点（2.4s → 6.9s），不会发不出语音。
set -euo pipefail

APP_DIR="${RVC_APP_DIR:-$HOME/Applications/rvc}"
PY="$APP_DIR/.venv310/bin/python"
PORT="${RVC_PORT:-8020}"
PID_FILE="/tmp/rvc-server.pid"
LOG_FILE="/tmp/rvc-server.log"

stop() {
  if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
      echo "已停止 RVC 服务（pid ${pid}）"
    fi
    rm -f "$PID_FILE"
  else
    pkill -f "rvc_server.py" 2>/dev/null || true
    echo "没有找到 pid 文件，已尝试按进程名清理"
  fi
}

start_bg() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "RVC 服务已经在跑（pid $(cat "$PID_FILE")）"
    return 0
  fi
  # 环境变量由 rvc_server.py 自己兜底设，这里不用重复——
  # 但 OMP_NUM_THREADS=1 尤其重要：faiss 的 IndexIVFFlat 多线程会 segfault
  cd "$APP_DIR"
  RVC_PORT="$PORT" nohup "$PY" rvc_server.py > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "RVC 服务启动中（pid $(cat "$PID_FILE")，端口 ${PORT}，日志 ${LOG_FILE}）"
  # 等就绪：模型加载约 5~25 秒
  for i in $(seq 1 40); do
    sleep 2
    if curl -s --max-time 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null | grep -q '"ok": true'; then
      echo "就绪（约 $((i*2)) 秒）"
      return 0
    fi
  done
  echo "等了 80 秒还没就绪，看看日志：tail -20 $LOG_FILE" >&2
  return 1
}

case "${1:---bg}" in
  --stop) stop ;;
  --bg) start_bg ;;
  "") cd "$APP_DIR"; exec "$PY" rvc_server.py ;;
  *) echo "用法：$0 [--bg|--stop]" >&2; exit 1 ;;
esac
