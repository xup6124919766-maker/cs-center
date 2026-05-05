#!/usr/bin/env node
/**
 * gen-pwa-icons.js
 * 產生 PWA 用 PNG icons（192x192, 512x512, maskable 512x512）
 * 使用方式：node scripts/gen-pwa-icons.js
 *
 * 依賴：sharp（需要先 npm install sharp --save-dev）
 * 若沒裝 sharp，會 fallback 直接複製 SVG（瀏覽器多數支援 SVG icon）
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '../public/icons');

// ─── SVG 範本（梵森 LINE 綠 + 客服對話圖示）───
const makeSvg = (size, maskable = false) => {
  // maskable 需要 safe area padding（約 10%）
  const pad = maskable ? Math.round(size * 0.1) : 0;
  const inner = size - pad * 2;
  const cx = size / 2;
  const cy = size / 2;
  const r = inner / 2;

  // 氣泡主體路徑（相對 cx, cy）
  const bubbleR = r * 0.62;
  const tailX = cx - r * 0.08;
  const tailY = cy + r * 0.55;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <!-- 背景圓 -->
  <circle cx="${cx}" cy="${cy}" r="${cx}" fill="#06C755"/>
  <!-- 對話氣泡 -->
  <ellipse cx="${cx}" cy="${cy - r * 0.05}" rx="${bubbleR}" ry="${bubbleR * 0.82}" fill="white" opacity="0.97"/>
  <!-- 尾巴 -->
  <path d="M ${tailX - r * 0.12} ${cy + bubbleR * 0.72}
           Q ${tailX - r * 0.32} ${tailY + r * 0.18}
             ${tailX - r * 0.4} ${tailY + r * 0.38}
           Q ${tailX + r * 0.04} ${tailY + r * 0.1}
             ${tailX + r * 0.18} ${cy + bubbleR * 0.75} Z"
        fill="white" opacity="0.97"/>
  <!-- 三個點（正在輸入圖示）-->
  <circle cx="${cx - bubbleR * 0.35}" cy="${cy - r * 0.04}" r="${bubbleR * 0.1}" fill="#06C755"/>
  <circle cx="${cx}"                   cy="${cy - r * 0.04}" r="${bubbleR * 0.1}" fill="#06C755"/>
  <circle cx="${cx + bubbleR * 0.35}" cy="${cy - r * 0.04}" r="${bubbleR * 0.1}" fill="#06C755"/>
</svg>`;
};

// ─── 確保輸出目錄存在 ───
fs.mkdirSync(outDir, { recursive: true });

// ─── 嘗試用 sharp 產 PNG，否則存 SVG（.png 副檔名但內容是 SVG）───
let sharp;
try {
  const req = createRequire(import.meta.url);
  sharp = req('sharp');
} catch {
  sharp = null;
}

const tasks = [
  { filename: 'icon-192.png',    size: 192, maskable: false },
  { filename: 'icon-512.png',    size: 512, maskable: false },
  { filename: 'icon-maskable.png', size: 512, maskable: true  },
];

for (const { filename, size, maskable } of tasks) {
  const svg = makeSvg(size, maskable);
  const outPath = path.join(outDir, filename);

  if (sharp) {
    await sharp(Buffer.from(svg)).png().toFile(outPath);
    console.log(`[icon] 產出 PNG: ${filename} (${size}x${size})`);
  } else {
    // Fallback：把 SVG bytes 存成 .png（大多數 PWA 工具能接受 SVG，Chrome 也支援）
    fs.writeFileSync(outPath, svg, 'utf8');
    console.log(`[icon] 無 sharp，存 SVG（偽 PNG）: ${filename} (${size}x${size})`);
  }
}

console.log('[icon] 完成，輸出至 public/icons/');
