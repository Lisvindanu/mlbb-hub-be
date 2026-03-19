/**
 * Scrape MLBB hero skin images from Liquipedia Gallery pages
 * Usage: node src/scrape-lp-skins.mjs [--hero Marcel] [--resume]
 *
 * For each hero: fetches HeroName/Gallery wikitext, extracts skin file names,
 * resolves each to an actual image URL via Liquipedia imageinfo API,
 * then saves to merged-mlbb.json under hero.skins[].
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const DATA_FILE = path.join(OUTPUT_DIR, 'merged-mlbb.json');
const PROGRESS_FILE = path.join(OUTPUT_DIR, 'lp-skins-progress.json');

const LP_API = 'https://liquipedia.net/mobilelegends/api.php';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 mlbb-hub/1.0 (educational project)',
  'Accept-Encoding': 'gzip',
};
const DELAY_MS = 5000;

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    args[key] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchJson(params, retries = 5) {
  const url = LP_API + '?' + new URLSearchParams({ ...params, format: 'json' });
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      const text = await res.text();
      if (text.startsWith('{')) return JSON.parse(text);
      const wait = (i + 1) * 30000;
      process.stdout.write(` [rate-limited, wait ${wait / 1000}s] `);
      await sleep(wait);
    } catch (e) {
      const wait = (i + 1) * 10000;
      process.stdout.write(` [error: ${e.message}, wait ${wait / 1000}s] `);
      await sleep(wait);
    }
  }
  throw new Error('fetch failed after retries');
}

/**
 * Fetch gallery wikitext and parse {{Skin}} templates
 * Returns [{name, type, fileName}]
 */
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
      skins.push({
        name: nameM[1].trim(),
        type: typeM?.[1]?.trim() || '',
        fileName: imageM[1].trim(),
      });
    }
  }
  return skins;
}

/**
 * Resolve a file name to its actual image URL via imageinfo API
 */
async function resolveFileUrl(fileName) {
  const data = await fetchJson({
    action: 'query',
    titles: 'File:' + fileName,
    prop: 'imageinfo',
    iiprop: 'url',
  });
  const pages = data.query?.pages || {};
  for (const page of Object.values(pages)) {
    const url = page.imageinfo?.[0]?.url;
    if (url) return url;
  }
  return null;
}

/**
 * Map Liquipedia hero names to our hero data names (handle mismatches)
 */
function toWikiName(heroName) {
  const map = {
    'Chang\'e': 'Chang\'e',
    'X.Borg': 'X.Borg',
    'Yi Sun-shin': 'Yi Sun-shin',
    'Popol and Kupa': 'Popol and Kupa',
    'Fanny': 'Fanny',
  };
  return map[heroName] || heroName;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

const rawData = JSON.parse(await fs.readFile(DATA_FILE, 'utf-8'));
const heroes = rawData.main;
const heroNames = Object.keys(heroes);

// Load progress
let progress = {};
try {
  progress = JSON.parse(await fs.readFile(PROGRESS_FILE, 'utf-8'));
} catch {}

// Filter to single hero if --hero flag
const targets = args.hero
  ? heroNames.filter(n => n.toLowerCase() === args.hero.toLowerCase())
  : heroNames;

console.log(`\n🎨 Scraping skins for ${targets.length} heroes from Liquipedia\n`);

let updated = 0;
let skipped = 0;
let failed = 0;

for (const heroName of targets) {
  const hero = heroes[heroName];
  const wikiName = toWikiName(heroName);

  // Skip if already done (unless forced)
  if (!args.force && progress[heroName]?.done) {
    process.stdout.write(`  ⏩ ${heroName} (${hero.skins?.length || 0} skins cached)\n`);
    skipped++;
    continue;
  }

  process.stdout.write(`  🔍 ${heroName}... `);
  await sleep(DELAY_MS);

  try {
    const galleryItems = await getGallerySkins(wikiName);

    if (galleryItems.length === 0) {
      console.log(`⚠️  No {{Skin}} templates found`);
      progress[heroName] = { done: true, skins: 0, error: 'no skins' };
      await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
      failed++;
      continue;
    }

    console.log(`found ${galleryItems.length} skins, resolving URLs...`);

    const skins = [];
    for (const item of galleryItems) {
      await sleep(DELAY_MS);
      process.stdout.write(`    📷 ${item.name}... `);
      const imageUrl = await resolveFileUrl(item.fileName);
      if (imageUrl) {
        skins.push({
          skinName: item.name,
          skinType: item.type,
          skinImage: imageUrl,
          source: 'liquipedia',
        });
        console.log(`✅`);
      } else {
        console.log(`❌ no URL`);
      }
    }

    hero.skins = skins;
    rawData.meta.updatedAt = new Date().toISOString();
    progress[heroName] = { done: true, skins: skins.length };

    // Save after each hero
    await fs.writeFile(DATA_FILE, JSON.stringify(rawData, null, 2));
    await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    console.log(`  ✅ ${heroName}: ${skins.length} skins saved\n`);
    updated++;

  } catch (e) {
    console.log(`❌ ${e.message}`);
    progress[heroName] = { done: false, error: e.message };
    await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    failed++;
  }
}

console.log(`\n🎉 Done! Updated: ${updated}, Skipped: ${skipped}, Failed: ${failed}`);
