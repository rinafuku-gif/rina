#!/usr/bin/env python3
"""
slide_generator.py — ImageMagickでプロフェッショナル品質のスライドPNGを生成
レイヤー合成方式: 背景 → カード → テキスト を段階的に合成

テキスト配置は -gravity None + 絶対座標で正確に制御
"""

import os
import subprocess
import sys
from pathlib import Path

MAGICK = "magick"
FONT_BOLD = "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"
FONT_LIGHT = "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc"

ACCENT = "#E8734A"
BG_DARK1 = "#0F1923"
BG_DARK2 = "#1A1A2E"
BG_DARK3 = "#16213E"
WHITE = "#FFFFFF"

W = 1080
H = 1920


def _run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        print(f"[Slide] Error: {r.stderr[:200]}", file=sys.stderr, flush=True)
    return r.returncode == 0


def _gradient_bg(output: str, c1: str = BG_DARK1, c2: str = BG_DARK3):
    """グラデーション背景 + アクセントバー"""
    _run([
        MAGICK, "-size", f"{W}x{H}", f"gradient:{c1}-{c2}",
        "-fill", ACCENT, "-draw", f"rectangle 0,0 {W},6",
        output,
    ])


def _draw_text(img: str, text: str, x: int, y: int, size: int, font: str = FONT_BOLD,
               color: str = WHITE, stroke: int = 0, stroke_color: str = "#000000",
               anchor: str = "center"):
    """テキストを正確な座標に描画（レイヤー合成）"""
    # テキスト幅を計測して中央配置を計算
    if anchor == "center":
        gravity = "North"
        annotate_pos = f"+0+{y}"
    elif anchor == "left":
        gravity = "NorthWest"
        annotate_pos = f"+{x}+{y}"
    else:
        gravity = "North"
        annotate_pos = f"+0+{y}"

    cmd = [MAGICK, img]
    if stroke > 0:
        cmd.extend([
            "-font", font, "-pointsize", str(size),
            "-fill", stroke_color, "-stroke", stroke_color, "-strokewidth", str(stroke),
            "-gravity", gravity, "-annotate", annotate_pos, text,
        ])
    cmd.extend([
        "-font", font, "-pointsize", str(size),
        "-fill", color, "-stroke", "none",
        "-gravity", gravity, "-annotate", annotate_pos, text,
        img,  # overwrite in-place
    ])
    _run(cmd)


def _draw_card(img: str, y: int, height: int, width: int = 0, opacity: float = 0.06):
    """カード背景を描画"""
    card_w = width or (W - 120)
    x = (W - card_w) // 2
    _run([
        MAGICK, img,
        "-fill", f"rgba(255,255,255,{opacity})",
        "-draw", f"roundrectangle {x},{y} {x + card_w},{y + height} 16,16",
        img,
    ])


def _draw_brand(img: str):
    """ブランド名を下部に追加"""
    _draw_text(img, "SATOYAMA AI BASE", W // 2, H - 440 - 28, 28,
               font=FONT_LIGHT, color="rgba(255,255,255,0.4)")


def _draw_divider(img: str, y: int, width: int = 80):
    """アクセントカラーの区切り線"""
    x = (W - width) // 2
    _run([
        MAGICK, img,
        "-fill", ACCENT, "-draw", f"roundrectangle {x},{y} {x + width},{y + 4} 2,2",
        img,
    ])


def gen_hook(text: str, sub: str, output: str):
    _gradient_bg(output)
    _draw_text(output, text, W // 2, 680, 72, stroke=3)
    _draw_divider(output, 780)
    if sub:
        _draw_text(output, sub, W // 2, 810, 42, color="rgba(255,255,255,0.85)", stroke=2)
    _draw_brand(output)


def gen_problem(text: str, number: str, output: str):
    _gradient_bg(output, BG_DARK2, BG_DARK2)
    # ゴーストテキスト
    for txt, tx, ty, rot in [
        ("パソコン必須", 80, 380, -12), ("設定が難しい", 700, 450, 8),
        ("若い人向けでしょ", 150, 530, -5), ("うちには関係ない", 600, 620, 12),
    ]:
        _run([
            MAGICK, output,
            "-font", FONT_LIGHT, "-pointsize", "24",
            "-fill", "rgba(255,255,255,0.08)", "-stroke", "none",
            "-gravity", "NorthWest",
            "-draw", f"rotate {rot} text {tx},{ty} '{txt}'",
            output,
        ])
    _draw_text(output, text, W // 2, 720, 60, color=ACCENT, stroke=2)
    if number:
        _draw_text(output, number, W // 2, 830, 84, color=ACCENT, stroke=0)
    _draw_brand(output)


def gen_solution(text: str, sub: str, output: str):
    _gradient_bg(output, BG_DARK2, "#2D1B4E")
    _draw_text(output, "✅", W // 2, 550, 48, color="rgba(255,255,255,0.6)")
    _draw_card(output, 620, 250, opacity=0.08)
    _draw_text(output, text, W // 2, 660, 54, stroke=2)
    _draw_divider(output, 740)
    if sub:
        _draw_text(output, sub, W // 2, 770, 36, font=FONT_LIGHT, color="rgba(255,255,255,0.85)")
    _draw_brand(output)


def gen_step(num: int, title: str, desc: str, output: str):
    _gradient_bg(output)
    _draw_text(output, str(num), 0, 420, 96, color=ACCENT, anchor="left")
    # タイトルは番号の右に
    _draw_text(output, title, W // 2, 440, 54, stroke=2)
    # 説明カード
    _draw_card(output, 570, 200, opacity=0.06)
    # 説明文を改行対応
    lines = []
    while len(desc) > 22:
        lines.append(desc[:22])
        desc = desc[22:]
    if desc:
        lines.append(desc)
    for i, line in enumerate(lines[:3]):
        _draw_text(output, line, W // 2, 600 + i * 50, 36, font=FONT_LIGHT)
    _draw_brand(output)


def gen_comparison(label: str, before: str, after: str, output: str):
    _gradient_bg(output)
    _draw_text(output, "📊", W // 2, 550, 48, color="rgba(255,255,255,0.6)")
    _draw_text(output, label, W // 2, 640, 54, stroke=2)
    # Before → After
    _draw_text(output, before, W // 2 - 200, 790, 72, color="rgba(255,255,255,0.5)", stroke=0)
    _draw_text(output, "→", W // 2, 790, 60, color=ACCENT)
    _draw_text(output, after, W // 2 + 200, 780, 84, color=ACCENT, stroke=0)
    _draw_brand(output)


def gen_summary(text: str, sub: str, output: str):
    _gradient_bg(output, "#1E1108", "#1A1206")
    _draw_card(output, 600, 280, opacity=0.08)
    _draw_text(output, text, W // 2, 650, 60, stroke=2)
    _draw_divider(output, 740)
    if sub:
        _draw_text(output, sub, W // 2, 770, 36, font=FONT_LIGHT, color="rgba(255,255,255,0.85)")
    _draw_brand(output)


def gen_cta(action: str, output: str):
    _gradient_bg(output)
    # CTAボタン
    btn_w = max(len(action) * 54 // 2 + 96, 500)
    bx = (W - btn_w) // 2
    _run([
        MAGICK, output,
        "-fill", f"rgba(232,115,74,0.85)",
        "-draw", f"roundrectangle {bx},660 {bx + btn_w},750 12,12",
        output,
    ])
    _draw_text(output, action, W // 2, 672, 54, stroke=0)
    _draw_text(output, "毎週AI活用術を発信中 → フォロー", W // 2, 810, 42, stroke=0)
    _draw_text(output, "@satoyama_ai_base", W // 2, 880, 32,
               font=FONT_LIGHT, color="rgba(255,255,255,0.5)")
    _draw_brand(output)


def generate_slides_for_script(script: dict, output_dir: str) -> list[str]:
    """リールスクリプトから全8カットのスライドを生成"""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    slides = []

    p = str(output_dir / "slide_01.png")
    gen_hook(script.get("hook_text", ""), script.get("hook_narration", ""), p)
    slides.append(p)

    p = str(output_dir / "slide_02.png")
    gen_problem(script.get("problem_text", ""), script.get("problem_number", ""), p)
    slides.append(p)

    p = str(output_dir / "slide_03.png")
    gen_solution(script.get("solution_text", ""), script.get("solution_narration", ""), p)
    slides.append(p)

    p = str(output_dir / "slide_04.png")
    gen_step(1, script.get("step1_text", ""), script.get("step1_narration", ""), p)
    slides.append(p)

    p = str(output_dir / "slide_05.png")
    gen_step(2, script.get("step2_text", ""), script.get("step2_narration", ""), p)
    slides.append(p)

    p = str(output_dir / "slide_06.png")
    comp = script.get("comparison", "")
    if "→" in comp:
        parts = comp.split("→")
        gen_comparison(script.get("result_text", ""), parts[0].strip(), parts[1].strip(), p)
    else:
        gen_solution(script.get("result_text", ""), comp, p)
    slides.append(p)

    p = str(output_dir / "slide_07.png")
    gen_summary(script.get("summary_text", ""), script.get("summary_narration", ""), p)
    slides.append(p)

    p = str(output_dir / "slide_08.png")
    gen_cta(script.get("cta_action", "保存して始めよう"), p)
    slides.append(p)

    print(f"[Slides] Generated {len(slides)} slides", flush=True)
    return slides


if __name__ == "__main__":
    test = {
        "hook_text": "4月から値上げラッシュ",
        "hook_narration": "知ってました？",
        "problem_text": "手計算じゃ追いつかない",
        "problem_number": "月5時間のムダ",
        "solution_text": "AIで見積もり自動化",
        "solution_narration": "数分で終わります",
        "step1_text": "freeeで請求書AI作成",
        "step1_narration": "AIが請求書を自動で作ってくれます",
        "step2_text": "インボイス対応も一発",
        "step2_narration": "適格請求書の番号も自動対応",
        "result_text": "事務時間が激減",
        "comparison": "月5時間 → 30分",
        "summary_text": "小さいお店こそAI活用",
        "summary_narration": "人を雇わなくてもAIが手伝います",
        "cta_action": "freee無料プランを試す",
    }
    slides = generate_slides_for_script(test, "/tmp/test_slides_v2")
    for s in slides:
        print(f"  {s} ({Path(s).stat().st_size // 1024}KB)")
