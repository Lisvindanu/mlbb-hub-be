/**
 * Enrich existing merged-mlbb.json dengan smallmap + squarehead images
 * Run: node src/enrich-hero-images.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

const HEADERS = {
  'Content-Type': 'application/json',
  'Origin': 'https://www.mobilelegends.com',
  'Referer': 'https://www.mobilelegends.com/',
};

const delay = ms => new Promise(r => setTimeout(r, ms));

async function fetchImages(heroId) {
  const res = await fetch('https://api.gms.moontontech.com/api/gms/source/2669606/2756564', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      pageSize: 20, pageIndex: 1,
      filters: [{ field: 'hero_id', operator: 'eq', value: heroId }],
      sorts: [], object: [],
    }),
  });
  const json = await res.json();
  const hero = json.data?.records?.[0]?.data?.hero?.data;
  if (!hero) return null;
  return {
    cardImage: hero.smallmap || '',      // full body art for cards
    squarehead: hero.squarehead || '',   // square portrait
    painting: hero.painting || '',       // large artwork
  };
}

async function main() {
  const outputFile = path.join(OUTPUT_DIR, 'merged-mlbb.json');
  const data = JSON.parse(await fs.readFile(outputFile, 'utf-8'));
  const heroes = Object.values(data.main);

  console.log(`🖼️  Enriching ${heroes.length} heroes with card images...\n`);

  let count = 0;
  for (const hero of heroes) {
    process.stdout.write(`  ${hero.heroId}. ${hero.name}... `);
    try {
      const imgs = await fetchImages(hero.heroId);
      if (imgs) {
        data.main[hero.name].cardImage = imgs.cardImage;
        data.main[hero.name].squarehead = imgs.squarehead;
        data.main[hero.name].painting = imgs.painting;
        console.log(`✅ ${imgs.cardImage.substring(imgs.cardImage.lastIndexOf('/')+1, imgs.cardImage.lastIndexOf('/')+20)}`);
      } else {
        console.log('⚠️  no data');
      }
    } catch (err) {
      console.log(`❌ ${err.message}`);
    }

    count++;
    if (count % 10 === 0) {
      await fs.writeFile(outputFile, JSON.stringify(data));
      console.log(`  💾 Saved ${count} heroes`);
    }

    await delay(500);
  }

  data.meta.updatedAt = new Date().toISOString();
  await fs.writeFile(outputFile, JSON.stringify(data));
  console.log(`\n🎉 Selesai! cardImage + squarehead + painting ditambahkan.`);
}

main().catch(console.error);
