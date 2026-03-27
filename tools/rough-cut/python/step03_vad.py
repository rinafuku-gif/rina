#!/usr/bin/env python3
"""
Step 03: VAD — 無音区間検出
FFmpegのsilencedetectフィルタを使用（torch不要）
入力: audio.wav
出力: vad.json（speech/silence区間リスト）
"""

import json
import re
import subprocess
import sys
from pathlib import Path

SILENCE_THRESHOLD_DB = -35  # dB以下を無音と判定
MIN_SILENCE_DURATION = 0.3  # 最低0.3秒の無音


def detect_silence(audio_path: str, threshold_db: int = SILENCE_THRESHOLD_DB,
                   min_duration: float = MIN_SILENCE_DURATION) -> list[dict]:
    """FFmpeg silencedetect で無音区間を検出"""
    result = subprocess.run(
        [
            "ffmpeg", "-i", audio_path, "-af",
            f"silencedetect=noise={threshold_db}dB:d={min_duration}",
            "-f", "null", "-",
        ],
        capture_output=True, text=True,
    )

    # stderrからsilencedetectの出力をパース
    output = result.stderr
    silence_starts = re.findall(r"silence_start: ([\d.]+)", output)
    silence_ends = re.findall(r"silence_end: ([\d.]+)", output)

    silences = []
    for i, start in enumerate(silence_starts):
        start_t = float(start)
        end_t = float(silence_ends[i]) if i < len(silence_ends) else None
        if end_t is not None:
            silences.append({
                "start": round(start_t, 3),
                "end": round(end_t, 3),
                "duration": round(end_t - start_t, 3),
            })

    return silences


def build_speech_segments(silences: list[dict], total_duration: float) -> list[dict]:
    """無音区間から発話区間を逆算"""
    speech = []
    prev_end = 0.0

    for s in silences:
        if s["start"] > prev_end + 0.05:  # 50ms以上の発話区間
            speech.append({
                "start": round(prev_end, 3),
                "end": round(s["start"], 3),
                "duration": round(s["start"] - prev_end, 3),
                "type": "speech",
            })
        prev_end = s["end"]

    # 最後の発話区間
    if total_duration > prev_end + 0.05:
        speech.append({
            "start": round(prev_end, 3),
            "end": round(total_duration, 3),
            "duration": round(total_duration - prev_end, 3),
            "type": "speech",
        })

    return speech


def run_vad(audio_path: str, output_dir: str, total_duration: float = 0) -> dict:
    """VAD実行: 無音検出 → 発話区間生成"""
    output_dir = Path(output_dir)

    # total_duration が不明な場合はffprobeで取得
    if total_duration <= 0:
        probe = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "csv=p=0", audio_path],
            capture_output=True, text=True,
        )
        total_duration = float(probe.stdout.strip()) if probe.stdout.strip() else 0

    silences = detect_silence(audio_path)
    speech_segments = build_speech_segments(silences, total_duration)

    vad_result = {
        "total_duration": round(total_duration, 3),
        "silences": silences,
        "speech_segments": speech_segments,
        "silence_total": round(sum(s["duration"] for s in silences), 3),
        "speech_total": round(sum(s["duration"] for s in speech_segments), 3),
    }

    vad_path = output_dir / "vad.json"
    vad_path.write_text(json.dumps(vad_result, ensure_ascii=False, indent=2))

    print(f"[Step03] {len(silences)} silence regions, {len(speech_segments)} speech segments", flush=True)
    print(f"[Step03] Speech: {vad_result['speech_total']:.1f}s / Silence: {vad_result['silence_total']:.1f}s", flush=True)
    return vad_result


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <audio_path> <output_dir> [total_duration]")
        sys.exit(1)
    dur = float(sys.argv[3]) if len(sys.argv) > 3 else 0
    result = run_vad(sys.argv[1], sys.argv[2], dur)
    print(f"Silences: {len(result['silences'])}, Speech: {len(result['speech_segments'])}")
