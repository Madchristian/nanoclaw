#!/usr/bin/env python3
"""NanoClaw STT — transcribe audio using faster-whisper (local, no API key needed).
Usage: stt.py <audio_file_or_url> [--model tiny|base|small] [--language de]
"""
import sys
import os
import tempfile
import subprocess

def download_audio(url: str) -> str:
    """Download audio from URL, convert to wav with ffmpeg."""
    fd, tmp = tempfile.mkstemp(suffix='.ogg')
    os.close(fd)
    subprocess.run(['curl', '-sL', '-o', tmp, url], check=True)
    fd2, wav = tempfile.mkstemp(suffix='.wav')
    os.close(fd2)
    subprocess.run(['ffmpeg', '-y', '-i', tmp, '-ar', '16000', '-ac', '1', wav],
                   check=True, capture_output=True)
    os.unlink(tmp)
    return wav

def transcribe(audio_path: str, model_size: str = 'base', language: str = 'de') -> str:
    from faster_whisper import WhisperModel
    model = WhisperModel(model_size, device='cpu', compute_type='int8')
    segments, info = model.transcribe(audio_path, language=language, beam_size=5)
    return ' '.join(seg.text.strip() for seg in segments)

def main():
    import argparse
    parser = argparse.ArgumentParser(description='Transcribe audio')
    parser.add_argument('input', help='Audio file path or URL')
    parser.add_argument('--model', default='base', choices=['tiny', 'base', 'small'])
    parser.add_argument('--language', default='de')
    args = parser.parse_args()

    audio_path = args.input
    cleanup = False

    if audio_path.startswith('http://') or audio_path.startswith('https://'):
        audio_path = download_audio(args.input)
        cleanup = True
    elif not audio_path.endswith('.wav'):
        fd, wav = tempfile.mkstemp(suffix='.wav')
        os.close(fd)
        subprocess.run(['ffmpeg', '-y', '-i', audio_path, '-ar', '16000', '-ac', '1', wav],
                       check=True, capture_output=True)
        audio_path = wav
        cleanup = True

    text = transcribe(audio_path, args.model, args.language)
    print(text)

    if cleanup:
        os.unlink(audio_path)

if __name__ == '__main__':
    main()
