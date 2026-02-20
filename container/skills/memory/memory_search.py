#!/usr/bin/env python3
"""NanoClaw Memory Search — semantic search over memory files using embeddings.
Uses Ollama-compatible OpenAI API for embeddings (nomic-embed-text-v2-moe).

Usage:
  memory_search.py <query> [--top-k 5] [--min-score 0.3] [--memory-dir /workspace/group]
"""

import argparse
import json
import os
import sys
import hashlib
import urllib.request
from pathlib import Path
from typing import List, Tuple

EMBEDDING_URL = os.environ.get("OLLAMA_BASE_URL", "http://192.168.64.1:30068") + "/v1/embeddings"
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "nomic-embed-text-v2-moe")
CACHE_DIR = "/tmp/memory-embeddings-cache"


def get_embedding(text: str) -> List[float]:
    """Get embedding vector for text via Ollama API."""
    data = json.dumps({"model": EMBEDDING_MODEL, "input": text}).encode()
    req = urllib.request.Request(
        EMBEDDING_URL,
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
            return result["data"][0]["embedding"]
    except Exception as e:
        print(f"Embedding error: {e}", file=sys.stderr)
        return []


def cosine_similarity(a: List[float], b: List[float]) -> float:
    """Compute cosine similarity between two vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def chunk_file(filepath: str, chunk_size: int = 500) -> List[Tuple[str, int, int]]:
    """Split a file into overlapping chunks. Returns (text, start_line, end_line)."""
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except Exception:
        return []

    if not lines:
        return []

    chunks = []
    i = 0
    while i < len(lines):
        end = min(i + chunk_size, len(lines))
        text = "".join(lines[i:end]).strip()
        if text:
            chunks.append((text, i + 1, end))
        i += chunk_size - 50  # 50 line overlap
        if i < 0:
            i = 0
    return chunks


def get_cached_embedding(text: str, cache_dir: str) -> List[float]:
    """Get embedding from cache or compute and cache it."""
    os.makedirs(cache_dir, exist_ok=True)
    text_hash = hashlib.md5(text.encode()).hexdigest()
    cache_file = os.path.join(cache_dir, f"{text_hash}.json")

    if os.path.exists(cache_file):
        try:
            with open(cache_file) as f:
                return json.load(f)
        except Exception:
            pass

    embedding = get_embedding(text)
    if embedding:
        try:
            with open(cache_file, "w") as f:
                json.dump(embedding, f)
        except Exception:
            pass
    return embedding


def find_memory_files(base_dir: str) -> List[str]:
    """Find all markdown files in memory-relevant directories."""
    patterns = [
        "MEMORY.md",
        "memory/**/*.md",
        "conversations/**/*.md",
        "daily/**/*.md",
    ]
    files = []
    base = Path(base_dir)

    # Direct MEMORY.md
    mem_file = base / "MEMORY.md"
    if mem_file.exists():
        files.append(str(mem_file))

    # Memory directory
    for pattern in ["memory", "conversations", "daily"]:
        dir_path = base / pattern
        if dir_path.exists():
            for f in dir_path.rglob("*.md"):
                files.append(str(f))

    return list(set(files))


def search(query: str, base_dir: str, top_k: int = 5, min_score: float = 0.3) -> List[dict]:
    """Search memory files for relevant chunks."""
    query_embedding = get_embedding(query)
    if not query_embedding:
        return []

    files = find_memory_files(base_dir)
    if not files:
        return []

    results = []
    for filepath in files:
        chunks = chunk_file(filepath)
        for text, start_line, end_line in chunks:
            embedding = get_cached_embedding(text, CACHE_DIR)
            if not embedding:
                continue
            score = cosine_similarity(query_embedding, embedding)
            if score >= min_score:
                rel_path = os.path.relpath(filepath, base_dir)
                results.append({
                    "path": rel_path,
                    "startLine": start_line,
                    "endLine": end_line,
                    "score": round(score, 4),
                    "snippet": text[:300],
                })

    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:top_k]


def main():
    parser = argparse.ArgumentParser(description="Semantic memory search")
    parser.add_argument("query", help="Search query")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--min-score", type=float, default=0.3)
    parser.add_argument("--memory-dir", default="/workspace/group")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    results = search(args.query, args.memory_dir, args.top_k, args.min_score)

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        if not results:
            print("No relevant memories found.")
            return
        for r in results:
            print(f"[{r['score']}] {r['path']}#L{r['startLine']}-L{r['endLine']}")
            print(f"  {r['snippet'][:150]}...")
            print()


if __name__ == "__main__":
    main()
