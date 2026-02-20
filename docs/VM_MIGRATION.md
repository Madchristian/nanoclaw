# NanoClaw VM Migration — Technische Referenz

## Aktueller Stand (Apple Container)
- Linux ARM64 VM via Apple Containers (Virtualization.framework)
- Node.js Host-Prozess auf macOS Host → startet Container pro Chat
- Claude Code läuft IN Container mit MCP-Tools
- IPC via gemountete Verzeichnisse (/workspace/ipc)
- Netzwerk via socat Bridges (Host → interne Services)
- Kein GPU-Zugriff (Linux VM kann Metal nicht ansprechen)

## Ziel (Tart macOS VM)
- macOS Sequoia VM via Tart (Virtualization.framework)
- NanoClaw Host-Prozess + Claude Code direkt in der VM
- Metal GPU + Neural Engine verfügbar
- Netzwerk-Isolation via Softnet + pf Firewall
- Directory Sharing via `tart run --dir`

## Key Differences: Container → VM

| Aspekt | Apple Container (alt) | Tart macOS VM (neu) |
|---|---|---|
| OS | Linux (Debian slim) | macOS Sequoia |
| GPU | ❌ CPU only | ✅ Metal GPU |
| Network | NAT (192.168.64.x) | Softnet (isoliert) |
| Filesystem | Docker-style mounts | Virtio FS (--dir) |
| Process Model | Container pro Chat | Alles in der VM |
| Tools | apt, npm | brew, npm, pip |
| macOS APIs | ❌ | ✅ osascript, remindctl |
| Image Size | ~1.5 GB | ~25-30 GB |
| RAM | ~512 MB per container | 4-8 GB für die VM |

## Tart CLI Cheatsheet

```bash
# VM Management
tart clone ghcr.io/cirruslabs/macos-sequoia-base:latest nanoclaw-vm
tart set nanoclaw-vm --cpu 4 --memory 8192 --disk-size 50
tart run nanoclaw-vm                    # GUI
tart run --no-graphics nanoclaw-vm      # Headless
tart run --net-softnet nanoclaw-vm      # Isoliertes Netzwerk
tart stop nanoclaw-vm
tart delete nanoclaw-vm
tart ip nanoclaw-vm                     # VM-IP abfragen
tart list                               # Alle VMs

# Directory Mounts
tart run --dir=name:host_path[:ro] nanoclaw-vm

# Snapshots
tart clone nanoclaw-vm nanoclaw-vm-backup
```

## Softnet Networking

Softnet erstellt ein isoliertes virtuelles Netzwerk. Die VM bekommt eine IP, hat aber keinen Zugang zum Host-Netzwerk oder Internet — nur was explizit per Bridge freigegeben wird.

```bash
# VM starten mit Softnet
tart run --no-graphics --net-softnet nanoclaw-vm &

# Bridges wie gewohnt (gleicher Ansatz wie bei Apple Containers)
VM_IP=$(tart ip nanoclaw-vm)
socat TCP-LISTEN:18443,bind=$VM_IP,fork TCP:bitwarden.cstrube.de:443 &
socat TCP-LISTEN:18123,bind=$VM_IP,fork TCP:10.0.30.5:8123 &
socat TCP-LISTEN:16443,bind=$VM_IP,fork TCP:10.0.40.100:6443 &
```

## Dateien die migriert werden müssen
- `groups/` — Chat-Konfigurationen (CLAUDE.md pro Gruppe)
- `data/` — Sessions, IPC, State
- `.env` — Discord Token, API Keys
- `memory/` — Shared memory files
- `scripts/` — Bridge scripts etc.

## Security Model
- VM hat kein Internet (Softnet)
- Nur explizite Bridges zu internen Services
- Secrets via Vaultwarden (Bridge)
- Christian kontrolliert VM-Start, Mounts, Bridges
- Snapshots als Rollback-Mechanismus
