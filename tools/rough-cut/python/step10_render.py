#!/usr/bin/env python3
"""
Step 10: Render — 無音カット + テロップ付きMP4書き出し
ImageMagickでテロップPNG生成 → FFmpeg overlayで合成

入力: 元動画 + cut_proposal.json + telops_reviewed.json (or telops.json)
出力: output.mp4
"""

import json
import os
import subprocess
import sys
from pathlib import Path

FFMPEG = "ffmpeg"
MAGICK = "magick"

# テロップ描画設定
TELOP_FONT = "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"  # macOS日本語フォント
TELOP_BG_COLOR = "rgba(0,0,0,0.6)"
TELOP_TEXT_COLOR = "white"
TELOP_STROKE_COLOR = "black"
TELOP_STROKE_WIDTH = 2
TELOP_PADDING = 16


def build_concat_filter(keep_regions: list[dict]) -> str:
    """keep区間をFFmpeg concatで結合するフィルタ"""
    n = len(keep_regions)
    parts = []
    concat_in = ""

    for i, region in enumerate(keep_regions):
        parts.append(f"[0:v]trim=start={region['start']}:end={region['end']},setpts=PTS-STARTPTS[v{i}];")
        parts.append(f"[0:a]atrim=start={region['start']}:end={region['end']},asetpts=PTS-STARTPTS[a{i}];")
        concat_in += f"[v{i}][a{i}]"

    parts.append(f"{concat_in}concat=n={n}:v=1:a=1[outv][outa]")
    return "".join(parts)


def generate_telop_png(text: str, width: int, font_size: int, output_path: str) -> str:
    """ImageMagickでテロップPNG（透過背景+テキスト）を生成"""
    # テキストの行数に応じた高さ
    lines = text.split("\n")
    line_height = int(font_size * 1.4)
    text_height = line_height * len(lines) + TELOP_PADDING * 2
    text_width = width

    # ImageMagickコマンド
    # 透過PNGに白文字+黒ストローク+半透明背景
    cmd = [
        MAGICK,
        "-size", f"{text_width}x{text_height}",
        "xc:none",  # 透過背景
        # 半透明背景の矩形
        "-fill", TELOP_BG_COLOR,
        "-draw", f"roundrectangle 0,0 {text_width-1},{text_height-1} 8,8",
        # テキスト描画（ストローク）
        "-font", TELOP_FONT,
        "-pointsize", str(font_size),
        "-fill", TELOP_STROKE_COLOR,
        "-stroke", TELOP_STROKE_COLOR,
        "-strokewidth", str(TELOP_STROKE_WIDTH),
        "-gravity", "Center",
        "-annotate", "+0+0", text,
        # テキスト描画（塗り）
        "-stroke", "none",
        "-fill", TELOP_TEXT_COLOR,
        "-annotate", "+0+0", text,
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        print(f"[Step10] ImageMagick error: {result.stderr[:200]}", file=sys.stderr, flush=True)
        return ""
    return output_path


def compute_time_map(keep_regions: list[dict]) -> list[dict]:
    """元のタイムスタンプ→カット後のタイムラインへのマッピング"""
    time_map = []
    new_time = 0.0
    for region in keep_regions:
        time_map.append({
            "orig_start": region["start"],
            "orig_end": region["end"],
            "new_start": new_time,
        })
        new_time += region["end"] - region["start"]
    return time_map


def map_time(orig_t: float, time_map: list[dict]) -> float | None:
    for m in time_map:
        if m["orig_start"] - 0.05 <= orig_t <= m["orig_end"] + 0.05:
            return m["new_start"] + (orig_t - m["orig_start"])
    return None


def render(video_path: str, output_dir: str, output_filename: str = "output.mp4") -> str:
    """カット + テロップ付きMP4をレンダリング"""
    output_dir = Path(output_dir)
    video_path = str(Path(video_path).resolve())

    proposal = json.loads((output_dir / "cut_proposal.json").read_text())
    keep_regions = proposal["keep_regions"]
    metadata = json.loads((output_dir / "metadata.json").read_text())

    telops_path = output_dir / "telops_reviewed.json"
    if not telops_path.exists():
        telops_path = output_dir / "telops.json"
    telops_data = json.loads(telops_path.read_text())
    telops = telops_data.get("telops", [])

    output_path = str(output_dir / output_filename)

    if not keep_regions:
        print("[Step10] No keep regions", flush=True)
        return ""

    # Pass 1: カット結合
    filter_concat = build_concat_filter(keep_regions)
    intermediate = str(output_dir / "_intermediate.mp4")

    print(f"[Step10] Pass 1: Cutting {len(keep_regions)} segments...", flush=True)
    cmd1 = [
        FFMPEG, "-y", "-i", video_path,
        "-filter_complex", filter_concat,
        "-map", "[outv]", "-map", "[outa]",
        "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        "-c:a", "aac", "-b:a", "128k",
        intermediate,
    ]
    r1 = subprocess.run(cmd1, capture_output=True, text=True, timeout=300)
    if r1.returncode != 0:
        raise RuntimeError(f"FFmpeg Pass 1 failed: {r1.stderr[-300:]}")
    print("[Step10] Pass 1 done", flush=True)

    # テロップがなければ中間ファイルが最終出力
    if not telops:
        os.rename(intermediate, output_path)
        print("[Step10] No telops, output is cut-only", flush=True)
        if Path(output_path).exists():
            size_mb = Path(output_path).stat().st_size / (1024 * 1024)
            print(f"[Step10] Output: {output_path} ({size_mb:.1f}MB)", flush=True)
        return output_path

    # テロップPNG生成
    time_map = compute_time_map(keep_regions)
    video_w = metadata["width"]
    telop_pngs_dir = output_dir / "_telop_pngs"
    telop_pngs_dir.mkdir(exist_ok=True)

    # テロップスタイル
    font_size = telops[0].get("style", {}).get("font_size", 48) if telops else 48
    telop_width = int(video_w * 0.9)  # 動画幅の90%

    valid_telops = []
    for i, telop in enumerate(telops):
        new_start = map_time(telop["start"], time_map)
        new_end = map_time(telop["end"], time_map)
        if new_start is None or new_end is None:
            continue

        png_path = str(telop_pngs_dir / f"telop_{i:04d}.png")
        text = telop.get("display_text", telop.get("original_text", ""))
        result = generate_telop_png(text, telop_width, font_size, png_path)
        if result:
            valid_telops.append({
                "png": png_path,
                "start": round(new_start, 3),
                "end": round(new_end, 3),
                "index": i,
            })

    print(f"[Step10] Generated {len(valid_telops)} telop PNGs", flush=True)

    if not valid_telops:
        os.rename(intermediate, output_path)
        print("[Step10] No valid telop PNGs, output is cut-only", flush=True)
    else:
        # Pass 2: テロップoverlayチェーン
        # FFmpeg: 各テロップPNGをinputとして追加し、overlayフィルタで合成
        # 一度に大量のinputを追加するとFFmpegが遅くなるので、最大20個まで
        telops_to_burn = valid_telops[:20]

        inputs = ["-i", intermediate]
        for t in telops_to_burn:
            inputs.extend(["-i", t["png"]])

        # overlayフィルタチェーン
        video_h = metadata["height"]
        margin_bottom = 80 if metadata["orientation"] == "horizontal" else 200

        filter_parts = []
        prev_label = "0:v"
        for idx, t in enumerate(telops_to_burn):
            input_idx = idx + 1
            out_label = f"tmp{idx}" if idx < len(telops_to_burn) - 1 else "outv"
            # overlay位置: 中央下部
            x = f"(W-w)/2"
            y = f"H-h-{margin_bottom}"
            enable = f"between(t,{t['start']},{t['end']})"
            filter_parts.append(
                f"[{prev_label}][{input_idx}:v]overlay={x}:{y}:enable='{enable}'[{out_label}]"
            )
            prev_label = out_label

        filter_complex = ";".join(filter_parts)

        cmd2 = [
            FFMPEG, "-y",
            *inputs,
            "-filter_complex", filter_complex,
            "-map", "[outv]", "-map", "0:a",
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-c:a", "copy",
            "-movflags", "+faststart",
            output_path,
        ]

        print(f"[Step10] Pass 2: Burning {len(telops_to_burn)} telops...", flush=True)
        r2 = subprocess.run(cmd2, capture_output=True, text=True, timeout=300)

        if r2.returncode != 0:
            print(f"[Step10] Pass 2 error: {r2.stderr[-300:]}", file=sys.stderr, flush=True)
            os.rename(intermediate, output_path)
            print("[Step10] Fallback: cut-only output", flush=True)
        else:
            try:
                os.unlink(intermediate)
            except OSError:
                pass
            print("[Step10] Rendered with telops!", flush=True)

    # クリーンアップ
    try:
        import shutil
        shutil.rmtree(str(telop_pngs_dir), ignore_errors=True)
    except Exception:
        pass

    if Path(output_path).exists():
        size_mb = Path(output_path).stat().st_size / (1024 * 1024)
        print(f"[Step10] Output: {output_path} ({size_mb:.1f}MB)", flush=True)

    return output_path


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <video_path> <output_dir> [output_filename]")
        sys.exit(1)
    fname = sys.argv[3] if len(sys.argv) > 3 else "output.mp4"
    render(sys.argv[1], sys.argv[2], fname)
