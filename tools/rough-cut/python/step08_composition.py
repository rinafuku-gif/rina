#!/usr/bin/env python3
"""
Step 08: Composition — テロップ生成 + BudouX改行最適化 + 漢数字変換
入力: stt.json + cut_proposal.json + template yaml
出力: telops.json（タイムスタンプ付きテロップデータ）

BudouX + DPアルゴリズムで自然な改行位置を決定
"""

import json
import math
import re
import sys
from pathlib import Path

import budoux
import yaml

# ── BudouX パーサー ──────────────────────────────
parser = budoux.load_default_japanese_parser()


# ── 漢数字変換 ───────────────────────────────────
KANJI_MAP = {
    "0": "〇", "1": "一", "2": "二", "3": "三", "4": "四",
    "5": "五", "6": "六", "7": "七", "8": "八", "9": "九",
}


def arabic_to_kanji(text: str) -> str:
    """アラビア数字を漢数字に変換（テロップ用）"""
    def replace_number(m):
        num = m.group(0)
        if len(num) > 4:  # 5桁以上はそのまま
            return num
        return "".join(KANJI_MAP.get(c, c) for c in num)
    return re.sub(r"\d+", replace_number, text)


# ── DPテロップ改行 ───────────────────────────────

def dp_line_break(chunks: list[str], max_chars: int, max_lines: int = 2) -> list[str]:
    """
    動的計画法でBudouXチャンクを最適改行する。
    各行がmax_chars以内で、行間の文字数バランスが最も均等になる分割を求める。
    """
    n = len(chunks)
    if n == 0:
        return [""]

    # 全チャンク結合がmax_chars以内なら改行不要
    full = "".join(chunks)
    if len(full) <= max_chars:
        return [full]

    # 各チャンクの累積文字数
    cum_len = [0] * (n + 1)
    for i in range(n):
        cum_len[i + 1] = cum_len[i] + len(chunks[i])
    total_len = cum_len[n]

    # DPでmax_lines行に分割する最適コストを計算
    # cost(i, j) = i番目からj-1番目のチャンクを1行にした時の文字数
    def line_len(i, j):
        return cum_len[j] - cum_len[i]

    # 理想の1行あたりの文字数
    ideal = total_len / max_lines

    # dp[i][k] = chunks[0:i]をk行で表示した時の最小コスト
    INF = float("inf")
    dp = [[INF] * (max_lines + 1) for _ in range(n + 1)]
    parent = [[(-1, -1)] * (max_lines + 1) for _ in range(n + 1)]
    dp[0][0] = 0

    for i in range(1, n + 1):
        for k in range(1, min(i, max_lines) + 1):
            for j in range(k - 1, i):
                ll = line_len(j, i)
                if ll > max_chars:
                    continue
                # コスト: 理想からの偏差の二乗
                cost = dp[j][k - 1] + (ll - ideal) ** 2
                if cost < dp[i][k]:
                    dp[i][k] = cost
                    parent[i][k] = (j, k - 1)

    # 最適な行数を選択
    best_k = min(range(1, max_lines + 1), key=lambda k: dp[n][k])

    if dp[n][best_k] == INF:
        # DPで解が見つからない場合（文字数超過）→ 強制分割
        return force_break(full, max_chars)

    # 復元
    lines = []
    pos, k = n, best_k
    while k > 0:
        prev_pos, prev_k = parent[pos][k]
        line = "".join(chunks[prev_pos:pos])
        lines.append(line)
        pos, k = prev_pos, prev_k
    lines.reverse()

    return lines


def force_break(text: str, max_chars: int) -> list[str]:
    """max_charsを超える場合の強制改行"""
    lines = []
    while len(text) > max_chars:
        # なるべく句読点や助詞の後で切る
        best = max_chars
        for sep in ["、", "。", "が", "は", "を", "に", "で", "と", "の"]:
            idx = text[:max_chars].rfind(sep)
            if idx > max_chars // 2:
                best = idx + 1
                break
        lines.append(text[:best])
        text = text[best:]
    if text:
        lines.append(text)
    return lines


def format_telop_text(text: str, max_chars: int, max_lines: int = 2, use_kanji: bool = False) -> str:
    """テキストをテロップ用に改行最適化"""
    if use_kanji:
        text = arabic_to_kanji(text)

    # BudouXで分割
    chunks = parser.parse(text)

    # DP改行
    lines = dp_line_break(chunks, max_chars, max_lines)

    return "\n".join(lines)


# ── テロップ生成 ─────────────────────────────────

def generate_telops(output_dir: str, template_path: str | None = None) -> dict:
    """STT + カット提案からテロップデータを生成"""
    output_dir = Path(output_dir)

    stt = json.loads((output_dir / "stt.json").read_text())
    metadata = json.loads((output_dir / "metadata.json").read_text())

    # カット提案がある場合はkeep区間のみ使用
    proposal_path = output_dir / "cut_proposal.json"
    if proposal_path.exists():
        proposal = json.loads(proposal_path.read_text())
        keep_regions = proposal["keep_regions"]
    else:
        keep_regions = [{"start": 0, "end": metadata["duration"]}]

    # テンプレート読み込み
    if template_path is None:
        orientation = metadata.get("orientation", "horizontal")
        template_dir = Path(__file__).parent.parent / "templates"
        template_path = str(template_dir / f"{orientation}.yaml")

    with open(template_path) as f:
        template = yaml.safe_load(f)

    telop_config = template.get("telop", {})
    max_chars = telop_config.get("max_chars_per_line", 16)
    max_lines = telop_config.get("max_lines", 2)

    # keep区間に含まれるセグメントからテロップを生成
    telops = []
    telop_id = 0

    for seg in stt["segments"]:
        # このセグメントがkeep区間に含まれるか
        in_keep = any(
            k["start"] <= seg["start"] and seg["end"] <= k["end"] + 0.1
            for k in keep_regions
        )
        if not in_keep:
            # 部分的に重なる場合も含める
            in_keep = any(
                k["start"] < seg["end"] and seg["start"] < k["end"]
                for k in keep_regions
            )

        if not in_keep:
            continue

        text = seg["text"].strip()
        if not text:
            continue

        # テロップテキスト整形
        formatted = format_telop_text(text, max_chars, max_lines)

        telop = {
            "id": telop_id,
            "start": seg["start"],
            "end": seg["end"],
            "duration": round(seg["end"] - seg["start"], 3),
            "original_text": text,
            "display_text": formatted,
            "lines": formatted.split("\n"),
            "style": {
                "font_size": telop_config.get("font_size", 48),
                "font_family": telop_config.get("font_family", "Noto Sans JP"),
                "color": telop_config.get("color", "#FFFFFF"),
                "stroke_color": telop_config.get("stroke_color", "#000000"),
                "stroke_width": telop_config.get("stroke_width", 3),
                "position": telop_config.get("position", "bottom"),
            },
        }
        telops.append(telop)
        telop_id += 1

    result = {
        "telops": telops,
        "telop_count": len(telops),
        "template": template_path,
        "max_chars_per_line": max_chars,
        "max_lines": max_lines,
    }

    telop_path = output_dir / "telops.json"
    telop_path.write_text(json.dumps(result, ensure_ascii=False, indent=2))

    print(f"[Step08] {len(telops)} telops generated", flush=True)
    if telops:
        print(f"[Step08] Sample: {telops[0]['display_text'][:60]}", flush=True)
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <output_dir> [template.yaml]")
        sys.exit(1)
    tmpl = sys.argv[2] if len(sys.argv) > 2 else None
    generate_telops(sys.argv[1], tmpl)
