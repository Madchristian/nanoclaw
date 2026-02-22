# Memory Skill — ChromaDB Long-Term Memory

Persistent semantic memory shared across all NanoClaw containers.

## Commands

### Store a memory
```bash
memory_store <collection> "<text>" [--tags tag1,tag2] [--source channel] [--importance 0.8]
```

### Search memories
```bash
memory_search "<query>" [--collection all] [--top-k 5] [--min-score 0.3]
```

### List collections/entries
```bash
memory_list                    # Show all collections
memory_list <collection>       # Show entries in collection
```

## Collections

| Collection | Use for |
|---|---|
| `conversations` | Important conversation snippets, decisions, user context |
| `knowledge` | Learned facts: infrastructure, people, preferences |
| `tasks` | Completed tasks, results, lessons learned |

## When to Store

- User states a preference → `knowledge` (importance: 0.8)
- Important decision made → `conversations` (importance: 0.7)
- Task completed with lessons → `tasks` (importance: 0.6)
- Interesting fact learned → `knowledge` (importance: 0.5)

## When to Search

- Before answering questions about past interactions
- When user says "remember when..." or "we talked about..."
- When context about preferences or past decisions would help

## Tips

- Use `--json` flag for machine-readable output
- Tags help with filtering: `--tags infrastructure,kubernetes`
- Source tracks where info came from: `--source discord`
- ChromaDB runs in a dedicated Apple Container (IP injected via `CHROMADB_HOST` env)
- Embeddings via Ollama `nomic-embed-text-v2-moe` on `192.168.64.1:30068`
