#!/usr/bin/env python3
"""
generate_sns.py — 写真 + テキスト指示 → SNS用ショート動画を自動生成

Features:
  - Ken Burns効果（zoompan）
  - テキストオーバーレイ（ImageMagick）
  - トランジション（xfade）
  - BGM枠対応
  - 3スタイル: calm / energetic / minimal

Usage:
  python3 generate_sns.py --photos p1.jpg p2.jpg p3.jpg \
    --title "三十日珈琲" --subtitle "山梨県上野原市の自家焙煎コーヒー" \
    --style calm --duration 15 --output output.mp4
"""

import argparse
import json
import math
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path

FFMPEG = "ffmpeg"
MAGICK = "magick"
TELOP_FONT = "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"

# 出力解像度
OUTPUT_W = 1080
OUTPUT_H = 1920
FPS = 30

# スタイル定義
STYLES = {
    "calm": {
        "zoom_speed": 0.0008,    # ゆっくりズーム
        "zoom_range": (1.0, 1.15),
        "pan_speed": "slow",
        "transition": "fade",
        "transition_duration": 1.0,
        "title_font_size": 72,
        "subtitle_font_size": 42,
        "text_position": "center",  # タイトルの位置
        "text_bg_opacity": 0.5,
    },
    "energetic": {
        "zoom_speed": 0.002,     # 速いズーム
        "zoom_range": (1.0, 1.25),
        "pan_speed": "fast",
        "transition": "slideleft",
        "transition_duration": 0.5,
        "title_font_size": 80,
        "subtitle_font_size": 48,
        "text_position": "center",
        "text_bg_opacity": 0.6,
    },
    "minimal": {
        "zoom_speed": 0.0005,    # 最小限のズーム
        "zoom_range": (1.0, 1.08),
        "pan_speed": "minimal",
        "transition": "fade",
        "transition_duration": 0.8,
        "title_font_size": 64,
        "subtitle_font_size": 36,
        "text_position": "center",
        "text_bg_opacity": 0.4,
    },
}


def prepare_photo(photo_path: str, output_path: str) -> str:
    """写真を出力解像度にリサイズ+パディング（アスペクト比維持、少し余白を持たせてパン用に大きめ）"""
    # zoompanで動かすので、出力より20%大きく準備
    target_w = int(OUTPUT_W * 1.3)
    target_h = int(OUTPUT_H * 1.3)

    cmd = [
        MAGICK, photo_path,
        "-auto-orient",
        "-resize", f"{target_w}x{target_h}^",  # アスペクト比維持で領域を埋める
        "-gravity", "Center",
        "-extent", f"{target_w}x{target_h}",
        "-quality", "95",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"ImageMagick resize failed: {result.stderr[:200]}")
    return output_path


def generate_ken_burns_clip(photo_path: str, output_path: str, duration: float,
                            style: dict, clip_index: int) -> str:
    """1枚の写真からKen Burns効果付き動画クリップを生成"""
    zoom_speed = style["zoom_speed"]
    zoom_min, zoom_max = style["zoom_range"]
    total_frames = int(duration * FPS)

    # ズーム方向をランダムに（イン or アウト）
    if clip_index % 2 == 0:
        # ズームイン
        z_expr = f"min(zoom+{zoom_speed},{zoom_max})"
        start_zoom = zoom_min
    else:
        # ズームアウト
        z_expr = f"max(zoom-{zoom_speed},{zoom_min})"
        start_zoom = zoom_max

    # パン方向（ランダムに少し動かす）
    pan_options = {
        "slow": ("x+'1'", "y+'0.5'"),
        "fast": ("x+'2'", "y+'1'"),
        "minimal": ("x+'0.3'", "y+'0.2'"),
    }
    px, py = pan_options.get(style["pan_speed"], ("x+'1'", "y+'0.5'"))

    # 中央からスタート
    # zoompanの座標はズーム後の画像サイズに対する左上角
    cmd = [
        FFMPEG, "-y",
        "-loop", "1", "-i", photo_path,
        "-vf", (
            f"zoompan=z='{z_expr}':"
            f"x='iw/2-(iw/zoom/2)+({px.split('+')[1].strip(chr(39))}*(on-1))':"
            f"y='ih/2-(ih/zoom/2)+({py.split('+')[1].strip(chr(39))}*(on-1))':"
            f"d={total_frames}:s={OUTPUT_W}x{OUTPUT_H}:fps={FPS},"
            f"format=yuv420p"
        ),
        "-t", str(duration),
        "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        "-an",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"Ken Burns generation failed: {result.stderr[-300:]}")
    return output_path


def generate_title_overlay(title: str, subtitle: str, style: dict,
                           output_path: str) -> str:
    """タイトル+サブタイトルの透過PNG生成"""
    title_size = style["title_font_size"]
    sub_size = style["subtitle_font_size"]
    bg_opacity = style["text_bg_opacity"]

    # テキスト高さ計算
    title_h = int(title_size * 1.5) if title else 0
    sub_h = int(sub_size * 1.5) if subtitle else 0
    gap = 20 if title and subtitle else 0
    total_h = title_h + sub_h + gap + 80  # パディング
    card_w = OUTPUT_W - 80  # 左右40pxマージン

    # 背景カード
    cmd = [
        MAGICK,
        "-size", f"{card_w}x{total_h}",
        "xc:none",
        "-fill", f"rgba(0,0,0,{bg_opacity})",
        "-draw", f"roundrectangle 0,0 {card_w-1},{total_h-1} 16,16",
    ]

    y_offset = 40  # 上部パディング

    if title:
        # タイトル（ストローク+塗り）
        cmd.extend([
            "-font", TELOP_FONT, "-pointsize", str(title_size),
            "-fill", "black", "-stroke", "black", "-strokewidth", "3",
            "-gravity", "North", "-annotate", f"+0+{y_offset}", title,
            "-stroke", "none", "-fill", "white",
            "-annotate", f"+0+{y_offset}", title,
        ])
        y_offset += title_h + gap

    if subtitle:
        # サブタイトル
        cmd.extend([
            "-font", TELOP_FONT, "-pointsize", str(sub_size),
            "-fill", "black", "-stroke", "black", "-strokewidth", "2",
            "-gravity", "North", "-annotate", f"+0+{y_offset}", subtitle,
            "-stroke", "none", "-fill", "rgba(255,255,255,0.9)",
            "-annotate", f"+0+{y_offset}", subtitle,
        ])

    cmd.append(output_path)

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        print(f"[SNS] Title overlay error: {result.stderr[:200]}", file=sys.stderr, flush=True)
        return ""
    return output_path


def concat_with_transitions(clip_paths: list[str], transition: str,
                            trans_duration: float, output_path: str) -> str:
    """複数クリップをトランジション付きで結合"""
    if len(clip_paths) == 1:
        os.rename(clip_paths[0], output_path)
        return output_path

    # xfade フィルタチェーンで結合
    # 各クリップの長さを取得
    durations = []
    for clip in clip_paths:
        probe = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "csv=p=0", clip],
            capture_output=True, text=True,
        )
        durations.append(float(probe.stdout.strip()))

    inputs = []
    for clip in clip_paths:
        inputs.extend(["-i", clip])

    # xfadeフィルタチェーン
    filter_parts = []
    prev = "0:v"
    offset = durations[0] - trans_duration

    for i in range(1, len(clip_paths)):
        out_label = f"v{i}" if i < len(clip_paths) - 1 else "outv"
        filter_parts.append(
            f"[{prev}][{i}:v]xfade=transition={transition}:duration={trans_duration}:offset={offset}[{out_label}]"
        )
        prev = out_label
        if i < len(clip_paths) - 1:
            offset += durations[i] - trans_duration

    filter_complex = ";".join(filter_parts)

    # 音声なしで結合
    cmd = [
        FFMPEG, "-y",
        *inputs,
        "-filter_complex", filter_complex,
        "-map", f"[outv]",
        "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        "-an",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        # フォールバック: トランジションなしでconcat
        print(f"[SNS] xfade failed, falling back to simple concat", flush=True)
        return simple_concat(clip_paths, output_path)
    return output_path


def simple_concat(clip_paths: list[str], output_path: str) -> str:
    """トランジションなしの単純結合"""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        for clip in clip_paths:
            f.write(f"file '{clip}'\n")
        concat_file = f.name

    cmd = [
        FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", concat_file,
        "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        "-an", output_path,
    ]
    subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    os.unlink(concat_file)
    return output_path


def add_title_overlay(video_path: str, title_png: str, output_path: str,
                      show_duration: float = 3.0, fade_duration: float = 0.5) -> str:
    """動画にタイトルオーバーレイを合成（フェードイン/アウト付き）"""
    # タイトルを中央に表示
    x = "(W-w)/2"
    y = "(H-h)/2"
    enable = f"between(t,0.5,{show_duration + 0.5})"

    # フェード: overlay画像のアルファをアニメーション
    fade_in_end = 0.5 + fade_duration
    fade_out_start = show_duration + 0.5 - fade_duration
    alpha_expr = (
        f"if(lt(t,0.5),0,"
        f"if(lt(t,{fade_in_end}),(t-0.5)/{fade_duration},"
        f"if(lt(t,{fade_out_start}),1,"
        f"if(lt(t,{show_duration + 0.5}),({show_duration + 0.5}-t)/{fade_duration},0))))"
    )

    cmd = [
        FFMPEG, "-y",
        "-i", video_path,
        "-i", title_png,
        "-filter_complex",
        f"[1:v]format=rgba,colorchannelmixer=aa={1.0}[title];"
        f"[0:v][title]overlay={x}:{y}:enable='{enable}'[outv]",
        "-map", "[outv]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        print(f"[SNS] Title overlay composite failed: {result.stderr[-200:]}", file=sys.stderr, flush=True)
        # フォールバック: タイトルなし
        os.rename(video_path, output_path)
    return output_path


def add_silent_audio(video_path: str, output_path: str, duration: float) -> str:
    """無音オーディオトラックを追加（BGM差し替え用の枠）"""
    cmd = [
        FFMPEG, "-y",
        "-i", video_path,
        "-f", "lavfi", "-i", f"anullsrc=channel_layout=stereo:sample_rate=44100",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
        "-shortest",
        "-movflags", "+faststart",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        os.rename(video_path, output_path)
    return output_path


def generate_sns_video(
    photos: list[str],
    title: str = "",
    subtitle: str = "",
    style_name: str = "calm",
    duration: float = 15.0,
    output_path: str = "output.mp4",
    bgm_path: str | None = None,
) -> str:
    """メイン: 写真→SNS動画生成"""
    style = STYLES.get(style_name, STYLES["calm"])
    n_photos = len(photos)

    if n_photos == 0:
        raise ValueError("At least 1 photo is required")

    # 各写真の表示時間（トランジション込み）
    trans_dur = style["transition_duration"] if n_photos > 1 else 0
    total_trans = trans_dur * max(0, n_photos - 1)
    clip_duration = (duration + total_trans) / n_photos

    work_dir = Path(tempfile.mkdtemp(prefix="sns_"))
    print(f"[SNS] Style: {style_name}, Photos: {n_photos}, Duration: {duration}s", flush=True)
    print(f"[SNS] Clip duration: {clip_duration:.1f}s, Transition: {trans_dur}s", flush=True)

    # 1. 写真の前処理
    prepared = []
    for i, photo in enumerate(photos):
        prep_path = str(work_dir / f"prep_{i:03d}.jpg")
        prepare_photo(photo, prep_path)
        prepared.append(prep_path)
    print(f"[SNS] Prepared {len(prepared)} photos", flush=True)

    # 2. Ken Burns効果付きクリップ生成
    clips = []
    for i, prep in enumerate(prepared):
        clip_path = str(work_dir / f"clip_{i:03d}.mp4")
        generate_ken_burns_clip(prep, clip_path, clip_duration, style, i)
        clips.append(clip_path)
        print(f"[SNS] Generated clip {i+1}/{n_photos}", flush=True)

    # 3. トランジション付き結合
    concat_path = str(work_dir / "concat.mp4")
    concat_with_transitions(clips, style["transition"], trans_dur, concat_path)
    print("[SNS] Clips concatenated", flush=True)

    # 4. タイトルオーバーレイ
    if title or subtitle:
        title_png = str(work_dir / "title.png")
        generate_title_overlay(title, subtitle, style, title_png)
        if Path(title_png).exists():
            titled_path = str(work_dir / "titled.mp4")
            add_title_overlay(concat_path, title_png, titled_path, show_duration=3.5)
            concat_path = titled_path
            print("[SNS] Title overlay added", flush=True)

    # 5. 無音オーディオ追加（BGM枠）
    final_path = str(work_dir / "final.mp4")
    if bgm_path and Path(bgm_path).exists():
        # BGM付き
        cmd = [
            FFMPEG, "-y", "-i", concat_path, "-i", bgm_path,
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-map", "0:v", "-map", "1:a", "-shortest",
            "-movflags", "+faststart",
            final_path,
        ]
        subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    else:
        add_silent_audio(concat_path, final_path, duration)

    # 出力先にコピー
    output_path = str(Path(output_path).resolve())
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    import shutil
    shutil.copy2(final_path, output_path)

    # クリーンアップ
    shutil.rmtree(str(work_dir), ignore_errors=True)

    size_mb = Path(output_path).stat().st_size / (1024 * 1024)
    print(f"[SNS] Output: {output_path} ({size_mb:.1f}MB)", flush=True)
    return output_path


def main():
    parser = argparse.ArgumentParser(description="写真→SNS用ショート動画生成")
    parser.add_argument("--photos", nargs="+", required=True, help="写真ファイルパス")
    parser.add_argument("--title", default="", help="タイトルテキスト")
    parser.add_argument("--subtitle", default="", help="サブタイトル")
    parser.add_argument("--style", choices=["calm", "energetic", "minimal"], default="calm", help="動画スタイル")
    parser.add_argument("--duration", type=float, default=15.0, help="合計秒数")
    parser.add_argument("--output", default="output.mp4", help="出力ファイルパス")
    parser.add_argument("--bgm", default=None, help="BGM音声ファイル")

    args = parser.parse_args()

    # 写真の存在確認
    for p in args.photos:
        if not Path(p).exists():
            print(f"Error: Photo not found: {p}", file=sys.stderr)
            sys.exit(1)

    generate_sns_video(
        photos=args.photos,
        title=args.title,
        subtitle=args.subtitle,
        style_name=args.style,
        duration=args.duration,
        output_path=args.output,
        bgm_path=args.bgm,
    )


if __name__ == "__main__":
    main()
