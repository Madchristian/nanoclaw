#!/bin/bash
# Start ChromaDB + Embedding Service in parallel
set -e

echo "🧠 Starting Embedding Service on :8001..."
uvicorn embed_service:app --host 0.0.0.0 --port 8001 --app-dir /app &

echo "🗄️  Starting ChromaDB on :8000..."
exec chroma run --path /data --host 0.0.0.0 --port 8000
