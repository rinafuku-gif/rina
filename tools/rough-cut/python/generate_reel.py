#!/usr/bin/env python3
"""
generate_reel.py — テンプレートYAMLベースのリール動画生成
設計書のカット指定・Ken Burns・テキスト・トランジション・カラグレを忠実に再現

Usage:
  python3 generate_reel.py --template reel_coffee.yaml --photos p1.jpg p2.jpg ... --output output.mp4
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

FFMPEG = "ffmpeg"
MAGICK = "magick"
OUTPUT_W = 1080
OUTPUT_H = 1920
FPS = 30


def load_template(template_path: str) -> dict:
    with open(template_path) as f:
        return yaml.safe_load(f)


def prepare_photo(photo_path: str, output_path: str, scale: float = 1.3) -> str:
    """写真をKen Burns用にリサイズ（出力より大きく）"""
    target_w = int(OUTPUT_W * scale)
    target_h = int(OUTPUT_H * scale)
    cmd = [
        MAGICK, photo_path,
        "-auto-orient",
        "-resize", f"{target_w}x{target_h}^",
        "-gravity", "Center",
        "-extent", f"{target_w}x{target_h}",
        "-quality", "95",
        output_path,
    ]
    subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=True)
    return output_path


def generate_clip(photo_path: str, cut: dict, work_dir: str, color_filter: str = "") -> str:
    """1カット分の動画クリップを生成（Ken Burns + カラグレ）"""
    start, end = cut["time"]
    duration = end - start
    total_frames = int(duration * FPS)

    kb = cut.get("ken_burns", {})
    kb_type = kb.get("type", "zoom_in")

    # Ken Burns パラメータ
    if kb_type == "zoom_in":
        s_start, s_end = kb.get("scale", [100, 108])
        z_start = s_start / 100.0
        z_end = s_end / 100.0
        z_expr = f"zoom+{(z_end - z_start) / total_frames}"
        x_expr = "iw/2-(iw/zoom/2)"
        y_expr = "ih/2-(ih/zoom/2)"
    elif kb_type == "zoom_out":
        s_start, s_end = kb.get("scale", [108, 100])
        z_start = s_start / 100.0
        z_end = s_end / 100.0
        z_expr = f"if(eq(on,1),{z_start},zoom-{(z_start - z_end) / total_frames})"
        x_expr = "iw/2-(iw/zoom/2)"
        y_expr = "ih/2-(ih/zoom/2)"
    elif kb_type == "pan_lr":
        px = kb.get("position_x", [-3, 3])
        # パン: ズーム固定1.15、X位置を移動
        z_expr = "1.15"
        x_shift_per_frame = (px[1] - px[0]) / 100.0 * OUTPUT_W / total_frames
        x_expr = f"iw/2-(iw/zoom/2)+({x_shift_per_frame}*on)"
        y_expr = "ih/2-(ih/zoom/2)"
    elif kb_type == "pan_rl":
        px = kb.get("position_x", [3, -3])
        z_expr = "1.15"
        x_shift_per_frame = (px[1] - px[0]) / 100.0 * OUTPUT_W / total_frames
        x_expr = f"iw/2-(iw/zoom/2)+({x_shift_per_frame}*on)"
        y_expr = "ih/2-(ih/zoom/2)"
    else:
        z_expr = "1.0"
        x_expr = "iw/2-(iw/zoom/2)"
        y_expr = "ih/2-(ih/zoom/2)"

    clip_path = os.path.join(work_dir, f"clip_{cut['id']:02d}.mp4")

    vf = (
        f"zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}':"
        f"d={total_frames}:s={OUTPUT_W}x{OUTPUT_H}:fps={FPS},"
        f"format=yuv420p"
    )
    if color_filter:
        vf += f",{color_filter}"

    cmd = [
        FFMPEG, "-y",
        "-loop", "1", "-i", photo_path,
        "-vf", vf,
        "-t", str(duration),
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-an",
        clip_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        print(f"[Reel] Clip {cut['id']} error: {result.stderr[-200:]}", file=sys.stderr, flush=True)
        raise RuntimeError(f"Clip generation failed for cut {cut['id']}")

    return clip_path


def generate_text_overlay(texts: list[dict], template: dict, work_dir: str, cut_id: int) -> str | None:
    """カットのテキストオーバーレイPNGを生成"""
    if not texts:
        return None

    font = template.get("font", {}).get("family", "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc")
    accent = template.get("accent_color", "#8B6914")
    cta_color = template.get("cta_color", "rgba(139,105,20,0.85)")

    png_path = os.path.join(work_dir, f"text_{cut_id:02d}.png")

    # 透過キャンバス
    cmd = [MAGICK, "-size", f"{OUTPUT_W}x{OUTPUT_H}", "xc:none"]

    for txt in texts:
        content = txt.get("content", "")
        x, y = txt.get("position", [540, 750])
        size = txt.get("size", 48)
        style = txt.get("style", "")
        opacity = txt.get("opacity", 1.0)

        # CTA形状の背景
        if style == "cta_shape":
            # テキスト幅を推定
            text_w = len(content) * size * 0.6 + 40
            text_h = size + 24
            rx = x - text_w / 2
            ry = y - text_h / 2
            cmd.extend([
                "-fill", cta_color,
                "-draw", f"roundrectangle {int(rx)},{int(ry)} {int(rx + text_w)},{int(ry + text_h)} 12,12",
            ])

        # テキスト描画
        text_color = f"rgba(255,255,255,{opacity})" if opacity < 1 else "white"
        # gravity を使わず座標指定
        cmd.extend([
            "-font", font, "-pointsize", str(size),
            "-fill", "black", "-stroke", "black", "-strokewidth", str(max(1, size // 24)),
            "-gravity", "NorthWest",
            "-annotate", f"+{int(x - len(content) * size * 0.3)}+{int(y - size / 2)}", content,
            "-stroke", "none", "-fill", text_color,
            "-annotate", f"+{int(x - len(content) * size * 0.3)}+{int(y - size / 2)}", content,
        ])

    cmd.append(png_path)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        print(f"[Reel] Text overlay {cut_id} error: {result.stderr[:200]}", file=sys.stderr, flush=True)
        return None
    return png_path


def apply_transition(clip_a: str, clip_b: str, transition: dict, work_dir: str, idx: int) -> str:
    """2つのクリップ間にトランジションを適用"""
    trans_type = transition.get("type", "fade")
    trans_dur = transition.get("duration", 0.3)

    # FFmpegのxfade遷移名にマッピング
    xfade_map = {
        "white": "fade",  # fadewhite は使えない場合があるのでfadeで代用
        "black": "fade",
        "slide": "slideleft",
    }
    xfade_name = xfade_map.get(trans_type, "fade")

    # clip_aの長さを取得
    probe = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", clip_a],
        capture_output=True, text=True,
    )
    dur_a = float(probe.stdout.strip())
    offset = dur_a - trans_dur

    out_path = os.path.join(work_dir, f"trans_{idx:02d}.mp4")

    cmd = [
        FFMPEG, "-y", "-i", clip_a, "-i", clip_b,
        "-filter_complex",
        f"[0:v][1:v]xfade=transition={xfade_name}:duration={trans_dur}:offset={offset}[outv]",
        "-map", "[outv]", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-an",
        out_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        # フォールバック: ハードカット
        print(f"[Reel] Transition failed, using hard cut", flush=True)
        return concat_two(clip_a, clip_b, out_path)
    return out_path


def concat_two(a: str, b: str, output: str) -> str:
    """2つのクリップを単純結合"""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        f.write(f"file '{a}'\nfile '{b}'\n")
        lst = f.name
    subprocess.run(
        [FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", output],
        capture_output=True, text=True, timeout=30,
    )
    os.unlink(lst)
    return output


def concat_all(clips: list[str], output: str) -> str:
    """全クリップをconcat"""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        for c in clips:
            f.write(f"file '{c}'\n")
        lst = f.name
    subprocess.run(
        [FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", output],
        capture_output=True, text=True, timeout=60,
    )
    os.unlink(lst)
    return output


def burn_overlays(video_path: str, overlays: list[dict], output_path: str) -> str:
    """テキストオーバーレイPNGを動画に合成"""
    if not overlays:
        shutil.copy2(video_path, output_path)
        return output_path

    # 最大10個ずつバッチ
    overlays = overlays[:15]

    inputs = ["-i", video_path]
    for o in overlays:
        inputs.extend(["-i", o["png"]])

    filter_parts = []
    prev = "0:v"
    for idx, o in enumerate(overlays):
        inp_idx = idx + 1
        out = f"tmp{idx}" if idx < len(overlays) - 1 else "outv"
        enable = f"between(t,{o['start']},{o['end']})"
        filter_parts.append(
            f"[{prev}][{inp_idx}:v]overlay=0:0:enable='{enable}'[{out}]"
        )
        prev = out

    cmd = [
        FFMPEG, "-y", *inputs,
        "-filter_complex", ";".join(filter_parts),
        "-map", "[outv]",
        "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        "-an",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if result.returncode != 0:
        print(f"[Reel] Overlay burn error: {result.stderr[-200:]}", file=sys.stderr, flush=True)
        shutil.copy2(video_path, output_path)
    return output_path


def add_silent_audio(video_path: str, output_path: str) -> str:
    cmd = [
        FFMPEG, "-y", "-i", video_path,
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest",
        "-movflags", "+faststart",
        output_path,
    ]
    subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    return output_path


def generate_reel(template_path: str, photos: list[str], output_path: str) -> str:
    """テンプレートベースのリール動画生成"""
    template = load_template(template_path)
    cuts = template.get("cuts", [])
    color_filter = template.get("color_grading", {}).get("ffmpeg_filter", "")

    n_cuts = len(cuts)
    n_photos = len(photos)

    if n_photos < n_cuts:
        # 写真が足りない場合は循環して使う
        while len(photos) < n_cuts:
            photos.append(photos[len(photos) % n_photos])
        print(f"[Reel] Padded photos from {n_photos} to {len(photos)} (cycling)", flush=True)

    work_dir = tempfile.mkdtemp(prefix="reel_")
    print(f"[Reel] Template: {template['metadata']['name']}", flush=True)
    print(f"[Reel] Cuts: {n_cuts}, Photos: {len(photos)}", flush=True)

    # 1. 写真の前処理
    prepared = []
    for i, photo in enumerate(photos[:n_cuts]):
        prep = os.path.join(work_dir, f"prep_{i:02d}.jpg")
        prepare_photo(photo, prep)
        prepared.append(prep)
    print(f"[Reel] Prepared {len(prepared)} photos", flush=True)

    # 2. 各カットのクリップ生成
    clips = []
    for i, cut in enumerate(cuts):
        clip = generate_clip(prepared[i], cut, work_dir, color_filter)
        clips.append(clip)
        print(f"[Reel] Cut {cut['id']}: {cut['name']} ({cut['time'][1]-cut['time'][0]:.1f}s)", flush=True)

    # 3. トランジション適用
    # トランジションがあるカット間を結合
    merged_clips = [clips[0]]
    for i in range(len(cuts) - 1):
        current_cut = cuts[i]
        next_clip = clips[i + 1]
        trans = current_cut.get("transition_after")

        if trans:
            # 前のmergedの最後とnext_clipをトランジションで結合
            merged = apply_transition(merged_clips[-1], next_clip, trans, work_dir, i)
            merged_clips[-1] = merged
            print(f"[Reel] Transition: {trans['type']} ({trans['duration']}s) after cut {current_cut['id']}", flush=True)
        else:
            merged_clips.append(next_clip)

    # 全体結合
    if len(merged_clips) > 1:
        concat_path = os.path.join(work_dir, "concat.mp4")
        concat_all(merged_clips, concat_path)
    else:
        concat_path = merged_clips[0]
    print("[Reel] Clips assembled", flush=True)

    # 4. テキストオーバーレイはHTMLスライドに含まれているのでスキップ
    # （HTMLスライド使用時はテキストが画像に焼き付け済み）

    # 5. 無音オーディオ追加
    final_path = os.path.join(work_dir, "final.mp4")
    add_silent_audio(concat_path, final_path)

    # 出力
    output_path = str(Path(output_path).resolve())
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(final_path, output_path)

    # クリーンアップ
    shutil.rmtree(work_dir, ignore_errors=True)

    size_mb = Path(output_path).stat().st_size / (1024 * 1024)
    duration = template["metadata"]["duration"]
    print(f"[Reel] Output: {output_path} ({size_mb:.1f}MB, {duration}s)", flush=True)
    return output_path


def main():
    parser = argparse.ArgumentParser(description="テンプレートベースのリール動画生成")
    parser.add_argument("--template", required=True, help="テンプレートYAMLパス")
    parser.add_argument("--photos", nargs="+", required=True, help="写真ファイル（カット順）")
    parser.add_argument("--output", default="reel_output.mp4", help="出力ファイルパス")
    args = parser.parse_args()

    for p in args.photos:
        if not Path(p).exists():
            print(f"Error: Photo not found: {p}", file=sys.stderr)
            sys.exit(1)

    generate_reel(args.template, args.photos, args.output)


if __name__ == "__main__":
    main()
