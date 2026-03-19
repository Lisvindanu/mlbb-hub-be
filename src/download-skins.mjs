/**
 * Download MLBB skin images from Liquipedia + continue scraping remaining heroes
 * 1. Fix old format (name/image → skinName/skinImage)
 * 2. Scrape remaining 67 heroes from Liquipedia
 * 3. Download all images to public/images/skins/{HeroName}/
 * 4. Update merged-mlbb.json with local paths
 *
 * Usage: node src/download-skins.mjs
 *        node src/download-skins.mjs --skip-scrape   (download only, no new scraping)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const SKINS_DIR = path.join(__dirname, '..', 'public', 'images', 'skins');
const DATA_FILE = path.join(OUTPUT_DIR, 'merged-mlbb.json');
const PROGRESS_FILE = path.join(OUTPUT_DIR, 'lp-skins-progress.json');

const LP_API = 'https://liquipedia.net/mobilelegends/api.php';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 mlbb-hub/1.0 (educational project)', 'Accept-Encoding': 'gzip' };
const DELAY_MS = 5000;

const args = process.argv.slice(2).reduce((a, v) => { a[v.replace('--', '')] = true; return a; }, {});

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(params, retries = 5) {
  const url = LP_API + '?' + new URLSearchParams({ ...params, format: 'json' });
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      const text = await res.text();
      if (text.startsWith('{')) return JSON.parse(text);
      const wait = (i + 1) * 30000;
      process.stdout.write(` [rate-limited ${wait / 1000}s] `);
      await sleep(wait);
    } catch (e) {
      const wait = (i + 1) * 10000;
      process.stdout.write(` [err: ${e.message}, wait ${wait / 1000}s] `);
      await sleep(wait);
    }
  }
  throw new Error('fetch failed');
}

async function getGallerySkins(heroName) {
  const pageName = heroName.replace(/\s+/g, '_') + '/Gallery';
  const data = await fetchJson({ action: 'parse', page: pageName, prop: 'wikitext' });
  const wikitext = data.parse?.wikitext?.['*'] || '';
  if (!wikitext) return [];
  const skins = [];
  const skinRe = /\{\{Skin\s*\n([\s\S]*?)\}\}/gi;
  let m;
  while ((m = skinRe.exec(wikitext)) !== null) {
    const block = m[1];
    const nameM = block.match(/\|name\s*=\s*(.+)/);
    const imageM = block.match(/\|image\s*=\s*(.+)/);
    const typeM = block.match(/\|type\s*=\s*(.+)/);
    if (nameM && imageM) {
      // Strip wiki external link syntax: [https://... Skin Name] → Skin Name
      let name = nameM[1].trim().replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1').trim();
      skins.push({ name, type: typeM?.[1]?.trim() || '', fileName: imageM[1].trim() });
    }
  }
  return skins;
}

async function resolveFileUrl(fileName) {
  const data = await fetchJson({ action: 'query', titles: 'File:' + fileName, prop: 'imageinfo', iiprop: 'url' });
  const pages = data.query?.pages || {};
  for (const page of Object.values(pages)) {
    const url = page.imageinfo?.[0]?.url;
    if (url) return url;
  }
  return null;
}

function safeName(str) {
  return str.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_');
}

async function downloadImage(url, destPath) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 mlbb-hub/1.0 (educational project)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  await fs.writeFile(destPath, Buffer.from(buf));
}

// ── STEP 1: Load data + fix old format ────────────────────────────────────────
console.log('\n📂 Loading data...');
const rawData = JSON.parse(await fs.readFile(DATA_FILE, 'utf-8'));
const heroes = rawData.main;

// Fix old format (name/image → skinName/skinImage)
let formatFixed = 0;
for (const hero of Object.values(heroes)) {
  if (hero.skins?.length > 0 && hero.skins[0].name !== undefined) {
    hero.skins = hero.skins.map(s => ({
      skinName: s.name,
      skinType: s.type || '',
      skinImage: s.image,
      source: 'liquipedia',
    }));
    formatFixed++;
  }
}
if (formatFixed > 0) {
  console.log(`✅ Fixed format for ${formatFixed} heroes`);
  await fs.writeFile(DATA_FILE, JSON.stringify(rawData, null, 2));
}

// ── STEP 2: Scrape remaining heroes ───────────────────────────────────────────
let progress = {};
try { progress = JSON.parse(await fs.readFile(PROGRESS_FILE, 'utf-8')); } catch {}

if (!args['skip-scrape']) {
  const remaining = Object.keys(heroes).filter(name => !progress[name]?.done);
  console.log(`\n🔍 Scraping ${remaining.length} remaining heroes from Liquipedia...\n`);

  for (const heroName of remaining) {
    process.stdout.write(`  ${heroName}... `);
    await sleep(DELAY_MS);
    try {
      const galleryItems = await getGallerySkins(heroName);
      if (galleryItems.length === 0) {
        console.log(`⚠️  no skins`);
        progress[heroName] = { done: true, skins: 0, error: 'no skins' };
        await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
        continue;
      }
      console.log(`${galleryItems.length} skins found, resolving...`);
      const skins = [];
      for (const item of galleryItems) {
        await sleep(DELAY_MS);
        process.stdout.write(`    ${item.name}... `);
        const imageUrl = await resolveFileUrl(item.fileName);
        if (imageUrl) {
          skins.push({ skinName: item.name, skinType: item.type, skinImage: imageUrl, source: 'liquipedia' });
          console.log('✅');
        } else {
          console.log('❌');
        }
      }
      heroes[heroName].skins = skins;
      progress[heroName] = { done: true, skins: skins.length };
      await fs.writeFile(DATA_FILE, JSON.stringify(rawData, null, 2));
      await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
      console.log(`  ✅ ${heroName}: ${skins.length} skins\n`);
    } catch (e) {
      console.log(`❌ ${e.message}`);
      progress[heroName] = { done: false, error: e.message };
      await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    }
  }
}

// ── STEP 3: Download all images ────────────────────────────────────────────────
console.log('\n⬇️  Downloading skin images...\n');
await fs.mkdir(SKINS_DIR, { recursive: true });

let dlOk = 0, dlSkip = 0, dlFail = 0;

for (const [heroName, hero] of Object.entries(heroes)) {
  if (!hero.skins || hero.skins.length === 0) continue;

  const heroDir = path.join(SKINS_DIR, safeName(heroName));
  await fs.mkdir(heroDir, { recursive: true });

  for (const skin of hero.skins) {
    const imgUrl = skin.skinImage;
    if (!imgUrl || !imgUrl.startsWith('https://liquipedia.net/')) continue;

    const ext = path.extname(imgUrl).split('?')[0] || '.jpg';
    const fileName = safeName(skin.skinName) + ext;
    const localPath = path.join(heroDir, fileName);
    const localUrl = `/images/skins/${safeName(heroName)}/${fileName}`;

    // Skip if already downloaded
    try {
      await fs.access(localPath);
      skin.skinImage = localUrl;
      dlSkip++;
      continue;
    } catch {}

    process.stdout.write(`  ⬇️  ${heroName}/${skin.skinName}... `);
    try {
      await downloadImage(imgUrl, localPath);
      skin.skinImage = localUrl;
      console.log('✅');
      dlOk++;
      await sleep(500); // lighter delay for downloads (no API rate limit)
    } catch (e) {
      console.log(`❌ ${e.message}`);
      dlFail++;
    }
  }
}

await fs.writeFile(DATA_FILE, JSON.stringify(rawData, null, 2));

const totalSkins = Object.values(heroes).reduce((s, h) => s + (h.skins?.length || 0), 0);
console.log(`\n🎉 Done!`);
console.log(`   Downloaded: ${dlOk} | Skipped (cached): ${dlSkip} | Failed: ${dlFail}`);
console.log(`   Total skins in data: ${totalSkins}`);
console.log(`   All images saved to public/images/skins/`);
