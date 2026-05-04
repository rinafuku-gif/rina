/**
 * render-slides-pw.mjs — Playwright版 HTMLスライドレンダラー
 * Usage: node render-slides-pw.mjs <script.json> <output_dir>
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_CSS = readFileSync(join(__dirname, 'template.html'), 'utf-8')
  .match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';

const W = 1080;
const H = 1920;

function esc(t) {
  return (t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// デフォルト設定
const DEFAULTS = {
  brand_name: 'SATOYAMA AI BASE',
  accent_color: '#E8734A',
  bg_theme: 'dark',
  cta_follow_text: '毎週AI活用術を発信中 → フォロー',
  cta_account: '@satoyama_ai_base',
};

function buildCssVars(d) {
  const accent = d.accent_color || DEFAULTS.accent_color;
  return `<style>:root { --accent: ${accent}; --accent-rgb: ${hexToRgb(accent)}; }</style>`;
}

function hexToRgb(hex) {
  const m = hex.replace('#','').match(/.{2}/g);
  if (!m) return '232,115,74';
  return m.map(h => parseInt(h, 16)).join(',');
}

const slides = {
  hook(d) {
    const brand = d.brand_name || DEFAULTS.brand_name;
    const bgClass = `bg-${d.bg_theme || DEFAULTS.bg_theme}`;
    return `<div class="slide ${bgClass} safe-zone">
      <div class="accent-bar"></div>
      <div style="text-align:center">
        <div class="hook-text">${esc(d.hook_text)}</div>
        <div class="divider" style="margin:24px auto"></div>
        <div class="sub-text">${esc(d.hook_narration||'')}</div>
      </div>
      <div class="brand">${esc(brand)}</div>
    </div>`;
  },
  problem(d) {
    const brand = d.brand_name || DEFAULTS.brand_name;
    const bgClass = `bg-${d.bg_theme || DEFAULTS.bg_theme}`;
    return `<div class="slide ${bgClass} safe-zone" style="position:relative">
      <div class="accent-bar"></div>
      <div class="ghost-text" style="top:350px;left:80px">パソコン必須</div>
      <div class="ghost-text" style="top:420px;right:100px;transform:rotate(8deg)">設定が難しい</div>
      <div class="ghost-text" style="top:500px;left:200px;transform:rotate(-5deg)">若い人向けでしょ</div>
      <div class="ghost-text" style="bottom:600px;right:150px;transform:rotate(15deg)">うちには関係ない</div>
      <div style="text-align:center;z-index:1;position:relative">
        <div class="main-text accent">${esc(d.problem_text)}</div>
        ${d.problem_number?`<div style="margin-top:40px;font-size:84px;font-weight:900;color:var(--accent);text-shadow:0 4px 12px rgba(var(--accent-rgb),0.3)">${esc(d.problem_number)}</div>`:''}
      </div>
      <div class="brand">${esc(brand)}</div>
    </div>`;
  },
  solution(d) {
    const brand = d.brand_name || DEFAULTS.brand_name;
    return `<div class="slide bg-accent safe-zone">
      <div class="accent-bar"></div>
      <div style="text-align:center">
        <div style="font-size:48px;color:rgba(255,255,255,0.6);margin-bottom:16px">✅</div>
        <div class="card" style="display:inline-block;text-align:center">
          <div class="main-text">${esc(d.solution_text)}</div>
          <div class="divider" style="margin:20px auto"></div>
          <div class="supplement-text">${esc(d.solution_narration||'')}</div>
        </div>
      </div>
      <div class="brand">${esc(brand)}</div>
    </div>`;
  },
  step(d, n) {
    const brand = d.brand_name || DEFAULTS.brand_name;
    const bgClass = `bg-${d.bg_theme || DEFAULTS.bg_theme}`;
    const imagePath = d[`step${n}_image`] || '';
    const imageTag = imagePath
      ? `<img src="${imagePath.startsWith('file://') ? imagePath : 'file://' + imagePath}"
             style="max-width:100%;max-height:480px;border-radius:12px;margin-top:32px;object-fit:contain;display:block"
             alt="step${n} screenshot">`
      : '';
    return `<div class="slide ${bgClass} safe-zone">
      <div class="accent-bar"></div>
      <div style="width:100%;max-width:920px;margin:0 auto">
        <div class="step-number">${n}</div>
        <div class="main-text" style="text-align:left">${esc(d[`step${n}_text`]||'')}</div>
        <div class="card">
          <div class="supplement-text">${esc(d[`step${n}_narration`]||'')}</div>
        </div>
        ${imageTag}
      </div>
      <div class="brand">${esc(brand)}</div>
    </div>`;
  },
  result(d) {
    const brand = d.brand_name || DEFAULTS.brand_name;
    const bgClass = `bg-${d.bg_theme || DEFAULTS.bg_theme}`;
    const c = d.comparison||'';
    const [b,a] = c.includes('→') ? c.split('→').map(s=>s.trim()) : [c,''];
    return `<div class="slide ${bgClass} safe-zone">
      <div class="accent-bar"></div>
      <div style="text-align:center">
        <div style="font-size:48px;color:rgba(255,255,255,0.6);margin-bottom:16px">📊</div>
        <div class="main-text">${esc(d.result_text)}</div>
        <div class="comparison" style="justify-content:center;margin-top:48px">
          <span class="before">${esc(b)}</span>
          <span class="arrow">→</span>
          <span class="after">${esc(a)}</span>
        </div>
      </div>
      <div class="brand">${esc(brand)}</div>
    </div>`;
  },
  summary(d) {
    const brand = d.brand_name || DEFAULTS.brand_name;
    return `<div class="slide bg-warm safe-zone">
      <div class="accent-bar"></div>
      <div style="text-align:center">
        <div class="card" style="display:inline-block;text-align:center;background:rgba(255,255,255,0.08)">
          <div style="font-size:66px;font-weight:700;line-height:1.3;text-shadow:0 3px 6px rgba(0,0,0,0.5)">${esc(d.summary_text)}</div>
          <div class="divider" style="margin:24px auto"></div>
          <div class="supplement-text">${esc(d.summary_narration||'')}</div>
        </div>
      </div>
      <div class="brand">${esc(brand)}</div>
    </div>`;
  },
  cta(d) {
    const brand = d.brand_name || DEFAULTS.brand_name;
    const bgClass = `bg-${d.bg_theme || DEFAULTS.bg_theme}`;
    const followText = d.cta_follow_text || DEFAULTS.cta_follow_text;
    const account = d.cta_account || DEFAULTS.cta_account;
    return `<div class="slide ${bgClass} safe-zone">
      <div class="accent-bar"></div>
      <div style="text-align:center">
        <div class="cta-button">${esc(d.cta_action||'保存して始めよう')}</div>
        <div style="margin-top:40px;font-size:42px;font-weight:700;color:rgba(255,255,255,0.85)">${esc(followText)}</div>
        <div style="margin-top:24px;font-size:32px;font-weight:500;color:rgba(255,255,255,0.5)">${esc(account)}</div>
      </div>
      <div class="brand">${esc(brand)}</div>
    </div>`;
  },
};

// デフォルト8カット
const DEFAULT_CUTS = [
  d => slides.hook(d),
  d => slides.problem(d),
  d => slides.solution(d),
  d => slides.step(d, 1),
  d => slides.step(d, 2),
  d => slides.result(d),
  d => slides.summary(d),
  d => slides.cta(d),
];

// JSON定義からカット関数を生成
function buildCutsFromJson(cutsJson) {
  return cutsJson.map(cut => {
    const { type } = cut;
    if (type === 'step') {
      const stepNum = cut.step_number || 1;
      return d => slides.step(d, stepNum);
    }
    if (typeof slides[type] === 'function') {
      return d => slides[type](d);
    }
    // 未知のタイプはスキップ（空スライドを返す）
    return () => `<div class="slide bg-dark safe-zone"><div class="brand">unknown type: ${esc(type)}</div></div>`;
  });
}

async function render(scriptPath, outputDir) {
  const script = JSON.parse(readFileSync(scriptPath, 'utf-8'));
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  // カット構成: JSONに cuts 配列があればそれを使う
  const cuts = Array.isArray(script.cuts) ? buildCutsFromJson(script.cuts) : DEFAULT_CUTS;

  // CSS変数注入用スタイル
  const cssVarsStyle = buildCssVars(script);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H } });

  for (let i = 0; i < cuts.length; i++) {
    const body = cuts[i](script);
    const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">${cssVarsStyle}<style>${TEMPLATE_CSS}</style></head><body>${body}</body></html>`;

    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    const out = join(outputDir, `slide_${String(i+1).padStart(2,'0')}.png`);
    await page.screenshot({ path: out, clip: { x:0, y:0, width:W, height:H } });
    console.log(`[Slide ${i+1}] → ${out}`);
  }

  await browser.close();
  console.log(`[Slides] Done: ${cuts.length} slides`);
}

const [,, sp, od] = process.argv;
if (!sp || !od) { console.error('Usage: node render-slides-pw.mjs <script.json> <output_dir>'); process.exit(1); }
render(sp, od);
