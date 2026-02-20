"""Lightweight embedding service using sentence-transformers.

Runs alongside ChromaDB in the same container.
POST /embed {"text": "..."} → {"embedding": [...]}
POST /embed {"texts": ["...", "..."]} → {"embeddings": [[...], [...]]}
GET  /health → {"status": "ok", "model": "..."}
"""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

MODEL_NAME = os.environ.get("EMBEDDING_MODEL", "nomic-ai/nomic-embed-text-v2-moe")

_model = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model
    from sentence_transformers import SentenceTransformer
    _model = SentenceTransformer(MODEL_NAME, trust_remote_code=True)
    yield


app = FastAPI(title="NanoClaw Embedding Service", lifespan=lifespan)


class EmbedRequest(BaseModel):
    text: str | None = None
    texts: list[str] | None = None


class EmbedResponse(BaseModel):
    embedding: list[float] | None = None
    embeddings: list[list[float]] | None = None


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME}


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest):
    if req.text is None and req.texts is None:
        raise HTTPException(400, "Provide 'text' or 'texts'")

    if req.text is not None:
        vec = _model.encode(req.text, normalize_embeddings=True)
        return EmbedResponse(embedding=vec.tolist())

    if req.texts is not None:
        vecs = _model.encode(req.texts, normalize_embeddings=True)
        return EmbedResponse(embeddings=[v.tolist() for v in vecs])
