#!/bin/bash
# NanoClaw TTS — converts text to speech using edge-tts
# Usage: tts.sh <text> [output_path] [--voice VOICE] [--rate RATE] [--pitch PITCH]
#
# Defaults match Claw's OpenClaw voice config:
#   Voice: de-DE-KillianNeural (German male, natural)
#   Rate:  +20%
#   Pitch: -8Hz

set -e

TEXT=""
OUTPUT=""
VOICE="de-DE-KillianNeural"
RATE="+20%"
PITCH="-8Hz"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --voice) VOICE="$2"; shift 2 ;;
    --rate)  RATE="$2"; shift 2 ;;
    --pitch) PITCH="$2"; shift 2 ;;
    *)
      if [ -z "$TEXT" ]; then
        TEXT="$1"
      elif [ -z "$OUTPUT" ]; then
        OUTPUT="$1"
      fi
      shift ;;
  esac
done

if [ -z "$TEXT" ]; then
  echo "Usage: tts.sh <text> [output.mp3] [--voice VOICE] [--rate RATE] [--pitch PITCH]" >&2
  echo "" >&2
  echo "Available German voices:" >&2
  echo "  de-DE-KillianNeural     (male, default)" >&2
  echo "  de-DE-ConradNeural      (male, deeper)" >&2
  echo "  de-DE-FlorianMultilingualNeural (male, multilingual)" >&2
  echo "  de-DE-SeraphinaMultilingualNeural (female, multilingual)" >&2
  echo "  de-DE-AmalaNeural       (female)" >&2
  exit 1
fi

# Default output path
if [ -z "$OUTPUT" ]; then
  OUTPUT="/tmp/tts-$(date +%s)-$RANDOM.mp3"
fi

edge-tts --voice "$VOICE" --rate="$RATE" --pitch="$PITCH" --text "$TEXT" --write-media "$OUTPUT" 2>/dev/null

echo "$OUTPUT"
