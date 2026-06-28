import puppeteer from './node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';
import { launch } from './node_modules/puppeteer/lib/esm/puppeteer/node/index.js';

const browser = await launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.goto('http://localhost:3002', { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForSelector('#main-app:not(.hidden)', { timeout: 25000 }).catch(() => {});
await new Promise(r => setTimeout(r, 3000));
await page.screenshot({ path: 'C:/Users/jsinghal/canopy/screenshot-main.png', fullPage: false });

// click first zone
const firstZone = await page.$('.zone-item');
if (firstZone) {
  await firstZone.click();
  await new Promise(r => setTimeout(r, 800));
  await page.screenshot({ path: 'C:/Users/jsinghal/canopy/screenshot-selected.png' });
  // click dispatch
  const btn = await page.$('.dispatch-btn');
  if (btn) {
    await btn.click();
    await new Promise(r => setTimeout(r, 4000));
    await page.screenshot({ path: 'C:/Users/jsinghal/canopy/screenshot-modal.png' });
  }
}

// also screenshot loading state
await browser.close();
console.log('done');
