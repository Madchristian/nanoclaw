#!/bin/bash
# NanoClaw Network Bridge — socat forwards from container gateway to internal services
# Bind address: 192.168.64.1 (container gateway, not exposed to LAN)
#
# Usage:
#   ./nanoclaw-bridge.sh start   — Start all bridges
#   ./nanoclaw-bridge.sh stop    — Stop all bridges
#   ./nanoclaw-bridge.sh status  — Show running bridges
#
# Services:
#   18443 → Vaultwarden (bitwarden.cstrube.de:443)
#   18022 → TrueNAS SSH (10.0.30.20:22)
#   18123 → Home Assistant (10.0.30.5:8123)
#   16443 → Kubernetes API (first reachable CP node:6443)

set -eo pipefail

BIND_IP="192.168.64.1"
PIDDIR="/tmp/nanoclaw-bridge"

# name:listen_port:target_host:target_port
BRIDGES="
vaultwarden:18443:bitwarden.cstrube.de:443
ssh-truenas:18022:10.0.30.20:22
homeassistant:18123:10.0.30.5:8123
kubectl:16443:10.0.40.100:6443
ollama:30068:10.0.40.20:30068
"

start_bridges() {
  mkdir -p "$PIDDIR"

  start_one() {
    local name="$1" listen_port="$2" target_host="$3" target_port="$4"
    local pidfile="$PIDDIR/$name.pid"

    if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      echo "⏭️  $name already running (pid $(cat "$pidfile"))"
      return
    fi

    echo -n "🔗 Starting $name ($BIND_IP:$listen_port → $target_host:$target_port)... "
    socat "TCP-LISTEN:$listen_port,bind=$BIND_IP,fork,reuseaddr" \
          "TCP:$target_host:$target_port" &
    echo $! > "$pidfile"
    echo "✅ (pid $!)"
  }

  echo "$BRIDGES" | while IFS=: read -r name listen_port target_host target_port; do
    [ -z "$name" ] && continue
    start_one "$name" "$listen_port" "$target_host" "$target_port"
  done

  echo ""
  echo "All bridges started. Container can reach services via $BIND_IP."
}

stop_bridges() {
  if [ ! -d "$PIDDIR" ]; then
    echo "No bridges running."
    return
  fi

  for pidfile in "$PIDDIR"/*.pid; do
    [ -f "$pidfile" ] || continue
    name=$(basename "$pidfile" .pid)
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      echo "🛑 Stopping $name (pid $pid)"
      kill "$pid"
    fi
    rm -f "$pidfile"
  done

  echo "All bridges stopped."
}

status_bridges() {
  if [ ! -d "$PIDDIR" ]; then
    echo "No bridges configured."
    return
  fi

  echo "NanoClaw Bridge Status:"
  echo "========================"
  echo "$BRIDGES" | while IFS=: read -r name listen_port target_host target_port; do
    [ -z "$name" ] && continue
    pidfile="$PIDDIR/$name.pid"
    if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      echo "  ✅ $name — $BIND_IP:$listen_port → $target_host:$target_port (pid $(cat "$pidfile"))"
    else
      echo "  ❌ $name — not running"
    fi
  done
}

case "${1:-status}" in
  start)  start_bridges ;;
  stop)   stop_bridges ;;
  status) status_bridges ;;
  *)      echo "Usage: $0 {start|stop|status}" ;;
esac
