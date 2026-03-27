#!/usr/bin/env python3
"""
notion_to_reel.py — NotionコンテンツDB → SATOYAMA AI BASE向けリール動画を自動生成

フロー:
1. Notion APIでコンテンツ取得（タイトル、キーポイント、ビジネスインパクト等）
2. Claude CLIでリール用テキスト（フック/ステップ/CTA）を生成
3. VOICEVOX でナレーション音声を生成
4. generate_reel.py でリール動画を書き出し

Usage:
  python3 notion_to_reel.py --page-id <NotionページID> --output output.mp4
  python3 notion_to_reel.py --db-id <DB_ID> --limit 3 --output-dir ./reels/
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import yaml

REPO_DIR = Path(__file__).parent.parent.parent.parent  # /Users/ocmm/rina
TEMPLATE_PATH = Path(__file__).parent.parent / "templates" / "reel_satoyama.yaml"
VOICEVOX_URL = "http://127.0.0.1:50021"
CLAUDE_PATH = "/Users/ocmm/.local/share/mise/installs/node/24.14.0/bin/claude"
FFMPEG = "ffmpeg"

# デフォルトの背景画像（SATOYAMA AI BASE用）
DEFAULT_BG_DIR = Path("/Users/ocmm/Library/Mobile Documents/com~apple~CloudDocs/40_三十日珈琲/40_デザイン/SNS")


def load_env():
    env = {}
    env_path = REPO_DIR / ".env"
    if env_path.exists():
        for line in env_path.read_text().split("\n"):
            m = line.strip().split("=", 1)
            if len(m) == 2 and not m[0].startswith("#"):
                env[m[0].strip()] = m[1].strip()
    return env


def notion_api(endpoint: str, method: str = "GET", body: dict | None = None) -> dict:
    """Notion API呼び出し"""
    env = load_env()
    token = env.get("NOTION_API_KEY", "")
    if not token:
        raise RuntimeError("NOTION_API_KEY not found in .env")

    url = f"https://api.notion.com/v1/{endpoint}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    }
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def get_page_content(page_id: str) -> dict:
    """Notionページからコンテンツを取得"""
    page = notion_api(f"pages/{page_id}")
    props = page.get("properties", {})

    def get_text(prop_name):
        p = props.get(prop_name, {})
        if p.get("type") == "title":
            return "".join(t.get("plain_text", "") for t in p.get("title", []))
        elif p.get("type") == "rich_text":
            return "".join(t.get("plain_text", "") for t in p.get("rich_text", []))
        elif p.get("type") == "select" and p.get("select"):
            return p["select"]["name"]
        return ""

    return {
        "title": get_text("タイトル"),
        "key_points": get_text("キーポイント"),
        "business_impact": get_text("ビジネスインパクト"),
        "body": get_text("本文"),
        "category": get_text("カテゴリー"),
        "content_type": get_text("コンテンツタイプ"),
        "thumbnail": props.get("サムネイル", {}).get("url", ""),
        "page_id": page_id,
    }


def query_db(db_id: str, limit: int = 5) -> list[dict]:
    """Notionデータベースからコンテンツをクエリ"""
    result = notion_api(f"databases/{db_id}/query", method="POST", body={
        "page_size": limit,
        "filter": {
            "property": "ステータス",
            "select": {"equals": "公開"},
        },
        "sorts": [{"property": "公開日", "direction": "descending"}],
    })
    pages = []
    for page in result.get("results", []):
        pages.append(get_page_content(page["id"]))
    return pages


def generate_reel_script(content: dict) -> dict:
    """Claude CLIでNotionコンテンツからリール用テキストを生成"""
    prompt = f"""あなたはSNSリール動画の構成作家です。以下のNotionの記事を30秒のリール動画にします。

## 記事データ
タイトル: {content['title']}
キーポイント: {content['key_points'][:500]}
ビジネスインパクト: {content['business_impact'][:300]}
本文: {content['body'][:500]}

## ターゲット
山梨県の個人事業主・小規模経営者。ITリテラシーは低め。AIに興味はあるが「自分に関係あるの？」と思っている層。

## 必ず守ること
1. まず記事の核心的メッセージ（著者が一番伝えたいこと）を1文で抽出する
2. 視聴者にとっての価値を明確にする（「これを知ると自分の何が変わるか」）
3. 各カットは抽象的な説明ではなく、具体的なシーン・数字・事例を使う
4. CTAは「何を・どうやって・今すぐ」が明確な具体的行動指示にする
5. フックは記事の中で最もインパクトのある事実・数字・問いかけを使う

## NG
- 「3つ紹介します」のような羅列型は禁止。ストーリーにする
- 「すごい」「進化」等の抽象語だけで終わらせない
- CTAが「保存して試してみて」のような曖昧なものは禁止。何を試すか明記
- ナレーションは「ですます」の口語体。親しみやすく、でも押し付けない

## 構成
カット1（フック 3秒）: 最もインパクトのある事実/問い
カット2（共感 3秒）: 視聴者の現状の課題/思い込み
カット3（転換 3秒）: 解決策がある、という希望
カット4-5（具体 各4秒）: 具体的な方法・ツール名・数字
カット6（結果 4秒）: ビフォーアフター
カット7（着地 4秒）: 視聴者にとっての価値を再確認
カット8（CTA 5秒）: 具体的な行動指示

## 出力（JSONのみ）
{{
  "core_message": "記事の核心メッセージ（1文）",
  "hook_text": "フックテロップ（15字以内）",
  "hook_narration": "フックナレーション（20字以内、口語）",
  "problem_text": "共感テロップ（20字以内）",
  "problem_number": "数字で示すインパクト（例: 月5時間のムダ）",
  "problem_narration": "共感ナレーション（30字以内）",
  "solution_text": "転換テロップ（20字以内）",
  "solution_narration": "転換ナレーション（30字以内）",
  "step1_text": "具体①テロップ（ツール名や手法、15字以内）",
  "step1_narration": "具体①ナレーション（具体的に何をするか、25字以内）",
  "step2_text": "具体②テロップ（15字以内）",
  "step2_narration": "具体②ナレーション（25字以内）",
  "result_text": "結果テロップ（15字以内）",
  "comparison": "ビフォーアフター（例: 月5時間 → 10分）",
  "result_narration": "結果ナレーション（25字以内）",
  "summary_text": "着地テロップ（視聴者への価値、20字以内）",
  "summary_narration": "着地ナレーション（25字以内）",
  "cta_narration": "CTA（具体的行動指示、25字以内）",
  "cta_action": "視聴者がやるべき具体的な1アクション（15字以内）"
}}

JSONのみを出力してください。
"""

    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
        f.write(prompt)
        pf = f.name

    try:
        env = {
            **os.environ, "HOME": "/Users/ocmm",
            "PATH": "/Users/ocmm/.local/share/mise/installs/node/24.14.0/bin:/Users/ocmm/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        }
        env.pop("CLAUDECODE", None)
        env.pop("ANTHROPIC_API_KEY", None)

        result = subprocess.run(
            ["sh", "-c", f'cat "{pf}" | "{CLAUDE_PATH}" -p --model claude-sonnet-4-6 --max-turns 1 --tools ""'],
            capture_output=True, text=True, timeout=90, env=env, cwd=str(REPO_DIR),
        )
        if result.returncode == 0 and result.stdout.strip():
            raw = result.stdout.strip()
            js = raw[raw.find("{"):raw.rfind("}") + 1]
            if js:
                return json.loads(js)
    except Exception as e:
        print(f"[Notion→Reel] Claude error: {e}", file=sys.stderr, flush=True)
    finally:
        try:
            os.unlink(pf)
        except OSError:
            pass

    return {}


def voicevox_tts(text: str, speaker_id: int = 3, speed: float = 1.2) -> bytes:
    """VOICEVOX TTS"""
    query_url = f"{VOICEVOX_URL}/audio_query?speaker={speaker_id}&text={urllib.request.quote(text)}"
    req = urllib.request.Request(query_url, method="POST")
    with urllib.request.urlopen(req) as resp:
        aq = json.loads(resp.read())
    aq["speedScale"] = speed
    synth_url = f"{VOICEVOX_URL}/synthesis?speaker={speaker_id}"
    req = urllib.request.Request(synth_url, data=json.dumps(aq).encode(),
                                headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as resp:
        return resp.read()


def generate_narration(script: dict, template: dict, work_dir: str) -> str:
    """ナレーション音声を生成して1つのWAVに結合"""
    narr_config = template.get("narration", {})
    speaker = narr_config.get("voicevox_speaker", 3)
    speed = narr_config.get("speed_scale", 1.2)
    cuts = template.get("cuts", [])

    segments = []
    for cut in cuts:
        slot = cut.get("narration_slot", "")
        narr_key = f"{slot}_narration"
        text = script.get(narr_key, "")
        if not text:
            # ナレーションなしのカットは無音
            duration = cut["time"][1] - cut["time"][0]
            silence_path = os.path.join(work_dir, f"silence_{cut['id']}.wav")
            subprocess.run([
                FFMPEG, "-y", "-f", "lavfi", "-i",
                f"anullsrc=channel_layout=mono:sample_rate=24000",
                "-t", str(duration), silence_path,
            ], capture_output=True, timeout=10)
            segments.append(silence_path)
            continue

        wav_data = voicevox_tts(text, speaker, speed)
        seg_path = os.path.join(work_dir, f"narr_{cut['id']}.wav")
        Path(seg_path).write_bytes(wav_data)

        # 目標の長さにパディング（短ければ無音追加、長ければカット）
        target_dur = cut["time"][1] - cut["time"][0]
        padded_path = os.path.join(work_dir, f"narr_{cut['id']}_pad.wav")
        subprocess.run([
            FFMPEG, "-y", "-i", seg_path,
            "-af", f"apad=whole_dur={target_dur}",
            "-t", str(target_dur),
            "-ar", "24000", "-ac", "1",
            padded_path,
        ], capture_output=True, timeout=10)
        segments.append(padded_path)

    # 全セグメントを結合
    narr_path = os.path.join(work_dir, "narration.wav")
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        for s in segments:
            f.write(f"file '{s}'\n")
        concat_list = f.name

    subprocess.run([
        FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", concat_list,
        "-c:a", "pcm_s16le", "-ar", "24000", "-ac", "1",
        narr_path,
    ], capture_output=True, timeout=30)
    os.unlink(concat_list)

    print(f"[Notion→Reel] Narration generated: {len(segments)} segments", flush=True)
    return narr_path


def fill_template_text(cuts: list[dict], script: dict) -> list[dict]:
    """テンプレートのテキストプレースホルダをスクリプトの値で埋める"""
    import copy
    filled = copy.deepcopy(cuts)
    for cut in filled:
        for txt in cut.get("text", []):
            content = txt.get("content", "")
            if content.startswith("{") and content.endswith("}"):
                key = content[1:-1]
                txt["content"] = script.get(key, content)
    return filled


def find_background_photos(n: int = 8) -> list[str]:
    """デフォルトの背景画像を探す"""
    photos = []
    for ext in ["*.jpg", "*.jpeg", "*.png"]:
        photos.extend(DEFAULT_BG_DIR.glob(ext))
    # Google Drive からも
    gdrive = Path("/Users/ocmm/Library/CloudStorage/GoogleDrive-r.inafuku@tonari2tomaru.com/マイドライブ/40_三十日珈琲/08.掲載媒体別/04.anatae/掲載ページ写真")
    if gdrive.exists():
        for ext in ["*.jpg", "*.jpeg", "*.png"]:
            photos.extend(gdrive.glob(ext))

    photos = [str(p) for p in photos if p.stat().st_size > 10000][:n]
    return photos


def notion_to_reel(page_id: str, output_path: str, template_path: str | None = None) -> str:
    """Notionページからリール動画を生成"""
    t0 = time.monotonic()
    template_path = template_path or str(TEMPLATE_PATH)
    template = yaml.safe_load(open(template_path))

    # 1. Notionコンテンツ取得
    print(f"[Notion→Reel] Fetching page {page_id}...", flush=True)
    content = get_page_content(page_id)
    print(f"[Notion→Reel] Title: {content['title'][:60]}", flush=True)

    # 2. リール用テキスト生成
    print("[Notion→Reel] Generating reel script...", flush=True)
    script = generate_reel_script(content)
    if not script:
        raise RuntimeError("Failed to generate reel script")
    print(f"[Notion→Reel] Hook: {script.get('hook_text', '?')}", flush=True)

    # 3. テンプレートにテキスト流し込み
    filled_cuts = fill_template_text(template["cuts"], script)
    template["cuts"] = filled_cuts

    # 一時テンプレートYAML保存
    work_dir = tempfile.mkdtemp(prefix="notion_reel_")
    filled_yaml = os.path.join(work_dir, "template_filled.yaml")
    with open(filled_yaml, "w") as f:
        yaml.dump(template, f, allow_unicode=True)

    # 4. ナレーション生成
    print("[Notion→Reel] Generating narration (VOICEVOX)...", flush=True)
    narr_path = generate_narration(script, template, work_dir)

    # 5. HTML + Puppeteer でスライド画像を生成
    slide_dir = os.path.join(work_dir, "slides")
    script_json = os.path.join(work_dir, "script.json")
    Path(script_json).write_text(json.dumps(script, ensure_ascii=False, indent=2))

    render_script = str(Path(__file__).parent.parent / "html-slides" / "render-slides-pw.mjs")
    node_path = "/Users/ocmm/.local/share/mise/installs/node/24.14.0/bin/node"

    print("[Notion→Reel] Rendering slides (Puppeteer)...", flush=True)
    r = subprocess.run(
        [node_path, render_script, script_json, slide_dir],
        capture_output=True, text=True, timeout=180,
        cwd=str(Path(__file__).parent.parent),
    )
    if r.returncode != 0:
        print(f"[Notion→Reel] Puppeteer error: {r.stderr[-300:]}", file=sys.stderr, flush=True)
        # フォールバック: ImageMagickスライド
        from slide_generator import generate_slides_for_script
        photos = generate_slides_for_script(script, slide_dir)
        print(f"[Notion→Reel] Fallback: ImageMagick slides ({len(photos)})", flush=True)
    else:
        print(r.stdout, flush=True)
        photos = sorted(str(p) for p in Path(slide_dir).glob("slide_*.png"))
        print(f"[Notion→Reel] Generated {len(photos)} Puppeteer slides", flush=True)

    # 6. リール動画生成
    print("[Notion→Reel] Generating reel video...", flush=True)
    from generate_reel import generate_reel
    video_path = os.path.join(work_dir, "video_only.mp4")
    generate_reel(filled_yaml, photos, video_path)

    # 7. ナレーション合成
    print("[Notion→Reel] Merging narration...", flush=True)
    output_path = str(Path(output_path).resolve())
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    subprocess.run([
        FFMPEG, "-y",
        "-i", video_path,
        "-i", narr_path,
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "128k",
        "-map", "0:v", "-map", "1:a",
        "-shortest",
        "-movflags", "+faststart",
        output_path,
    ], capture_output=True, text=True, timeout=60)

    # クリーンアップ
    import shutil
    shutil.rmtree(work_dir, ignore_errors=True)

    size_mb = Path(output_path).stat().st_size / (1024 * 1024)
    elapsed = time.monotonic() - t0
    print(f"[Notion→Reel] Done! {output_path} ({size_mb:.1f}MB, {elapsed:.0f}s)", flush=True)
    return output_path


def main():
    parser = argparse.ArgumentParser(description="Notionコンテンツ → リール動画自動生成")
    parser.add_argument("--page-id", help="NotionページID")
    parser.add_argument("--db-id", help="NotionデータベースID（一括生成）")
    parser.add_argument("--limit", type=int, default=5, help="一括生成時の件数")
    parser.add_argument("--output", default="reel_output.mp4", help="出力ファイル")
    parser.add_argument("--output-dir", help="一括生成時の出力ディレクトリ")
    parser.add_argument("--template", default=None, help="テンプレートYAML")
    args = parser.parse_args()

    if args.page_id:
        notion_to_reel(args.page_id, args.output, args.template)

    elif args.db_id:
        out_dir = args.output_dir or "./reels"
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        pages = query_db(args.db_id, args.limit)
        print(f"[Notion→Reel] Generating reels for {len(pages)} pages...", flush=True)
        for i, page in enumerate(pages):
            safe_title = page["title"][:30].replace("/", "_").replace(" ", "_")
            out_file = os.path.join(out_dir, f"reel_{i+1:02d}_{safe_title}.mp4")
            try:
                notion_to_reel(page["page_id"], out_file, args.template)
            except Exception as e:
                print(f"[Notion→Reel] Error for '{page['title'][:40]}': {e}", file=sys.stderr, flush=True)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
