# Multi-Agent Architecture — NanoClaw

## Überblick

NanoClaw kann mehrere Agent-Container parallel spawnen für komplexe Tasks.
Jeder Sub-Agent läuft isoliert, hat eingeschränkte Permissions und liefert
Ergebnisse über Shared Memory (ChromaDB) oder IPC zurück.

## Architektur

```
User Message → Host-Prozess (Orchestrator)
                    │
                    ├── Analyse: "Was wird gebraucht?"
                    │
                    ├── spawn() ──→ Agent A (STT/Voice)
                    ├── spawn() ──→ Agent B (Claude Reasoning)
                    ├── spawn() ──→ Agent C (HA Actions)
                    └── spawn() ──→ Agent D (TTS Response)
                    │
                    ├── Collect Results (IPC / ChromaDB)
                    └── Deliver Response
```

## Container-Typen

### 1. Full Agent (Standard)
- Claude Code mit allen Skills
- Kann lesen/schreiben, Bash, Browser
- Für komplexe Aufgaben

### 2. Worker Agent (Leichtgewicht)
- Kein Claude Code, nur ein Script
- Startet, führt aus, liefert Ergebnis
- Für STT, TTS, API-Calls

### 3. Orchestrator Agent
- Koordiniert andere Agents
- Wartet auf Ergebnisse, merged Output
- Entscheidet nächste Schritte

## IPC-Mechanismus

```
/workspace/ipc/
├── tasks/
│   ├── <task-id>.request.json    # Orchestrator → Worker
│   └── <task-id>.result.json     # Worker → Orchestrator
├── messages/
│   └── <group>/outgoing.jsonl    # Nachrichten nach außen
└── shared/
    └── context.json              # Geteilter Kontext zwischen Agents
```

### Task Format
```json
{
  "id": "task-abc123",
  "type": "stt|tts|reasoning|action",
  "input": { ... },
  "timeout_ms": 30000,
  "spawned_at": "2026-02-20T20:00:00Z"
}
```

### Result Format
```json
{
  "id": "task-abc123",
  "status": "ok|error",
  "output": { ... },
  "duration_ms": 1234,
  "completed_at": "2026-02-20T20:00:01Z"
}
```

## Voice Pipeline (Multi-Agent)

```
┌────────┐    ┌──────────┐    ┌───────────┐    ┌─────────┐
│  Audio │───→│ STT Agent│───→│ Think Agent│───→│TTS Agent│───→ Audio Out
│  Input │    │ (Whisper) │    │  (Claude)  │    │(ElevenL)│
└────────┘    └──────────┘    └───────────┘    └─────────┘
                                    │
                              ┌─────┴─────┐
                              │ HA Actions │ (parallel)
                              │   Agent    │
                              └───────────┘
```

### Latenz-Budget (Ziel: <3s End-to-End)
| Phase | Target | Methode |
|-------|--------|---------|
| STT | <500ms | faster-whisper, lokales Modell |
| Routing | <50ms | Host-Prozess |
| Think | <1500ms | Claude Haiku (schnell) |
| TTS | <800ms | Edge-TTS oder ElevenLabs Streaming |
| Total | <2850ms | 🔥 |

## Safety & Isolation

### Permissions pro Agent-Typ
| Capability | Full | Worker | Orchestrator |
|------------|------|--------|-------------|
| Bash | ✅ | ❌ | ❌ |
| Network (Bridge) | ✅ | eingeschränkt | ❌ |
| File Write | ✅ | /workspace/ipc only | /workspace/ipc only |
| ChromaDB | ✅ | Read-only | Read/Write |
| Claude Code | ✅ | ❌ | ✅ |

### Kill-Switch
- Jeder Agent hat einen Timeout (default 60s, configurable)
- Host kann jeden Container jederzeit killen
- Orphan-Cleanup beim Restart (außer PROTECTED_CONTAINERS)

## Implementation Plan

### Phase 1: Parallel Container Spawning
- [ ] `container-runner.ts`: `spawnParallel(tasks[])` Methode
- [ ] Task-basiertes IPC (request/result JSON files)
- [ ] Timeout + Cleanup pro Task
- [ ] Result-Collector im Host

### Phase 2: Voice Pipeline
- [ ] Worker-Container Image (klein, nur STT/TTS)
- [ ] Audio-Input über Discord Voice oder WebSocket
- [ ] STT Worker: Audio → Text
- [ ] TTS Worker: Text → Audio
- [ ] Streaming TTS (chunks statt warten auf ganzes Audio)

### Phase 3: Smart Orchestration
- [ ] Orchestrator-Agent der Tasks plant
- [ ] Dependency-Graph (A muss vor B fertig sein)
- [ ] Parallel wo möglich, sequential wo nötig
- [ ] Error-Handling: Agent stirbt → Retry oder Fallback

---
*Erstellt: 2026-02-20 von Claw 🐾*
