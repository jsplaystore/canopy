const puppeteer = require('./node_modules/puppeteer');
(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu','--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto('http://localhost:3002', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // wait for data to load
  await new Promise(r => setTimeout(r, 9000));
  await page.screenshot({ path: 'C:/Users/jsinghal/canopy/ss-main.png' });
  console.log('main screenshot done');

  const zone = await page.$('.zone-item');
  if (zone) {
    await zone.click();
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: 'C:/Users/jsinghal/canopy/ss-selected.png' });
    console.log('selected screenshot done');
  }

  const btn = await page.$('.dispatch-btn');
  if (btn) {
    await btn.click();
    await new Promise(r => setTimeout(r, 6000));
    await page.screenshot({ path: 'C:/Users/jsinghal/canopy/ss-modal.png' });
    console.log('modal screenshot done');
  }

  await browser.close();
  console.log('all done');
})().catch(e => { console.error(e.message); process.exit(1); });
