#!/usr/bin/env python3
"""
render_v2_reel.py — デザイン済み静止画 + 台本 → リール動画生成
SATOYAMA AI BASE リールv2専用レンダラー

- 8枚のデザイン済みPNGをカット素材として使用
- 台本の秒数指定に従って構成（30秒）
- Ken Burns効果、トランジション
- VOICEVOXナレーション
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

FFMPEG = "ffmpeg"
VOICEVOX_URL = "http://127.0.0.1:50021"
MAGICK = "magick"

OUTPUT_W = 1080
OUTPUT_H = 1920
FPS = 30

# カット定義（台本v2 FINALに準拠）
CUTS = [
    {"id": 1, "name": "フック",   "start": 0.0,  "end": 3.0,  "kb": "zoom_in",  "scale": [100, 108], "narr": "スマホだけでAI、知ってた？"},
    {"id": 2, "name": "共感",     "start": 3.0,  "end": 6.0,  "kb": "static",   "scale": [100, 100], "narr": "パソコン必要？もう古い。"},
    {"id": 3, "name": "転換",     "start": 6.0,  "end": 9.0,  "kb": "zoom_in",  "scale": [100, 105], "narr": "今週だけで3つ変わったんです。"},
    {"id": 4, "name": "具体①",   "start": 9.0,  "end": 13.0, "kb": "zoom_in",  "scale": [100, 106], "narr": "AIが前の話、覚えてくれる。"},
    {"id": 5, "name": "具体②",   "start": 13.0, "end": 17.0, "kb": "zoom_in",  "scale": [100, 106], "narr": "翻訳もね、人が書いたみたい。"},
    {"id": 6, "name": "具体③",   "start": 17.0, "end": 21.0, "kb": "zoom_in",  "scale": [100, 106], "narr": "伝えるだけで形にしてくれる。"},
    {"id": 7, "name": "着地",     "start": 21.0, "end": 25.0, "kb": "zoom_out", "scale": [106, 100], "narr": "今がいちばん始めやすいです。"},
    {"id": 8, "name": "CTA",      "start": 25.0, "end": 30.0, "kb": "zoom_in",  "scale": [100, 103], "narr": "保存して、試してみてね。"},
]

# カラーグレーディング（台本: ナチュラル寄り）
COLOR_FILTER = "eq=brightness=0.02:saturation=0.95:contrast=1.05"


def voicevox_tts(text: str, speaker_id: int = 30, speed: float = 1.15) -> bytes:
    """VOICEVOX TTS"""
    query_url = f"{VOICEVOX_URL}/audio_query?speaker={speaker_id}&text={urllib.request.quote(text)}"
    req = urllib.request.Request(query_url, method="POST")
    with urllib.request.urlopen(req) as resp:
        aq = json.loads(resp.read())
    aq["speedScale"] = speed
    aq["pitchScale"] = -0.02  # 少し低めで落ち着いた印象
    synth_url = f"{VOICEVOX_URL}/synthesis?speaker={speaker_id}"
    req = urllib.request.Request(synth_url, data=json.dumps(aq).encode(),
                                headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as resp:
        return resp.read()


def prepare_image(src: str, dst: str):
    """画像をKen Burns用に少し大きくリサイズ"""
    target_w = int(OUTPUT_W * 1.2)
    target_h = int(OUTPUT_H * 1.2)
    subprocess.run([
        MAGICK, src, "-resize", f"{target_w}x{target_h}^",
        "-gravity", "Center", "-extent", f"{target_w}x{target_h}",
        "-quality", "95", dst,
    ], capture_output=True, timeout=15, check=True)


def make_clip(image: str, cut: dict, work_dir: str) -> str:
    """1カットのKen Burns動画クリップを生成"""
    duration = cut["end"] - cut["start"]
    total_frames = int(duration * FPS)
    kb = cut["kb"]
    s0, s1 = [s / 100.0 for s in cut["scale"]]

    if kb == "zoom_in":
        z_expr = f"zoom+{(s1 - s0) / total_frames}"
    elif kb == "zoom_out":
        z_expr = f"if(eq(on,1),{s0},zoom-{(s0 - s1) / total_frames})"
    else:
        z_expr = "1.0"

    clip = os.path.join(work_dir, f"clip_{cut['id']:02d}.mp4")
    subprocess.run([
        FFMPEG, "-y", "-loop", "1", "-i", image,
        "-vf", (
            f"zoompan=z='{z_expr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
            f"d={total_frames}:s={OUTPUT_W}x{OUTPUT_H}:fps={FPS},"
            f"format=yuv420p,{COLOR_FILTER}"
        ),
        "-t", str(duration),
        "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-an", clip,
    ], capture_output=True, text=True, timeout=120, check=True)
    return clip


def make_narration(cuts: list[dict], speaker_id: int, speed: float, work_dir: str) -> str:
    """全カットのナレーションを生成して結合"""
    segments = []
    for cut in cuts:
        target_dur = cut["end"] - cut["start"]
        text = cut["narr"]

        wav_data = voicevox_tts(text, speaker_id, speed)
        raw = os.path.join(work_dir, f"narr_{cut['id']:02d}_raw.wav")
        Path(raw).write_bytes(wav_data)

        # 目標尺にパディング/トリム
        padded = os.path.join(work_dir, f"narr_{cut['id']:02d}.wav")
        subprocess.run([
            FFMPEG, "-y", "-i", raw,
            "-af", f"apad=whole_dur={target_dur}",
            "-t", str(target_dur),
            "-ar", "24000", "-ac", "1", padded,
        ], capture_output=True, timeout=10)
        segments.append(padded)

    # 結合
    concat_list = os.path.join(work_dir, "narr_list.txt")
    with open(concat_list, "w") as f:
        for s in segments:
            f.write(f"file '{s}'\n")

    narr = os.path.join(work_dir, "narration.wav")
    subprocess.run([
        FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", concat_list,
        "-c:a", "pcm_s16le", "-ar", "24000", "-ac", "1", narr,
    ], capture_output=True, timeout=30)
    return narr


def render_v2(image_dir: str, output_path: str, speaker_id: int = 30, speed: float = 1.15):
    """メインレンダリング"""
    image_dir = Path(image_dir)
    work_dir = tempfile.mkdtemp(prefix="reel_v2_")

    print(f"[v2] Speaker ID: {speaker_id}, Speed: {speed}", flush=True)

    # 1. 画像前処理
    images = []
    for cut in CUTS:
        src = str(image_dir / f"cut{cut['id']}.png")
        if not Path(src).exists():
            raise FileNotFoundError(f"Missing: {src}")
        dst = os.path.join(work_dir, f"prep_{cut['id']:02d}.png")
        prepare_image(src, dst)
        images.append(dst)
    print(f"[v2] Prepared {len(images)} images", flush=True)

    # 2. Ken Burnsクリップ生成
    clips = []
    for i, cut in enumerate(CUTS):
        clip = make_clip(images[i], cut, work_dir)
        clips.append(clip)
        dur = cut["end"] - cut["start"]
        print(f"[v2] Cut {cut['id']}: {cut['name']} ({dur:.0f}s)", flush=True)

    # 3. クリップ結合（ハードカット — デザイン済みなのでトランジション不要）
    concat_list = os.path.join(work_dir, "clip_list.txt")
    with open(concat_list, "w") as f:
        for c in clips:
            f.write(f"file '{c}'\n")

    video_only = os.path.join(work_dir, "video.mp4")
    subprocess.run([
        FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", concat_list,
        "-c", "copy", video_only,
    ], capture_output=True, timeout=30)
    print("[v2] Video assembled", flush=True)

    # 4. ナレーション生成
    print("[v2] Generating narration...", flush=True)
    narr = make_narration(CUTS, speaker_id, speed, work_dir)
    print("[v2] Narration ready", flush=True)

    # 5. 映像+音声合成
    output_path = str(Path(output_path).resolve())
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    subprocess.run([
        FFMPEG, "-y",
        "-i", video_only, "-i", narr,
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-map", "0:v", "-map", "1:a",
        "-shortest",
        "-movflags", "+faststart",
        output_path,
    ], capture_output=True, text=True, timeout=60)

    shutil.rmtree(work_dir, ignore_errors=True)

    size_mb = Path(output_path).stat().st_size / (1024 * 1024)
    print(f"[v2] Output: {output_path} ({size_mb:.1f}MB, 30s)", flush=True)
    return output_path


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="SATOYAMA AI BASE リールv2レンダラー")
    parser.add_argument("--images", required=True, help="カット画像ディレクトリ（cut1.png〜cut8.png）")
    parser.add_argument("--output", default="satoyama-reel-v2.mp4", help="出力ファイル")
    parser.add_argument("--speaker", type=int, default=30, help="VOICEVOX speaker ID (default: 30=No.7 アナウンス)")
    parser.add_argument("--speed", type=float, default=1.15, help="ナレーション速度")
    args = parser.parse_args()
    render_v2(args.images, args.output, args.speaker, args.speed)
