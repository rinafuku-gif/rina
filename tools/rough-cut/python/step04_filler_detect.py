#!/usr/bin/env python3
"""
Step 04: Filler Detect — フィラーワード検出
辞書ベースの29パターンマッチング
入力: stt.json（word-level timestamps）
出力: fillers.json（フィラー区間リスト + カット提案）
"""

import json
import re
import sys
from pathlib import Path

# フィラーワード辞書（29パターン）
FILLER_PATTERNS = [
    # 言い淀み系
    r"^あー+$", r"^えー+$", r"^うー+$", r"^んー+$",
    r"^あー+っと$", r"^えー+っと$", r"^えっと$",
    r"^あのー*$", r"^そのー*$", r"^まぁ?$",
    # つなぎ系
    r"^なんか$", r"^なんて言うか$", r"^なんていうか$",
    r"^ちょっと$", r"^やっぱり?$", r"^やっぱ$",
    r"^まあ$", r"^こう$", r"^ほら$",
    # 確認系
    r"^ね[ぇえ]?$", r"^ねっ$", r"^さ[ぁあ]?$",
    # 反復・口癖系
    r"^で[ぇえ]?$", r"^いや$", r"^ほんとに?$",
    r"^要は$", r"^基本的に$",
    # 接続系（文頭のみフィラー）
    r"^それで$", r"^だから$",
]

FILLER_REGEXES = [re.compile(p) for p in FILLER_PATTERNS]


def is_filler(word: str) -> bool:
    """ワードがフィラーかどうか判定"""
    w = word.strip()
    if not w:
        return False
    return any(rx.match(w) for rx in FILLER_REGEXES)


def detect_fillers(stt_path: str, output_dir: str) -> dict:
    """STT結果からフィラーを検出"""
    output_dir = Path(output_dir)
    stt_data = json.loads(Path(stt_path).read_text())

    fillers = []
    filler_words_count = {}

    for word_info in stt_data.get("words", []):
        word = word_info["word"].strip()
        if is_filler(word):
            filler = {
                "word": word,
                "start": word_info["start"],
                "end": word_info["end"],
                "duration": round(word_info["end"] - word_info["start"], 3),
                "probability": word_info.get("probability", 0),
            }
            fillers.append(filler)
            filler_words_count[word] = filler_words_count.get(word, 0) + 1

    # フィラー区間の統合（連続するフィラーをまとめる）
    merged = []
    for f in fillers:
        if merged and f["start"] - merged[-1]["end"] < 0.15:  # 150ms以内なら統合
            merged[-1]["end"] = f["end"]
            merged[-1]["duration"] = round(merged[-1]["end"] - merged[-1]["start"], 3)
            merged[-1]["words"].append(f["word"])
        else:
            merged.append({
                "start": f["start"],
                "end": f["end"],
                "duration": f["duration"],
                "words": [f["word"]],
                "action": "cut",  # デフォルトでカット提案
            })

    result = {
        "fillers": fillers,
        "merged_fillers": merged,
        "filler_count": len(fillers),
        "filler_total_duration": round(sum(f["duration"] for f in fillers), 3),
        "top_fillers": sorted(filler_words_count.items(), key=lambda x: -x[1])[:10],
    }

    filler_path = output_dir / "fillers.json"
    filler_path.write_text(json.dumps(result, ensure_ascii=False, indent=2))

    print(f"[Step04] {len(fillers)} fillers detected ({result['filler_total_duration']:.1f}s total)", flush=True)
    if result["top_fillers"]:
        top3 = ", ".join(f"{w}({n})" for w, n in result["top_fillers"][:3])
        print(f"[Step04] Top fillers: {top3}", flush=True)
    return result


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <stt.json> <output_dir>")
        sys.exit(1)
    result = detect_fillers(sys.argv[1], sys.argv[2])
    print(f"Fillers: {result['filler_count']}, Merged: {len(result['merged_fillers'])}")
