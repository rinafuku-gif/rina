#!/usr/bin/env python3
"""
Step 05: Filler Review — Claude Codeがフィラー検出結果をレビュー
辞書ベースのフィラー検出に誤検出がないか、文脈を見て判断
入力: stt.json + fillers.json
出力: fillers_reviewed.json
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

CLAUDE_PATH = "/Users/ocmm/.local/share/mise/installs/node/24.14.0/bin/claude"
REPO_DIR = Path(__file__).parent.parent.parent.parent  # /Users/ocmm/rina


def review_fillers(stt_path: str, fillers_path: str, output_dir: str) -> dict:
    """Claudeでフィラー検出結果をレビュー"""
    output_dir = Path(output_dir)
    stt = json.loads(Path(stt_path).read_text())
    fillers = json.loads(Path(fillers_path).read_text())

    if not fillers["merged_fillers"]:
        print("[Step05] No fillers to review", flush=True)
        reviewed = fillers.copy()
        reviewed["reviewed"] = True
        (output_dir / "fillers_reviewed.json").write_text(
            json.dumps(reviewed, ensure_ascii=False, indent=2))
        return reviewed

    # プロンプト構築
    prompt = f"""以下は動画の文字起こしテキストとフィラー検出結果です。
フィラーとして検出されたワードが本当にカットすべきフィラーか、文脈上必要な言葉かを判定してください。

## 全文
{stt['text'][:3000]}

## 検出されたフィラー（カット候補）
{json.dumps(fillers['merged_fillers'][:30], ensure_ascii=False, indent=2)}

## 指示
各フィラーについて、以下のJSON形式で判定結果を返してください：
- "keep": 文脈上必要なのでカットしない
- "cut": フィラーなのでカットする

JSONのみを出力してください：
{{"decisions": [{{"index": 0, "action": "cut"}}, ...]}}
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

        if result.returncode == 0 and result.stdout.strip():
            # JSONを抽出
            raw = result.stdout.strip()
            json_match = raw[raw.find("{"):raw.rfind("}") + 1] if "{" in raw else ""
            if json_match:
                decisions = json.loads(json_match)
                for d in decisions.get("decisions", []):
                    idx = d.get("index", -1)
                    if 0 <= idx < len(fillers["merged_fillers"]):
                        fillers["merged_fillers"][idx]["action"] = d.get("action", "cut")
    except Exception as e:
        print(f"[Step05] Claude review error: {e}", file=sys.stderr, flush=True)
    finally:
        try:
            os.unlink(prompt_file)
        except OSError:
            pass

    fillers["reviewed"] = True
    cut_count = sum(1 for f in fillers["merged_fillers"] if f.get("action") == "cut")
    keep_count = len(fillers["merged_fillers"]) - cut_count

    reviewed_path = output_dir / "fillers_reviewed.json"
    reviewed_path.write_text(json.dumps(fillers, ensure_ascii=False, indent=2))

    print(f"[Step05] Reviewed: {cut_count} cut, {keep_count} keep", flush=True)
    return fillers


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(f"Usage: {sys.argv[0]} <stt.json> <fillers.json> <output_dir>")
        sys.exit(1)
    review_fillers(sys.argv[1], sys.argv[2], sys.argv[3])
