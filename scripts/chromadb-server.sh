#!/bin/bash
# ChromaDB Server — persistent vector database in Apple Container
#
# Usage:
#   ./chromadb-server.sh start   — Build (if needed) + start ChromaDB container
#   ./chromadb-server.sh stop    — Stop ChromaDB container
#   ./chromadb-server.sh status  — Check if running
#   ./chromadb-server.sh logs    — Show container logs
#   ./chromadb-server.sh rebuild — Force rebuild image
#
# Container publishes port 18200 on host → 8000 inside container
# Agent containers reach it via 192.168.64.1:18200
# Data persisted at: data/chromadb/ (host-mounted volume)

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$PROJECT_DIR/data/chromadb"
IMAGE_NAME="nanoclaw-chromadb"
CONTAINER_NAME="nanoclaw-chromadb"
HOST_PORT=18200
CONTAINER_PORT=8000
# File where ChromaDB container IP is stored for other containers to discover
CHROMADB_IP_FILE="$PROJECT_DIR/data/chromadb-ip.txt"

build_image() {
  local dockerfile_dir="$PROJECT_DIR/container/chromadb"
  
  # Check if image exists
  if [ "${1:-}" != "force" ] && container image ls 2>/dev/null | grep -q "$IMAGE_NAME"; then
    echo "⏭️  Image $IMAGE_NAME already exists (use 'rebuild' to force)"
    return
  fi

  echo "🔨 Building ChromaDB image..."
  container build -t "$IMAGE_NAME" "$dockerfile_dir"
  echo "✅ Image built: $IMAGE_NAME"
}

start_server() {
  mkdir -p "$DATA_DIR"

  # Check if already running
  if container list 2>/dev/null | grep -q "$CONTAINER_NAME"; then
    echo "⏭️  ChromaDB container already running"
    status_server
    return
  fi

  # Remove stopped container with same name (if exists)
  container rm "$CONTAINER_NAME" 2>/dev/null || true

  # Build image if needed
  build_image

  echo -n "🧠 Starting ChromaDB container (host:$HOST_PORT → container:$CONTAINER_PORT)... "
  container run -d \
    --name "$CONTAINER_NAME" \
    -p "$HOST_PORT:$CONTAINER_PORT" \
    -v "$DATA_DIR:/data" \
    "$IMAGE_NAME"

  echo ""

  # Get container IP and write to discovery file
  sleep 2
  CONTAINER_IP=$(container inspect "$CONTAINER_NAME" 2>/dev/null | grep -o '"addr":"[^"]*"' | head -1 | sed 's/"addr":"//;s/\/.*//;s/"//')
  if [ -n "$CONTAINER_IP" ]; then
    echo "$CONTAINER_IP" > "$CHROMADB_IP_FILE"
    echo "📍 ChromaDB IP: $CONTAINER_IP (saved to $CHROMADB_IP_FILE)"
  fi

  # Wait for ready (use container IP directly, port-forwarding is unreliable)
  echo -n "⏳ Waiting for ChromaDB... "
  for i in $(seq 1 30); do
    if curl -sf "http://${CONTAINER_IP:-localhost}:$CONTAINER_PORT/api/v2/heartbeat" >/dev/null 2>&1; then
      echo "🟢 Ready!"
      return
    fi
    sleep 1
  done
  echo "⚠️  Still starting (check: $0 logs)"
}

stop_server() {
  if container list 2>/dev/null | grep -q "$CONTAINER_NAME"; then
    echo "🛑 Stopping ChromaDB container..."
    container stop "$CONTAINER_NAME"
    container rm "$CONTAINER_NAME" 2>/dev/null || true
    echo "✅ Stopped"
  else
    echo "ChromaDB container not running."
    container rm "$CONTAINER_NAME" 2>/dev/null || true
  fi
}

status_server() {
  if container list 2>/dev/null | grep -q "$CONTAINER_NAME"; then
    echo "✅ ChromaDB container running"
    container list 2>/dev/null | grep "$CONTAINER_NAME"
    
    CONTAINER_IP=""
    [ -f "$CHROMADB_IP_FILE" ] && CONTAINER_IP=$(cat "$CHROMADB_IP_FILE")
    
    if [ -n "$CONTAINER_IP" ]; then
      echo ""
      echo "📍 Container IP: $CONTAINER_IP"
      if curl -sf "http://$CONTAINER_IP:$CONTAINER_PORT/api/v2/heartbeat" 2>/dev/null; then
        echo ""
        echo "🟢 API responding"
      else
        echo "⚠️  API not responding"
      fi
    fi
  else
    echo "❌ ChromaDB container not running"
  fi
}

show_logs() {
  container logs "$CONTAINER_NAME" 2>&1 || echo "No logs (container not found)"
}

case "${1:-status}" in
  start)   start_server ;;
  stop)    stop_server ;;
  status)  status_server ;;
  logs)    show_logs ;;
  rebuild) build_image force && stop_server && start_server ;;
  *)       echo "Usage: $0 {start|stop|status|logs|rebuild}" ;;
esac
