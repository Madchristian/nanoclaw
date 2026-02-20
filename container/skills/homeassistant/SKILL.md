# Home Assistant Skill

## Verbindung
- **URL:** `http://192.168.64.1:18123` (via socat Bridge)
- **Token:** HA_TOKEN env var oder aus Vaultwarden holen

## API Basics
```bash
# GET
curl -s "http://192.168.64.1:18123/api/states/<entity_id>" \
  -H "Authorization: Bearer $HA_TOKEN"

# POST (Service Call)
curl -s "http://192.168.64.1:18123/api/services/<domain>/<service>" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id":"<entity_id>"}'

# POST mit return_response (z.B. für Maps)
curl -s "http://192.168.64.1:18123/api/services/<domain>/<service>?return_response" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id":"<entity_id>"}'
```

## ⚠️ Lichter IMMER über OpenHue steuern!
- HA-Light-States sind unzuverlässig bei Hue-Lichtern
- HA nur für Nicht-Hue-Geräte (Vacuum, Climate, Sensoren, Szenen etc.)

## Dobby (Roborock S8 Pro Ultra)

### Entity: `vacuum.roborock_s8_pro_ultra`

### Wichtige Regeln
1. **Stoppen:** Immer erst `vacuum/pause`, dann `vacuum/return_to_base` — direkt return_to_base wird beim Putzen ignoriert!
2. **Starten:** `vacuum.start` ist unzuverlässig — **Button-Services nutzen!**
3. **Status-Wait:** Nach jedem API-Call 15s warten bevor Status geprüft wird
4. **Exponential Backoff beim Start:** 15s Wait → Check → falls nicht cleaning: 10s/30s/60s Pause → Retry
5. **Buttons brauchen ~20-30s** bis Dobby tatsächlich losfährt

### Start-Buttons (zuverlässig!)
```bash
# Saugen + Wischen GLEICHZEITIG (Standard!) ✅
curl -s "http://192.168.64.1:18123/api/services/button/press" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id":"button.dobby_s8_pro_ultra_alles_reinigen"}'

# Saugen, DANACH Wischen
curl -s ".../api/services/button/press" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id":"button.dobby_s8_pro_ultra_saugen_dann_wischen"}'

# Nur Saugen
curl -s ".../api/services/button/press" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id":"button.dobby_s8_pro_ultra_alles_saugen"}'
```

### Stoppen (Pause-first!)
```bash
# 1. Pause
curl -s "http://192.168.64.1:18123/api/services/vacuum/pause" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id":"vacuum.roborock_s8_pro_ultra"}'
sleep 5

# 2. Zurück zum Dock
curl -s "http://192.168.64.1:18123/api/services/vacuum/return_to_base" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id":"vacuum.roborock_s8_pro_ultra"}'
```

### Raum-Reinigung
```bash
# Räume via send_command
curl -s "http://192.168.64.1:18123/api/services/vacuum/send_command" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id":"vacuum.roborock_s8_pro_ultra","command":"app_segment_clean","params":[20]}'
```

**Zimmer-IDs:**
| ID | Raum |
|----|------|
| 16 | Badezimmer |
| 17 | Flur |
| 18 | Schlafzimmer |
| 19 | GästeWC |
| 20 | Küche |
| 21 | Arbeitszimmer |
| 22 | Wohnzimmer |

### Modi setzen
```bash
# Saugstärke: off|quiet|balanced|turbo|max|max_plus
curl -s ".../api/services/vacuum/set_fan_speed" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id":"vacuum.roborock_s8_pro_ultra","fan_speed":"turbo"}'

# Wisch-Intensität: off|mild|moderate|intense|custom
curl -s ".../api/services/select/select_option" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id":"select.roborock_s8_pro_ultra_wisch_intensitat","option":"intense"}'

# Mopp-Modus: standard|deep|deep_plus|fast|custom|smart_mode
curl -s ".../api/services/select/select_option" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id":"select.roborock_s8_pro_ultra_mop_modus","option":"deep"}'
```

### Status abfragen
Wichtige Entities:
- `vacuum.roborock_s8_pro_ultra` — Hauptstatus (docked/cleaning/returning/paused/idle/error)
- `sensor.roborock_s8_pro_ultra_batterie` — Akku %
- `sensor.dobby_s8_pro_ultra_aktueller_raum` — Aktueller Raum
- `sensor.roborock_s8_pro_ultra_status` — Detaillierter Status
- `sensor.roborock_s8_pro_ultra_staubsauger_fehler` — Fehlercode
- `sensor.roborock_s8_pro_ultra_dock_fehler` — Dock-Fehler
- `binary_sensor.roborock_s8_pro_ultra_wasserknappheit` — on = LEER
- `binary_sensor.roborock_s8_pro_ultra_mopp_angebracht` — on = Mopp dran
- `select.roborock_s8_pro_ultra_wisch_intensitat` — Wisch-Intensität
- `select.roborock_s8_pro_ultra_mop_modus` — Mopp-Modus

### Andere HA-Geräte
```bash
# Wer ist zuhause?
# → person.* entities abfragen

# Klima/Temperatur
# → sensor.*temperature* entities

# Szenen
# → /api/services/scene/turn_on mit scene.* entity
```
