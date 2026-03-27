#!/usr/bin/env python3
"""
Step 06: Retake Detect — Claude Codeが言い直し（リテイク）を検出
同じ内容を言い直している箇所を見つけ、前の発話をカット候補にする
入力: stt.json
出力: retakes.json
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

CLAUDE_PATH = "/Users/ocmm/.local/share/mise/installs/node/24.14.0/bin/claude"
REPO_DIR = Path(__file__).parent.parent.parent.parent


def detect_retakes(stt_path: str, output_dir: str) -> dict:
    """Claudeで言い直し箇所を検出"""
    output_dir = Path(output_dir)
    stt = json.loads(Path(stt_path).read_text())

    segments_text = ""
    for seg in stt["segments"]:
        segments_text += f"[{seg['start']:.1f}-{seg['end']:.1f}] {seg['text']}\n"

    prompt = f"""以下は動画の文字起こし（タイムスタンプ付き）です。
話者が言い直し（リテイク）をしている箇所を検出してください。

## 文字起こし
{segments_text[:4000]}

## 言い直しの判定基準
- 同じ内容を2回以上言っている（最初の方をカット）
- 言いかけて止め、別の言い方で言い直している
- 明らかな言い間違い → 修正

## 出力形式（JSONのみ）
{{"retakes": [
  {{
    "cut_start": 0.0,
    "cut_end": 2.5,
    "keep_start": 2.5,
    "keep_end": 5.0,
    "reason": "同じ内容の言い直し"
  }}
]}}

言い直しがなければ空配列を返してください: {{"retakes": []}}
JSONのみを出力してください。
"""

    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
        f.write(prompt)
        prompt_file = f.name

    retakes = []
    try:
        env = {
            **os.environ, "HOME": "/Users/ocmm",
            "PATH": "/Users/ocmm/.local/share/mise/installs/node/24.14.0/bin:/Users/ocmm/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        }
        env.pop("CLAUDECODE", None)
        env.pop("ANTHROPIC_API_KEY", None)

        result = subprocess.run(
            ["sh", "-c", f'cat "{prompt_file}" | "{CLAUDE_PATH}" -p --model claude-haiku-4-5-20251001 --max-turns 1 --tools ""'],
            capture_output=True, text=True, timeout=60, env=env, cwd=str(REPO_DIR),
        )

        if result.returncode == 0 and result.stdout.strip():
            raw = result.stdout.strip()
            json_match = raw[raw.find("{"):raw.rfind("}") + 1] if "{" in raw else ""
            if json_match:
                parsed = json.loads(json_match)
                retakes = parsed.get("retakes", [])
    except Exception as e:
        print(f"[Step06] Claude retake error: {e}", file=sys.stderr, flush=True)
    finally:
        try:
            os.unlink(prompt_file)
        except OSError:
            pass

    result = {
        "retakes": retakes,
        "retake_count": len(retakes),
        "total_cut_duration": round(
            sum(r["cut_end"] - r["cut_start"] for r in retakes), 3
        ),
    }

    retake_path = output_dir / "retakes.json"
    retake_path.write_text(json.dumps(result, ensure_ascii=False, indent=2))

    print(f"[Step06] {len(retakes)} retakes detected ({result['total_cut_duration']:.1f}s)", flush=True)
    return result


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <stt.json> <output_dir>")
        sys.exit(1)
    detect_retakes(sys.argv[1], sys.argv[2])
