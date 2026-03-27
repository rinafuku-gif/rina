#!/usr/bin/env python3
"""
Step 01: Preprocess — FFmpeg音声抽出 + 縦横判定
入力: 動画ファイルパス
出力: audio.wav + metadata.json（解像度、fps、縦横判定、duration）
"""

import json
import subprocess
import sys
from pathlib import Path


def get_video_info(video_path: str) -> dict:
    """FFprobeで動画メタデータを取得"""
    result = subprocess.run(
        [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", "-show_streams", video_path,
        ],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr[:300]}")
    return json.loads(result.stdout)


def extract_audio(video_path: str, output_path: str) -> str:
    """動画から音声をWAV (16kHz mono) で抽出"""
    result = subprocess.run(
        [
            "ffmpeg", "-y", "-i", video_path,
            "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            output_path,
        ],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg audio extraction failed: {result.stderr[:300]}")
    return output_path


def preprocess(video_path: str, output_dir: str) -> dict:
    """動画の前処理: 音声抽出 + メタデータ取得"""
    video_path = str(Path(video_path).resolve())
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # メタデータ取得
    info = get_video_info(video_path)

    # ビデオストリーム情報
    video_stream = next(
        (s for s in info.get("streams", []) if s["codec_type"] == "video"), None
    )
    audio_stream = next(
        (s for s in info.get("streams", []) if s["codec_type"] == "audio"), None
    )

    width = int(video_stream["width"]) if video_stream else 0
    height = int(video_stream["height"]) if video_stream else 0
    fps = eval(video_stream.get("r_frame_rate", "30/1")) if video_stream else 30
    duration = float(info.get("format", {}).get("duration", 0))

    orientation = "vertical" if height > width else "horizontal"

    # 音声抽出
    audio_path = str(output_dir / "audio.wav")
    extract_audio(video_path, audio_path)

    # メタデータ保存
    metadata = {
        "source": video_path,
        "width": width,
        "height": height,
        "fps": round(fps, 2),
        "duration": round(duration, 2),
        "orientation": orientation,
        "audio_path": audio_path,
    }
    meta_path = output_dir / "metadata.json"
    meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
    print(f"[Step01] {orientation} {width}x{height} @ {fps:.1f}fps, {duration:.1f}s", flush=True)
    return metadata


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <video_path> <output_dir>")
        sys.exit(1)
    result = preprocess(sys.argv[1], sys.argv[2])
    print(json.dumps(result, ensure_ascii=False, indent=2))
