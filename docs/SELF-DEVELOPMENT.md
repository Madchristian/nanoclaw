# NanoClaw Self-Development Guide

## Das Problem
NanoClaw (Claw Jr.) läuft in einem Apple Container. Er kann seinen eigenen Code nicht direkt ändern, weil:
1. Der **Host-Prozess** (Node.js, `src/` → `dist/`) läuft AUSSERHALB des Containers
2. Das **Container-Image** muss von außen gebaut werden (`container/build.sh`)
3. Die **MCP-Tools** sind im Image eingebacken
4. Die **Bridges** werden vom Host gestartet

## Architektur-Übersicht

```
Mac mini Host (macOS)
├── NanoClaw Host Process (Node.js)
│   ├── src/index.ts          — Message Loop, Container-Management
│   ├── src/channels/discord.ts — Discord Bot
│   ├── src/ipc.ts            — IPC Handler (Messages, Tasks, Voice)
│   ├── src/container-runner.ts — Container Lifecycle
│   └── src/db.ts             — SQLite (Tasks, State)
│
├── Container Image (nanoclaw-agent:latest)
│   ├── agent-runner/src/index.ts     — Claude Code SDK Runner
│   ├── agent-runner/src/ipc-mcp-stdio.ts — MCP Tools
│   ├── skills/tts/tts.sh            — Text-to-Speech
│   ├── skills/stt/stt.py            — Speech-to-Text
│   └── skills/memory/memory_search.py — Embedding Search
│
├── Groups (mounted into container as /workspace/group)
│   ├── owner-dm/CLAUDE.md, MEMORY.md, daily/, memory/
│   ├── dirty-bot-talk/CLAUDE.md, MEMORY.md
│   └── global/CLAUDE.md
│
├── Scripts (Host-only)
│   ├── nanoclaw-bridge.sh    — socat Bridges
│   └── (future: osascript bridge, etc.)
│
└── Data
    ├── sessions/             — Claude Code Sessions (.claude/)
    ├── ipc/                  — IPC Directories per Group
    └── nanoclaw.db           — SQLite Database
```

## Was NanoClaw selbst ändern kann (im Container)
- ✅ CLAUDE.md, MEMORY.md, daily notes — Workspace-Dateien
- ✅ conversations/ — Archivierte Transkripte  
- ✅ Dateien in /workspace/group/ — alles was gemountet ist
- ✅ Claude Code Settings (.claude/settings.json) — Subagents, Env-Vars

## Was NanoClaw NICHT selbst ändern kann
- ❌ Host-Prozess (src/*.ts) — läuft außerhalb
- ❌ Container-Image — muss von außen gebaut werden
- ❌ MCP-Tools — im Image eingebacken
- ❌ Bridges — werden vom Host gestartet
- ❌ Launchd-Services — Host-Level

## Wie NanoClaw trotzdem weiterentwickelt werden kann

### Option 1: Christian baut von außen (aktuell)
Christian oder Claw (OpenClaw) editieren Code, bauen Image, restarten.

### Option 2: Claude Code CLI auf dem Host
NanoClaw könnte einen IPC-Request an den Host schicken:
```json
{"type": "rebuild", "reason": "new MCP tool needed"}
```
Ein Host-Watcher könnte dann:
1. `npm run build` (Host-Prozess)
2. `container/build.sh` (Container-Image)
3. NanoClaw restarten

### Option 3: Hot-Reload für MCP-Tools
Die MCP-Tools (ipc-mcp-stdio.ts) werden beim Container-Start kompiliert.
Da `agent-runner/src/` als readonly Mount reinkommt, könnte man:
- Neue Tool-Definitionen als JSON/Config statt TypeScript
- Ein Plugin-System das `.js` Files zur Laufzeit lädt

### Option 4: Self-Hosted Git + CI
NanoClaw pusht Code-Änderungen in ein Git-Repo.
Ein CI-Runner (auf dem Host) baut automatisch Image + restartet.

## Was noch fehlt (Feature-Gaps)

### Fehlt — braucht Host-Bridge
- [ ] **Email** — himalaya auf Host, Bridge per IPC
- [ ] **Apple Calendar** — osascript Bridge
- [ ] **Apple Reminders** — remindctl Bridge
- [ ] **GitHub CLI** — gh auf Host oder im Container (braucht Auth)

### Fehlt — braucht Container-Image-Update
- [ ] **kubectl** im Container (aktuell nur via Bridge, kein CLI)
- [ ] **Neue MCP-Tools** (jede Erweiterung = Image rebuild)

### Fehlt — Architektur
- [ ] **Self-Rebuild Mechanism** — IPC-basierter Rebuild-Trigger
- [ ] **Hot-Reload für Tools** — Plugin-System statt hardcoded TypeScript
- [ ] **Health-Check** — Host überwacht Container, Auto-Restart bei Crash
- [ ] **Log-Aggregation** — Container-Logs persistent auf Host

## Empfehlung: Nächste Schritte

1. **IPC-basierter osascript-Bridge** — Kalender + Reminders sofort nutzbar
2. **Self-Rebuild IPC** — NanoClaw kann eigenes Image-Rebuild triggern
3. **Email im Container** — himalaya installieren (IMAP geht über Netzwerk)
4. **Plugin-System für MCP-Tools** — neue Tools ohne Image-Rebuild

---
*Erstellt: 2026-02-19 von Claw 🐾*
