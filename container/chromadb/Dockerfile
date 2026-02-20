# ChromaDB Server + Embedding Service for NanoClaw
# Persistent vector database with local embeddings — NO Ollama dependency
#
# Build: container build -t nanoclaw-chromadb container/chromadb/
# Run:   container run -d --name nanoclaw-chromadb -p 18200:8000 -p 18201:8001 -v <data_dir>:/data nanoclaw-chromadb

FROM python:3.12-slim

# Install PyTorch CPU-only first (smaller), then sentence-transformers + ChromaDB + FastAPI
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu && \
    pip install --no-cache-dir chromadb sentence-transformers fastapi 'uvicorn[standard]'

# Pre-download and cache the embedding model at build time
RUN python3 -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('nomic-ai/nomic-embed-text-v2-moe', trust_remote_code=True)"

# Copy embedding service and startup script
COPY embed_service.py /app/embed_service.py
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Data directory (mount from host for persistence)
VOLUME /data

EXPOSE 8000 8001

# Run as non-root
RUN useradd -m -s /bin/bash chromadb
USER chromadb

ENTRYPOINT ["/app/start.sh"]
