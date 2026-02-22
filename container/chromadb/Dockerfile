# ChromaDB Server Container for NanoClaw
# Persistent vector database for long-term memory across all agent containers
#
# Build: container build -t nanoclaw-chromadb container/chromadb/
# Run:   container run -d --name nanoclaw-chromadb -p 18200:8000 -v <data_dir>:/data nanoclaw-chromadb

FROM python:3.12-slim

# Install ChromaDB server
RUN pip install --no-cache-dir chromadb

# Data directory (mount from host for persistence)
VOLUME /data

EXPOSE 8000

# Run as non-root
RUN useradd -m -s /bin/bash chromadb
USER chromadb

ENTRYPOINT ["chroma", "run", "--path", "/data", "--host", "0.0.0.0", "--port", "8000"]
