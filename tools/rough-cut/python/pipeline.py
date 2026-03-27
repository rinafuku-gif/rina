#!/usr/bin/env python3
"""
rough-cut pipeline — Step 1-4 を順番に実行
Usage: python3 pipeline.py <video_path> [output_dir]
"""

import json
import sys
import time
from pathlib import Path

from step01_preprocess import preprocess
from step02_stt import transcribe
from step03_vad import run_vad
from step04_filler_detect import detect_fillers
from step05_filler_review import review_fillers
from step06_retake_detect import detect_retakes
from step07_cut_proposal import build_cut_proposal
from step08_composition import generate_telops
from step09_review import review_telops
from step10_render import render


def run_pipeline(video_path: str, output_dir: str | None = None) -> dict:
    """Step 1-4 パイプライン実行"""
    video_path = str(Path(video_path).resolve())
    if output_dir is None:
        output_dir = str(Path(video_path).parent / f"{Path(video_path).stem}_roughcut")
    output_dir = str(Path(output_dir).resolve())
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    results = {}
    t_total = time.monotonic()

    # Step 1: Preprocess
    print("\n=== Step 01: Preprocess ===", flush=True)
    t0 = time.monotonic()
    metadata = preprocess(video_path, output_dir)
    results["metadata"] = metadata
    print(f"  Done in {time.monotonic()-t0:.1f}s", flush=True)

    # Step 2: STT
    print("\n=== Step 02: STT (whisper) ===", flush=True)
    t0 = time.monotonic()
    stt = transcribe(metadata["audio_path"], output_dir)
    results["stt"] = {"segments": len(stt["segments"]), "words": len(stt["words"])}
    print(f"  Done in {time.monotonic()-t0:.1f}s", flush=True)

    # Step 3: VAD
    print("\n=== Step 03: VAD (silence detection) ===", flush=True)
    t0 = time.monotonic()
    vad = run_vad(metadata["audio_path"], output_dir, metadata["duration"])
    results["vad"] = {
        "silences": len(vad["silences"]),
        "speech_segments": len(vad["speech_segments"]),
        "silence_total": vad["silence_total"],
    }
    print(f"  Done in {time.monotonic()-t0:.1f}s", flush=True)

    # Step 4: Filler Detection
    print("\n=== Step 04: Filler Detection ===", flush=True)
    t0 = time.monotonic()
    stt_json_path = Path(output_dir) / "stt.json"
    fillers = detect_fillers(str(stt_json_path), output_dir)
    results["fillers"] = {
        "count": fillers["filler_count"],
        "total_duration": fillers["filler_total_duration"],
        "top": fillers["top_fillers"][:5],
    }
    print(f"  Done in {time.monotonic()-t0:.1f}s", flush=True)

    # Step 5: Filler Review (Claude)
    print("\n=== Step 05: Filler Review (Claude) ===", flush=True)
    t0 = time.monotonic()
    stt_json = str(Path(output_dir) / "stt.json")
    fillers_json = str(Path(output_dir) / "fillers.json")
    reviewed = review_fillers(stt_json, fillers_json, output_dir)
    cut_count = sum(1 for f in reviewed.get("merged_fillers", []) if f.get("action") == "cut")
    results["filler_review"] = {"cut": cut_count, "keep": len(reviewed.get("merged_fillers", [])) - cut_count}
    print(f"  Done in {time.monotonic()-t0:.1f}s", flush=True)

    # Step 6: Retake Detection (Claude)
    print("\n=== Step 06: Retake Detection (Claude) ===", flush=True)
    t0 = time.monotonic()
    retakes = detect_retakes(stt_json, output_dir)
    results["retakes"] = {"count": retakes["retake_count"], "cut_duration": retakes["total_cut_duration"]}
    print(f"  Done in {time.monotonic()-t0:.1f}s", flush=True)

    # Step 7: Cut Proposal
    print("\n=== Step 07: Cut Proposal ===", flush=True)
    t0 = time.monotonic()
    proposal = build_cut_proposal(output_dir)
    results["cut_proposal"] = {
        "cuts": proposal["cut_count"],
        "keeps": proposal["keep_count"],
        "compression": proposal["compression_ratio"],
    }
    print(f"  Done in {time.monotonic()-t0:.1f}s", flush=True)

    # Step 8: Composition (Telops)
    print("\n=== Step 08: Composition (Telops) ===", flush=True)
    t0 = time.monotonic()
    telops = generate_telops(output_dir)
    results["telops"] = {"count": telops["telop_count"]}
    print(f"  Done in {time.monotonic()-t0:.1f}s", flush=True)

    # Step 9: Review (Claude)
    print("\n=== Step 09: Telop Review (Claude) ===", flush=True)
    t0 = time.monotonic()
    telops_json = str(Path(output_dir) / "telops.json")
    reviewed_telops = review_telops(telops_json, output_dir)
    results["review"] = {"corrections": reviewed_telops.get("corrections_count", 0)}
    print(f"  Done in {time.monotonic()-t0:.1f}s", flush=True)

    # Step 10: Render
    print("\n=== Step 10: Render (FFmpeg) ===", flush=True)
    t0 = time.monotonic()
    output_mp4 = render(video_path, output_dir)
    results["render"] = {"output": output_mp4}
    print(f"  Done in {time.monotonic()-t0:.1f}s", flush=True)

    # Summary
    total_time = time.monotonic() - t_total
    results["pipeline_duration"] = round(total_time, 1)

    summary_path = Path(output_dir) / "pipeline_summary.json"
    summary_path.write_text(json.dumps(results, ensure_ascii=False, indent=2))

    print(f"\n=== Pipeline Complete ({total_time:.1f}s) ===", flush=True)
    print(f"  Video: {metadata['orientation']} {metadata['width']}x{metadata['height']}, {metadata['duration']:.1f}s", flush=True)
    print(f"  STT: {results['stt']['segments']} segments, {results['stt']['words']} words", flush=True)
    print(f"  VAD: {results['vad']['silences']} silences ({results['vad']['silence_total']:.1f}s)", flush=True)
    print(f"  Fillers: {results['fillers']['count']} ({results['fillers']['total_duration']:.1f}s)", flush=True)
    print(f"  Retakes: {results['retakes']['count']} ({results['retakes']['cut_duration']:.1f}s)", flush=True)
    print(f"  Compression: {results['cut_proposal']['compression']}% kept", flush=True)
    print(f"  Telops: {results['telops']['count']}", flush=True)
    print(f"  Output: {output_dir}", flush=True)

    return results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <video_path> [output_dir]")
        sys.exit(1)
    out = sys.argv[2] if len(sys.argv) > 2 else None
    run_pipeline(sys.argv[1], out)
