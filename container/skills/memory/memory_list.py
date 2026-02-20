#!/usr/bin/env python3
"""NanoClaw Memory List — list collections and their contents.

Usage:
  memory_list                    — List all collections with counts
  memory_list <collection>       — List entries in a collection
  memory_list knowledge --limit 10
"""

import argparse
import json
import os
import sys

import chromadb

CHROMADB_HOST = os.environ.get("CHROMADB_HOST", "192.168.64.1")
CHROMADB_PORT = int(os.environ.get("CHROMADB_PORT", "8000"))


def list_collections():
    """List all collections with document counts."""
    client = chromadb.HttpClient(host=CHROMADB_HOST, port=CHROMADB_PORT)
    cols = client.list_collections()

    if not cols:
        print("No collections found.")
        return

    print(f"{'Collection':<20} {'Documents':<10}")
    print("-" * 30)
    for col in cols:
        name = col.name if hasattr(col, 'name') else str(col)
        count = col.count() if hasattr(col, 'count') else client.get_collection(name=name).count()
        print(f"{name:<20} {count:<10}")


def list_entries(collection: str, limit: int = 20):
    """List entries in a collection."""
    client = chromadb.HttpClient(host=CHROMADB_HOST, port=CHROMADB_PORT)

    try:
        col = client.get_collection(name=collection)
    except Exception:
        print(f"Collection '{collection}' not found.")
        return

    result = col.get(
        limit=limit,
        include=["documents", "metadatas"],
    )

    if not result["ids"]:
        print(f"No entries in '{collection}'.")
        return

    for i, doc_id in enumerate(result["ids"]):
        doc = result["documents"][i] if result.get("documents") else ""
        meta = result["metadatas"][i] if result.get("metadatas") else {}
        tags = meta.get("tags", "")
        imp = meta.get("importance", "")
        print(f"[{doc_id}]{' tags=' + tags if tags else ''}"
              f"{' imp=' + str(imp) if imp else ''}")
        print(f"  {doc[:200]}")
        print()


def main():
    parser = argparse.ArgumentParser(description="List ChromaDB collections/entries")
    parser.add_argument("collection", nargs="?", help="Collection name")
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()

    try:
        if args.collection:
            list_entries(args.collection, args.limit)
        else:
            list_collections()
    except Exception as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
