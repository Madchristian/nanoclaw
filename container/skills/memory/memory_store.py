#!/usr/bin/env python3
"""NanoClaw Memory Store — store text + metadata in ChromaDB.

Usage:
  memory_store <collection> "<text>" [--tags tag1,tag2] [--source session] [--importance 0.5]
  memory_store conversations "User prefers dark mode" --tags preferences --importance 0.8

Collections: conversations, knowledge, tasks
"""

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request
from typing import List

import chromadb

CHROMADB_HOST = os.environ.get("CHROMADB_HOST", "192.168.64.1")
CHROMADB_PORT = int(os.environ.get("CHROMADB_PORT", "8000"))
EMBED_URL = os.environ.get("EMBED_URL", f"http://{CHROMADB_HOST}:8001")

VALID_COLLECTIONS = {"conversations", "knowledge", "tasks"}


def get_embedding(text: str) -> List[float]:
    """Get embedding via local embedding service (runs in ChromaDB container)."""
    data = json.dumps({"text": text}).encode()
    req = urllib.request.Request(
        f"{EMBED_URL}/embed",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read())
        return result["embedding"]


def store(collection: str, text: str, tags: str = "", source: str = "",
          importance: float = 0.5) -> dict:
    """Store a memory in ChromaDB."""
    if collection not in VALID_COLLECTIONS:
        raise ValueError(f"Invalid collection: {collection}. Use: {VALID_COLLECTIONS}")

    # Generate deterministic ID from content
    doc_id = hashlib.sha256(text.encode()).hexdigest()[:16]

    # Get embedding
    embedding = get_embedding(text)

    # Build metadata
    metadata = {
        "timestamp": int(time.time()),
        "importance": importance,
    }
    if tags:
        metadata["tags"] = tags
    if source:
        metadata["source"] = source

    # Connect to ChromaDB
    client = chromadb.HttpClient(host=CHROMADB_HOST, port=CHROMADB_PORT)
    col = client.get_or_create_collection(
        name=collection,
        metadata={"hnsw:space": "cosine"},
    )

    # Upsert document
    col.upsert(
        ids=[doc_id],
        documents=[text],
        embeddings=[embedding],
        metadatas=[metadata],
    )

    return {"id": doc_id, "collection": collection, "stored": True}


def main():
    parser = argparse.ArgumentParser(description="Store memory in ChromaDB")
    parser.add_argument("collection", choices=sorted(VALID_COLLECTIONS))
    parser.add_argument("text", help="Text to store")
    parser.add_argument("--tags", default="", help="Comma-separated tags")
    parser.add_argument("--source", default="", help="Source (session/channel)")
    parser.add_argument("--importance", type=float, default=0.5,
                        help="Importance 0.0-1.0")
    parser.add_argument("--json", action="store_true", help="JSON output")
    args = parser.parse_args()

    try:
        result = store(args.collection, args.text, args.tags, args.source,
                       args.importance)
        if args.json:
            print(json.dumps(result, indent=2))
        else:
            print(f"✅ Stored in '{result['collection']}' (id: {result['id']})")
    except Exception as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
