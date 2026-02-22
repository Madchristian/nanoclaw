# NanoClaw v2 — Migration: Apple Container → Tart macOS VM

## Vision
NanoClaw zieht um von einem Linux-Container (Apple Containers) in eine **vollwertige macOS VM** (Tart). Dadurch bekommt er Metal GPU, Neural Engine, native macOS APIs — bei gleichzeitiger Sandbox-Isolation. Christian kontrolliert alle Ein-/Ausgänge.

## Warum macOS VM statt Linux Container?
- ✅ **Metal GPU** — whisper-cpp, MLX, lokale LLMs mit Hardware-Beschleunigung
- ✅ **Neural Engine** — CoreML Modelle
- ✅ **Native macOS APIs** — Calendar (osascript), Reminders (remindctl), Keychain
- ✅ **Homebrew** — gleiche Tools wie auf dem Host
- ✅ **Sandbox** — isoliert, kontrollierter Netzwerk-/Dateizugriff
- ✅ **Snapshots** — VM-State sichern/wiederherstellen in Sekunden
- ❌ Mehr Ressourcen (~4-8 GB RAM, ~30-40 GB Disk)

## Architektur

```
┌──────────────────────────────────────┐
│  Tart macOS VM (NanoClaw)            │
│  macOS Sequoia, User: claw           │
│                                      │
│  ├─ Claude Code (Agent)              │
│  ├─ NanoClaw Host Process (Node.js)  │
│  ├─ whisper-cpp (Metal GPU) 🚀       │
│  ├─ edge-tts / say (TTS)             │
│  ├─ Homebrew Tools                   │
│  ├─ himalaya (Email)                 │
│  ├─ gh CLI (GitHub)                  │
│  ├─ remindctl, osascript             │
│  └─ MCP Server (IPC Tools)           │
│                                      │
│  Netzwerk: Softnet (isoliert)        │
│  Mounts: --dir (readonly/rw)         │
└──────────┬───────────────────────────┘
           │ Softnet + socat Bridges
┌──────────▼───────────────────────────┐
│  Host (Mac mini M4)                  │
│                                      │
│  Bridges (Christian kontrolliert):   │
│  ├─ :18443 → Vaultwarden            │
│  ├─ :18123 → Home Assistant          │
│  ├─ :16443 → Kubernetes API          │
│  ├─ :18022 → TrueNAS SSH             │
│  └─ Internet (gefiltert via pf)      │
│                                      │
│  Mounts:                             │
│  ├─ workspace/groups → :ro           │
│  ├─ data/ipc → :rw                   │
│  └─ memory/shared → :rw              │
│                                      │
│  Launchd: com.nanoclaw.vm            │
│  Monitoring: tart ip, ssh health     │
└──────────────────────────────────────┘
```

---

## Phase 0 — Grundlagen & Tart Setup
> Ziel: macOS VM läuft, SSH-Zugang, Basis-Tools installiert

- [ ] `brew install cirruslabs/cli/tart` auf Mac mini
- [ ] `tart clone ghcr.io/cirruslabs/macos-sequoia-base:latest nanoclaw-vm`
- [ ] VM konfigurieren: `tart set nanoclaw-vm --cpu 4 --memory 8192 --disk-size 50`
- [ ] Erster Start: `tart run nanoclaw-vm` (GUI für initiales Setup)
- [ ] User `claw` einrichten (admin, SSH, Auto-Login)
- [ ] SSH-Key vom Host in VM: `ssh-copy-id claw@$(tart ip nanoclaw-vm)`
- [ ] Basis-Tools in VM installieren:
  - Homebrew
  - Node.js 22 (nvm oder brew)
  - Python 3, pip
  - git, curl, jq
  - ffmpeg
- [ ] Headless-Start testen: `tart run --no-graphics nanoclaw-vm`
- [ ] Launchd-Service erstellen: `com.nanoclaw.vm.plist` (VM Auto-Start)
- [ ] Snapshot erstellen: `tart clone nanoclaw-vm nanoclaw-vm-base` (Backup)

**Deliverable:** VM startet headless, SSH-Zugang funktioniert, Basis-Tools da

---

## Phase 1 — Netzwerk-Isolation & Bridges
> Ziel: VM ist netzwerk-isoliert, nur explizite Services erreichbar

- [ ] Softnet-Modus testen: `tart run --net-softnet nanoclaw-vm`
- [ ] VM-IP ermitteln und Bridge-Script anpassen
- [ ] socat Bridges konfigurieren (Host → Services):
  - Vaultwarden (:18443)
  - Home Assistant (:18123)
  - Kubernetes API (:16443)
  - TrueNAS SSH (:18022)
- [ ] DNS innerhalb VM konfigurieren (oder /etc/hosts)
- [ ] Internet-Zugang: Entscheidung treffen
  - **Option A:** Kein Internet, alles über Bridges (maximale Isolation)
  - **Option B:** Gefilterter Internet-Zugang via pf (für npm, pip, API calls)
  - **Option C:** Internet nur für bestimmte Domains (allowlist)
- [ ] pf-Firewall-Regeln auf Host (falls Option B/C)
- [ ] Bridge-Monitoring (welche Verbindungen laufen)
- [ ] Launchd-Service für Bridges: `com.nanoclaw.bridges.plist`

**Deliverable:** VM hat nur Zugriff auf freigegebene Services, alles andere geblockt

---

## Phase 2 — NanoClaw Host Process Migration
> Ziel: NanoClaw-Prozess läuft in der VM statt auf dem Host

- [ ] NanoClaw-Repo in die VM klonen (oder als Mount)
- [ ] Entscheidung: Agent direkt in VM oder weiterhin Container-in-VM?
  - **Empfehlung:** Direkt in VM — die VM IST die Sandbox
- [ ] Claude Code in VM installieren (npm global)
- [ ] NanoClaw Host Process (Node.js) in VM starten
- [ ] Discord Bot Token sicher in VM bringen (Vaultwarden → VM)
- [ ] Anthropic API Key sicher in VM bringen
- [ ] IPC-Architektur anpassen:
  - Alt: Container ↔ Host via mounted /workspace/ipc
  - Neu: Alles in der VM, oder VM ↔ Host via shared mount
- [ ] `.env` und Secrets-Management in der VM
- [ ] Launchd-Service in VM: NanoClaw Auto-Start
- [ ] Logging: VM-Logs zugänglich vom Host (Mount oder SSH)

**Deliverable:** NanoClaw läuft komplett in der macOS VM

---

## Phase 3 — Native macOS Skills
> Ziel: Skills die vorher unmöglich waren (osascript, Metal, etc.)

- [ ] **whisper-cpp** mit Metal GPU installieren (brew)
  - STT direkt in VM statt Container-CPU → ~5-10x schneller
- [ ] **Apple Calendar** (osascript) — Termine lesen/schreiben
- [ ] **Apple Reminders** (remindctl) — Listen verwalten
- [ ] **edge-tts** oder **macOS `say`** für TTS
- [ ] **himalaya** für Email (IMAP/SMTP)
- [ ] **gh CLI** für GitHub
- [ ] **kubectl** in VM (via Bridge zum API Server)
- [ ] **Home Assistant** Script (ha_api.sh) in VM
- [ ] MLX/CoreML Modelle evaluieren (lokale LLMs als Fallback?)

**Deliverable:** NanoClaw hat Feature-Parität mit Claw (OpenClaw)

---

## Phase 4 — Härtung & Monitoring
> Ziel: Produktionsreif, selbstheilend, überwacht

- [ ] VM Health-Check Script (SSH ping, Prozess-Check)
- [ ] Auto-Restart bei Crash (Launchd keepalive)
- [ ] Snapshot-Rotation (täglicher Snapshot, 7 aufbewahren)
- [ ] Resource-Monitoring (CPU, RAM, Disk in der VM)
- [ ] Log-Aggregation (VM-Logs → Host)
- [ ] Alerting bei Problemen (Discord-Nachricht an Christian)
- [ ] Firewall-Audit: Regelmäßig prüfen was die VM macht
- [ ] Update-Strategie: macOS Updates in der VM
- [ ] Backup-Strategie: VM-Image + Daten

**Deliverable:** Robust, selbstheilend, auditierbar

---

## Phase 5 — Cutover & Abschaltung alter Container
> Ziel: Alter Apple Container wird abgelöst

- [ ] Parallel-Betrieb: Beide Systeme laufen, Ergebnisse vergleichen
- [ ] Memory-Migration: SOUL.md, MEMORY.md, daily notes übertragen
- [ ] Discord-Bot: Token von altem auf neues System umziehen
- [ ] Scheduled Tasks migrieren
- [ ] Alten Apple Container stoppen
- [ ] Altes Container-Image archivieren (falls Rollback nötig)
- [ ] contingency-plan.md aktualisieren
- [ ] Dokumentation finalisieren

**Deliverable:** NanoClaw v2 ist live, alter Container ist Geschichte

---

## Offene Entscheidungen (mit Christian klären)
1. **RAM:** 4 GB oder 8 GB für die VM? (8 GB empfohlen für whisper + Claude Code)
2. **Internet:** Komplett isoliert oder gefiltert? (gefiltert empfohlen für npm/pip/APIs)
3. **Agent-Architektur:** Claude Code direkt oder weiterhin Container-in-VM?
4. **Disk:** 30 GB oder 50 GB? (50 GB empfohlen für Whisper-Modelle + Homebrew)
5. **DNS:** eigener DNS in VM oder hosts-Datei?
6. **Rescue-Bot:** Auch in eigener VM oder bleibt der auf dem Host?

## Ressourcen
- Tart Docs: https://tart.run
- Tart GitHub: https://github.com/cirruslabs/tart
- NanoClaw Repo: `/Users/christian/.openclaw/workspace/projects/nanoclaw/`
- Contingency Plan: `memory/shared/contingency-plan.md`

---
*Erstellt: 2026-02-19 von Claw 🐾*
