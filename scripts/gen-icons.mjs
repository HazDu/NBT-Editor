// Generates favicon + PWA icons from public/icon.png using a headless browser canvas
// (no image library needed). Uses the installed Edge by default: PW_CHANNEL=chrome to switch.
// Usage: node scripts/gen-icons.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('public/icon.png').toString('base64');
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'msedge' });
const page = await browser.newPage();
await page.setContent('<canvas></canvas>');

async function render(size, padding, bg) {
  return page.evaluate(
    async ({ src, size, padding, bg }) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      if (bg) {
        g.fillStyle = bg;
        g.fillRect(0, 0, size, size);
      }
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      const inner = size - padding * 2;
      g.drawImage(img, padding, padding, inner, inner);
      return c.toDataURL('image/png').split(',')[1];
    },
    { src, size, padding, bg },
  );
}

mkdirSync('public/icons', { recursive: true });
const out = {
  'public/favicon.png': await render(64, 0, null),
  'public/icons/icon-192.png': await render(192, 16, '#16130F'),
  'public/icons/icon-512.png': await render(512, 48, '#16130F'),
};
for (const [file, b64] of Object.entries(out)) {
  writeFileSync(file, Buffer.from(b64, 'base64'));
  console.log('wrote', file);
}
await browser.close();
