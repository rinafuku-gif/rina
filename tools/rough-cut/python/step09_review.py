#!/usr/bin/env python3
"""
Step 09: Review — Claude Codeが誤字脱字を修正
入力: telops.json
出力: telops_reviewed.json
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

CLAUDE_PATH = "/Users/ocmm/.local/share/mise/installs/node/24.14.0/bin/claude"
REPO_DIR = Path(__file__).parent.parent.parent.parent


def review_telops(telops_path: str, output_dir: str) -> dict:
    """Claudeでテロップの誤字脱字を修正"""
    output_dir = Path(output_dir)
    telops_data = json.loads(Path(telops_path).read_text())
    telops = telops_data["telops"]

    if not telops:
        print("[Step09] No telops to review", flush=True)
        telops_data["reviewed"] = True
        (output_dir / "telops_reviewed.json").write_text(
            json.dumps(telops_data, ensure_ascii=False, indent=2))
        return telops_data

    # テロップテキスト一覧
    telop_texts = "\n".join(
        f'{i}: "{t["original_text"]}"' for i, t in enumerate(telops)
    )

    prompt = f"""以下は動画のテロップテキスト（whisperによる文字起こし）です。
誤字脱字、不自然な表現、whisperの誤認識を修正してください。

## テロップ一覧
{telop_texts[:3000]}

## ルール
- 明らかな誤字脱字のみ修正
- 話し言葉の特徴はそのまま残す（口語体を書き言葉に直さない）
- 固有名詞の誤認識を修正（地名、人名、サービス名等）
- 修正がないテロップは含めなくてよい

## 出力形式（JSONのみ）
{{"corrections": [{{"index": 0, "original": "誤ったテキスト", "corrected": "正しいテキスト"}}]}}

修正がなければ: {{"corrections": []}}
JSONのみを出力してください。
"""

    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
        f.write(prompt)
        prompt_file = f.name

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

        corrections = 0
        if result.returncode == 0 and result.stdout.strip():
            raw = result.stdout.strip()
            json_start = raw.find("{")
            json_end = raw.rfind("}") + 1
            if json_start >= 0 and json_end > json_start:
                parsed = json.loads(raw[json_start:json_end])
                for c in parsed.get("corrections", []):
                    idx = c.get("index", -1)
                    if 0 <= idx < len(telops):
                        telops[idx]["original_text"] = c.get("corrected", telops[idx]["original_text"])
                        # display_textも再生成
                        from step08_composition import format_telop_text
                        telops[idx]["display_text"] = format_telop_text(
                            telops[idx]["original_text"],
                            telops_data.get("max_chars_per_line", 16),
                            telops_data.get("max_lines", 2),
                        )
                        telops[idx]["lines"] = telops[idx]["display_text"].split("\n")
                        corrections += 1

    except Exception as e:
        print(f"[Step09] Claude review error: {e}", file=sys.stderr, flush=True)
    finally:
        try:
            os.unlink(prompt_file)
        except OSError:
            pass

    telops_data["reviewed"] = True
    telops_data["corrections_count"] = corrections

    reviewed_path = output_dir / "telops_reviewed.json"
    reviewed_path.write_text(json.dumps(telops_data, ensure_ascii=False, indent=2))

    print(f"[Step09] {corrections} corrections applied", flush=True)
    return telops_data


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <telops.json> <output_dir>")
        sys.exit(1)
    review_telops(sys.argv[1], sys.argv[2])
