const puppeteer = require('./node_modules/puppeteer');
(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu','--disable-dev-shm-usage'],
    timeout: 60000,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  // Capture console errors
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGE ERROR: ' + e.message));

  await page.goto('http://localhost:3002', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 12000));

  if (errors.length) {
    console.log('ERRORS:\n' + errors.join('\n'));
  }

  const mainHidden = await page.$eval('#main-app', el => el.classList.contains('hidden')).catch(() => true);
  console.log('main-app hidden:', mainHidden);

  await page.screenshot({ path: 'C:/Users/jsinghal/canopy/ss2-main.png' });
  console.log('main done');

  if (!mainHidden) {
    const zone = await page.$('.zi');
    if (zone) {
      await zone.click();
      await new Promise(r => setTimeout(r, 1200));
      await page.screenshot({ path: 'C:/Users/jsinghal/canopy/ss2-sel.png' });
      console.log('selected done');
    }
    const btn = await page.$('.zi-btn');
    if (btn) {
      await btn.click();
      await new Promise(r => setTimeout(r, 7000));
      await page.screenshot({ path: 'C:/Users/jsinghal/canopy/ss2-modal.png' });
      console.log('modal done');
    }
  }

  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
