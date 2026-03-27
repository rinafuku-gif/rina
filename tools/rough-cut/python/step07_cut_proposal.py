#!/usr/bin/env python3
"""
Step 07: Cut Proposal — 全結果を統合してカット提案を生成
入力: vad.json + fillers_reviewed.json + retakes.json + stt.json
出力: cut_proposal.json（タイムライン上のカット/キープ区間）
"""

import json
import sys
from pathlib import Path


def merge_cut_regions(regions: list[dict]) -> list[dict]:
    """重複するカット区間をマージ"""
    if not regions:
        return []
    sorted_r = sorted(regions, key=lambda x: x["start"])
    merged = [sorted_r[0].copy()]
    for r in sorted_r[1:]:
        if r["start"] <= merged[-1]["end"] + 0.05:  # 50msのマージン
            merged[-1]["end"] = max(merged[-1]["end"], r["end"])
            merged[-1]["reasons"].extend(r.get("reasons", []))
        else:
            merged.append(r.copy())
    return merged


def build_cut_proposal(output_dir: str) -> dict:
    """全分析結果を統合してカット提案を生成"""
    output_dir = Path(output_dir)

    vad = json.loads((output_dir / "vad.json").read_text())
    stt = json.loads((output_dir / "stt.json").read_text())

    # オプショナルファイル
    fillers_path = output_dir / "fillers_reviewed.json"
    if not fillers_path.exists():
        fillers_path = output_dir / "fillers.json"
    fillers = json.loads(fillers_path.read_text()) if fillers_path.exists() else {"merged_fillers": []}

    retakes_path = output_dir / "retakes.json"
    retakes = json.loads(retakes_path.read_text()) if retakes_path.exists() else {"retakes": []}

    # カット候補の収集
    cut_regions = []

    # 1. 無音区間（0.8秒以上の無音をカット、ただし0.3秒の余白は残す）
    for s in vad["silences"]:
        if s["duration"] > 0.8:
            cut_regions.append({
                "start": round(s["start"] + 0.15, 3),  # 前後0.15秒の余白
                "end": round(s["end"] - 0.15, 3),
                "reasons": ["silence"],
            })

    # 2. フィラー（reviewでcutと判定されたもの）
    for f in fillers.get("merged_fillers", []):
        if f.get("action") == "cut":
            cut_regions.append({
                "start": f["start"],
                "end": f["end"],
                "reasons": [f"filler: {','.join(f['words'])}"],
            })

    # 3. リテイク（カット対象区間）
    for r in retakes.get("retakes", []):
        cut_regions.append({
            "start": r["cut_start"],
            "end": r["cut_end"],
            "reasons": [f"retake: {r.get('reason', '')}"],
        })

    # マージ
    merged_cuts = merge_cut_regions(cut_regions)

    # キープ区間を計算
    total_duration = vad["total_duration"]
    keep_regions = []
    prev_end = 0.0

    for cut in merged_cuts:
        if cut["start"] > prev_end + 0.05:
            keep_regions.append({
                "start": round(prev_end, 3),
                "end": round(cut["start"], 3),
                "duration": round(cut["start"] - prev_end, 3),
            })
        prev_end = cut["end"]

    if total_duration > prev_end + 0.05:
        keep_regions.append({
            "start": round(prev_end, 3),
            "end": round(total_duration, 3),
            "duration": round(total_duration - prev_end, 3),
        })

    cut_total = round(sum(c["end"] - c["start"] for c in merged_cuts), 3)
    keep_total = round(sum(k["duration"] for k in keep_regions), 3)

    proposal = {
        "total_duration": total_duration,
        "cut_regions": merged_cuts,
        "keep_regions": keep_regions,
        "cut_count": len(merged_cuts),
        "keep_count": len(keep_regions),
        "cut_total_duration": cut_total,
        "keep_total_duration": keep_total,
        "compression_ratio": round(keep_total / total_duration * 100, 1) if total_duration > 0 else 100,
    }

    proposal_path = output_dir / "cut_proposal.json"
    proposal_path.write_text(json.dumps(proposal, ensure_ascii=False, indent=2))

    print(f"[Step07] {len(merged_cuts)} cuts, {len(keep_regions)} keeps", flush=True)
    print(f"[Step07] Cut: {cut_total:.1f}s, Keep: {keep_total:.1f}s ({proposal['compression_ratio']}%)", flush=True)
    return proposal


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <output_dir>")
        sys.exit(1)
    build_cut_proposal(sys.argv[1])
