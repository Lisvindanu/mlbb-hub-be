/**
 * Download missing skin images from Fandom wiki using Hero{id}-portrait.png pattern
 * Usage: node src/download-fandom-skins.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '..', 'output', 'merged-mlbb.json');
const SKINS_DIR = path.join(__dirname, '..', 'public', 'images', 'skins');

const FANDOM_API = 'https://mobile-legends.fandom.com/api.php';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 mlbb-hub/1.0 (educational project)' };
const DELAY_MS = 1000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function safeName(str) {
  return str.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_');
}

async function resolveImageUrl(fandomId) {
  const fileName = `Hero${fandomId}-portrait.png`;
  const url = FANDOM_API + '?' + new URLSearchParams({
    action: 'query', titles: `File:${fileName}`,
    prop: 'imageinfo', iiprop: 'url', format: 'json'
  });
  const res = await fetch(url, { headers: HEADERS });
  const data = await res.json();
  const pages = data.query?.pages || {};
  for (const page of Object.values(pages)) {
    const imgUrl = page.imageinfo?.[0]?.url;
    if (imgUrl) return imgUrl;
  }
  return null;
}

async function downloadImage(url, destPath) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  await fs.writeFile(destPath, Buffer.from(buf));
}

// Collect all missing skins
const rawData = JSON.parse(await fs.readFile(DATA_FILE, 'utf-8'));
const heroes = rawData.main;

const missing = [];
for (const [heroName, hero] of Object.entries(heroes)) {
  for (const skin of (hero.skins || [])) {
    if (!skin.skinImage && skin.fandomId) {
      missing.push({ heroName, skin });
    }
  }
}

console.log(`\n⬇️  Downloading ${missing.length} missing skin images from Fandom\n`);

let ok = 0, fail = 0;

for (const { heroName, skin } of missing) {
  process.stdout.write(`  ${heroName} - ${skin.skinName} (id:${skin.fandomId})... `);
  await sleep(DELAY_MS);

  try {
    const imgUrl = await resolveImageUrl(skin.fandomId);
    if (!imgUrl) { console.log('❌ no URL'); fail++; continue; }

    const heroDir = path.join(SKINS_DIR, safeName(heroName));
    await fs.mkdir(heroDir, { recursive: true });

    const ext = '.png';
    // Use fandomId in filename to avoid collisions between skins with same name
    const fileName = safeName(skin.skinName) + '_' + skin.fandomId + ext;
    const localPath = path.join(heroDir, fileName);
    const localUrl = `/images/skins/${safeName(heroName)}/${fileName}`;

    await sleep(DELAY_MS);
    await downloadImage(imgUrl, localPath);
    skin.skinImage = localUrl;
    console.log('✅');
    ok++;

    // Save periodically
    if (ok % 20 === 0) {
      await fs.writeFile(DATA_FILE, JSON.stringify(rawData, null, 2));
    }
  } catch (e) {
    console.log(`❌ ${e.message}`);
    fail++;
  }
}

await fs.writeFile(DATA_FILE, JSON.stringify(rawData, null, 2));
console.log(`\n🎉 Done! Downloaded: ${ok} | Failed: ${fail}`);
