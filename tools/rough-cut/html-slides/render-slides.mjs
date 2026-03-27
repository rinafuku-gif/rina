/**
 * render-slides.mjs — HTMLスライドをPuppeteerでPNGにレンダリング
 * Usage: node render-slides.mjs <script.json> <output_dir>
 */

import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = readFileSync(join(__dirname, 'template.html'), 'utf-8');

const W = 1080;
const H = 1920;

// カットタイプごとのHTML生成
const slideGenerators = {
  hook(data) {
    return `
    <div class="slide bg-dark safe-zone">
      <div class="accent-bar"></div>
      <div style="text-align:center">
        <div class="hook-text">${esc(data.hook_text)}</div>
        <div class="divider" style="margin:24px auto"></div>
        <div class="sub-text">${esc(data.hook_narration || '')}</div>
      </div>
      <div class="brand">SATOYAMA AI BASE</div>
    </div>`;
  },

  problem(data) {
    return `
    <div class="slide bg-dark safe-zone" style="position:relative">
      <div class="accent-bar"></div>
      <!-- Ghost texts -->
      <div class="ghost-text" style="top:350px;left:80px">パソコン必須</div>
      <div class="ghost-text" style="top:420px;right:100px;transform:rotate(8deg)">設定が難しい</div>
      <div class="ghost-text" style="top:500px;left:200px;transform:rotate(-5deg)">若い人向けでしょ</div>
      <div class="ghost-text" style="bottom:600px;right:150px;transform:rotate(15deg)">うちには関係ない</div>
      <div style="text-align:center;z-index:1;position:relative">
        <div class="main-text accent">${esc(data.problem_text)}</div>
        ${data.problem_number ? `
        <div style="margin-top:40px;font-size:84px;font-weight:900;color:#E8734A;text-shadow:0 4px 12px rgba(232,115,74,0.3)">
          ${esc(data.problem_number)}
        </div>` : ''}
      </div>
      <div class="brand">SATOYAMA AI BASE</div>
    </div>`;
  },

  solution(data) {
    return `
    <div class="slide bg-accent safe-zone">
      <div class="accent-bar"></div>
      <div style="text-align:center">
        <div style="font-size:48px;font-weight:500;color:rgba(255,255,255,0.6);margin-bottom:16px">✅</div>
        <div class="card" style="display:inline-block;text-align:center">
          <div class="main-text">${esc(data.solution_text)}</div>
          <div class="divider" style="margin:20px auto"></div>
          <div class="supplement-text">${esc(data.solution_narration || '')}</div>
        </div>
      </div>
      <div class="brand">SATOYAMA AI BASE</div>
    </div>`;
  },

  step(data, stepNum) {
    const textKey = `step${stepNum}_text`;
    const narrKey = `step${stepNum}_narration`;
    return `
    <div class="slide bg-dark safe-zone">
      <div class="accent-bar"></div>
      <div style="width:100%;max-width:960px">
        <div class="step-number">${stepNum}</div>
        <div style="margin-top:16px">
          <div class="main-text" style="text-align:left;font-size:54px">${esc(data[textKey] || '')}</div>
        </div>
        <div class="card" style="margin-top:32px">
          <div class="supplement-text">${esc(data[narrKey] || '')}</div>
        </div>
      </div>
      <div class="brand">SATOYAMA AI BASE</div>
    </div>`;
  },

  result(data) {
    const comp = data.comparison || '';
    const parts = comp.includes('→') ? comp.split('→').map(s => s.trim()) : [comp, ''];
    return `
    <div class="slide bg-dark safe-zone">
      <div class="accent-bar"></div>
      <div style="text-align:center">
        <div style="font-size:48px;font-weight:500;color:rgba(255,255,255,0.6);margin-bottom:16px">📊</div>
        <div class="main-text">${esc(data.result_text)}</div>
        <div class="comparison" style="justify-content:center;margin-top:48px">
          <span class="before">${esc(parts[0])}</span>
          <span class="arrow">→</span>
          <span class="after">${esc(parts[1])}</span>
        </div>
      </div>
      <div class="brand">SATOYAMA AI BASE</div>
    </div>`;
  },

  summary(data) {
    return `
    <div class="slide bg-warm safe-zone">
      <div class="accent-bar"></div>
      <div style="text-align:center">
        <div class="card" style="display:inline-block;text-align:center;background:rgba(255,255,255,0.08)">
          <div style="font-size:66px;font-weight:700;line-height:1.3;text-shadow:0 3px 6px rgba(0,0,0,0.5)">
            ${esc(data.summary_text)}
          </div>
          <div class="divider" style="margin:24px auto"></div>
          <div class="supplement-text">${esc(data.summary_narration || '')}</div>
        </div>
      </div>
      <div class="brand">SATOYAMA AI BASE</div>
    </div>`;
  },

  cta(data) {
    return `
    <div class="slide bg-dark safe-zone">
      <div class="accent-bar"></div>
      <div style="text-align:center">
        <div class="cta-button">${esc(data.cta_action || '保存して始めよう')}</div>
        <div style="margin-top:40px;font-size:42px;font-weight:700;color:rgba(255,255,255,0.85)">
          毎週AI活用術を発信中 → フォロー
        </div>
        <div style="margin-top:24px;font-size:32px;font-weight:500;color:rgba(255,255,255,0.5)">
          @satoyama_ai_base
        </div>
      </div>
      <div class="brand">SATOYAMA AI BASE</div>
    </div>`;
  },

  // 3項目リスト（転換カット用）
  list(data) {
    const items = [
      data.step1_text || '①',
      data.step2_text || '②',
      data.result_text || '③',
    ];
    return `
    <div class="slide bg-accent safe-zone">
      <div class="accent-bar"></div>
      <div style="width:100%;max-width:960px">
        <div class="main-text" style="text-align:left;margin-bottom:40px">${esc(data.solution_text || '今週のAI進化')}</div>
        <div class="card">
          ${items.map((item, i) => `
          <div class="list-item">
            <div class="list-number">${i + 1}</div>
            <div class="list-text">${esc(item)}</div>
          </div>`).join('')}
        </div>
      </div>
      <div class="brand">SATOYAMA AI BASE</div>
    </div>`;
  },
};

function esc(text) {
  return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// カット→スライドタイプのマッピング
const CUT_MAP = [
  { type: 'hook' },
  { type: 'problem' },
  { type: 'solution' },
  { type: 'step', stepNum: 1 },
  { type: 'step', stepNum: 2 },
  { type: 'result' },
  { type: 'summary' },
  { type: 'cta' },
];

async function renderSlides(scriptPath, outputDir) {
  const script = JSON.parse(readFileSync(scriptPath, 'utf-8'));

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    protocolTimeout: 120000,
  });

  const page = await browser.newPage();
  // Render at CSS 1080x1920 with deviceScaleFactor=1
  // Use clip to avoid full-page issues
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

  for (let i = 0; i < CUT_MAP.length; i++) {
    const cutDef = CUT_MAP[i];
    const gen = slideGenerators[cutDef.type];
    if (!gen) continue;

    const bodyHTML = cutDef.stepNum !== undefined
      ? gen(script, cutDef.stepNum)
      : gen(script);

    const fullHTML = TEMPLATE.replace('<!-- Content injected by render script -->', bodyHTML);

    // HTMLをdata URIで読み込み（file://だとCORS問題回避）
    const tmpFile = join(outputDir, `_tmp_${i}.html`);
    writeFileSync(tmpFile, fullHTML);
    await page.goto(`file://${tmpFile}`, { waitUntil: 'networkidle0', timeout: 15000 });

    // Google Fontsの読み込み待ち
    await page.waitForFunction(() => document.fonts.ready, { timeout: 10000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 500)); // extra settle time

    const outPath = join(outputDir, `slide_${String(i + 1).padStart(2, '0')}.png`);
    await page.screenshot({
      path: outPath,
      type: 'png',
      clip: { x: 0, y: 0, width: W, height: H },
    });
    console.log(`[Slide ${i + 1}] ${cutDef.type} → ${outPath}`);
  }

  await browser.close();

  // cleanup tmp html files
  for (let i = 0; i < CUT_MAP.length; i++) {
    try { require('fs').unlinkSync(join(outputDir, `_tmp_${i}.html`)); } catch {}
  }

  console.log(`[Slides] Done: ${CUT_MAP.length} slides in ${outputDir}`);
}

// CLI
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node render-slides.mjs <script.json> <output_dir>');
  process.exit(1);
}
renderSlides(args[0], args[1]);
