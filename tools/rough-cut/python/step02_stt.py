#!/usr/bin/env python3
"""
Step 02: STT — whisper word-level 文字起こし
入力: audio.wav
出力: stt.json（word-level timestamps）
"""

import json
import subprocess
import sys
from pathlib import Path

WHISPER_PATH = "/opt/homebrew/bin/whisper"
WHISPER_MODEL = "small"
WHISPER_LANGUAGE = "ja"


def transcribe(audio_path: str, output_dir: str) -> dict:
    """whisperでword-level文字起こし"""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # whisperでJSON出力（word_timestamps付き）
    result = subprocess.run(
        [
            WHISPER_PATH, audio_path,
            "--model", WHISPER_MODEL,
            "--language", WHISPER_LANGUAGE,
            "--output_format", "json",
            "--output_dir", str(output_dir),
            "--word_timestamps", "True",
            "--no_speech_threshold", "0.6",
            "--condition_on_previous_text", "False",
        ],
        capture_output=True, text=True,
        timeout=600,
    )
    if result.returncode != 0:
        raise RuntimeError(f"whisper failed: {result.stderr[:500]}")

    # whisperが出力するJSONファイルを読み込み
    json_files = list(output_dir.glob("audio.json"))
    if not json_files:
        # ファイル名がaudio以外の場合
        json_files = list(output_dir.glob("*.json"))
        json_files = [f for f in json_files if f.name not in ("metadata.json", "stt.json", "vad.json", "fillers.json")]

    if not json_files:
        raise RuntimeError("whisper produced no JSON output")

    raw = json.loads(json_files[0].read_text())

    # 整形: segments + words
    segments = []
    all_words = []

    for seg in raw.get("segments", []):
        segment = {
            "id": seg["id"],
            "start": seg["start"],
            "end": seg["end"],
            "text": seg["text"].strip(),
            "words": [],
        }
        for w in seg.get("words", []):
            word = {
                "word": w["word"].strip(),
                "start": w["start"],
                "end": w["end"],
                "probability": w.get("probability", 0),
            }
            segment["words"].append(word)
            all_words.append(word)
        segments.append(segment)

    stt_result = {
        "segments": segments,
        "words": all_words,
        "text": raw.get("text", "").strip(),
        "language": raw.get("language", WHISPER_LANGUAGE),
    }

    stt_path = output_dir / "stt.json"
    stt_path.write_text(json.dumps(stt_result, ensure_ascii=False, indent=2))

    print(f"[Step02] {len(segments)} segments, {len(all_words)} words", flush=True)
    print(f"[Step02] Text: {stt_result['text'][:100]}...", flush=True)
    return stt_result


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <audio_path> <output_dir>")
        sys.exit(1)
    result = transcribe(sys.argv[1], sys.argv[2])
    print(f"Total words: {len(result['words'])}")
