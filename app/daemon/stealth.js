'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const randomInt = (min, max) => crypto.randomInt(min, max + 1);
const randomFloat = (min, max) => min + crypto.randomInt(0, 10000) / 10000 * (max - min);

const DIR = __dirname;
const DELAY_LOG = path.join(DIR, '.apply-runs', 'stealth-log.json');

function humanDelay(minMs, maxMs) {
  const delay = randomInt(minMs || 180000, maxMs || 300000);
  return new Promise((r) => setTimeout(r, delay));
}

function randomTypingDelay(wordCount) {
  const wpm = randomInt(40, 80);
  const msPerWord = 60000 / wpm;
  return Math.round((wordCount || 5) * msPerWord * randomFloat(0.7, 1.3));
}

function mouseJitter(x, y) {
  const jx = randomInt(-15, 15);
  const jy = randomInt(-15, 15);
  return { x: x + jx, y: y + jy };
}

function randomPath(origin, target) {
  const steps = randomInt(2, 5);
  const path = [{ x: origin.x, y: origin.y }];
  for (let i = 0; i < steps; i++) {
    path.push({
      x: origin.x + (target.x - origin.x) * (i + 1) / steps + randomInt(-30, 30),
      y: origin.y + (target.y - origin.y) * (i + 1) / steps + randomInt(-30, 30),
    });
  }
  path.push({ x: target.x, y: target.y });
  return path;
}

async function humanClick(page, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return locator.click().catch(() => {});
  const j = mouseJitter(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(j.x, j.y, { steps: randomInt(5, 15) }).catch(() => {});
  await humanDelay(50, 200).catch(() => {});
  await page.mouse.click(j.x, j.y).catch(() => {});
  await humanDelay(100, 300).catch(() => {});
}

async function humanType(page, locator, text) {
  const chars = String(text || '').split('');
  for (const ch of chars) {
    await locator.press(ch).catch(() => {});
    const delay = randomInt(30, 120);
    await new Promise((r) => setTimeout(r, delay)).catch(() => {});
  }
}

async function stealthDelay(context) {
  const base = context === 'between_apps' ? 180000 : 30000;
  const max = context === 'between_apps' ? 300000 : 60000;
  await humanDelay(base, max).catch(() => {});
}

function logStealth(action, detail) {
  try {
    const entry = { ts: new Date().toISOString(), action, detail };
    const logs = fs.existsSync(DELAY_LOG) ? JSON.parse(fs.readFileSync(DELAY_LOG, 'utf8')) : [];
    logs.push(entry);
    if (logs.length > 1000) logs.splice(0, logs.length - 1000);
    fs.writeFileSync(DELAY_LOG, JSON.stringify(logs, null, 2));
  } catch (_) {}
}

module.exports = {
  humanDelay,
  randomTypingDelay,
  mouseJitter,
  randomPath,
  humanClick,
  humanType,
  stealthDelay,
  logStealth,
};
