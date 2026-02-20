#!/usr/bin/env python3
"""NanoClaw Memory Search — semantic search over ChromaDB.

Usage:
  memory_search "<query>" [--collection all] [--top-k 5] [--min-score 0.3]
  memory_search "dark mode preference" --collection knowledge --top-k 3

Collections: conversations, knowledge, tasks, all (default)
"""

import argparse
import json
import os
import sys
import urllib.request
from typing import List

import chromadb

CHROMADB_HOST = os.environ.get("CHROMADB_HOST", "192.168.64.1")
CHROMADB_PORT = int(os.environ.get("CHROMADB_PORT", "8000"))
OLLAMA_URL = os.environ.get("OLLAMA_BASE_URL", "http://192.168.64.1:30068")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "nomic-embed-text-v2-moe")

ALL_COLLECTIONS = ["conversations", "knowledge", "tasks"]


def get_embedding(text: str) -> List[float]:
    """Get embedding via Ollama API."""
    data = json.dumps({"model": EMBEDDING_MODEL, "input": text}).encode()
    req = urllib.request.Request(
        f"{OLLAMA_URL}/v1/embeddings",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
        return result["data"][0]["embedding"]


def search_collection(client: chromadb.HttpClient, col_name: str,
                      query_embedding: List[float], top_k: int) -> List[dict]:
    """Search a single collection."""
    try:
        col = client.get_collection(name=col_name)
    except Exception:
        return []

    result = col.query(
        query_embeddings=[query_embedding],
        n_results=top_k,
        include=["documents", "metadatas", "distances"],
    )

    results = []
    ids = result["ids"][0] if result["ids"] else []
    docs = result["documents"][0] if result.get("documents") else []
    metas = result["metadatas"][0] if result.get("metadatas") else []
    dists = result["distances"][0] if result.get("distances") else []

    for i, doc_id in enumerate(ids):
        # ChromaDB cosine distance → similarity
        distance = dists[i] if i < len(dists) else 1.0
        score = 1.0 - distance

        results.append({
            "id": doc_id,
            "collection": col_name,
            "score": round(score, 4),
            "text": docs[i] if i < len(docs) else "",
            "metadata": metas[i] if i < len(metas) else {},
        })

    return results


def search(query: str, collection: str = "all", top_k: int = 5,
           min_score: float = 0.3) -> List[dict]:
    """Search memories across collections."""
    query_embedding = get_embedding(query)
    if not query_embedding:
        return []

    client = chromadb.HttpClient(host=CHROMADB_HOST, port=CHROMADB_PORT)
    collections = ALL_COLLECTIONS if collection == "all" else [collection]
    all_results = []

    for col_name in collections:
        results = search_collection(client, col_name, query_embedding, top_k)
        all_results.extend(results)

    # Filter and sort
    all_results = [r for r in all_results if r["score"] >= min_score]
    all_results.sort(key=lambda x: x["score"], reverse=True)
    return all_results[:top_k]


def main():
    parser = argparse.ArgumentParser(description="Semantic memory search")
    parser.add_argument("query", help="Search query")
    parser.add_argument("--collection", default="all",
                        choices=ALL_COLLECTIONS + ["all"])
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--min-score", type=float, default=0.3)
    parser.add_argument("--json", action="store_true", help="JSON output")
    args = parser.parse_args()

    try:
        results = search(args.query, args.collection, args.top_k, args.min_score)
    except Exception as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        if not results:
            print("No relevant memories found.")
            return
        for r in results:
            tags = r["metadata"].get("tags", "")
            importance = r["metadata"].get("importance", "")
            print(f"[{r['score']}] {r['collection']}/{r['id']}"
                  f"{' tags=' + tags if tags else ''}"
                  f"{' imp=' + str(importance) if importance else ''}")
            print(f"  {r['text'][:200]}")
            print()


if __name__ == "__main__":
    main()
