/**
 * Scrape best partners, strong against, weak against dari Moonton API
 * Run: node src/scrape-relations.mjs
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

const HEADERS = { 'Content-Type': 'application/json', 'Origin': 'https://www.mobilelegends.com', 'Referer': 'https://www.mobilelegends.com/' };
const DELAY_MS = 600;
const delay = ms => new Promise(r => setTimeout(r, ms));

async function fetchRelation(heroId) {
  const res = await fetch('https://api.gms.moontontech.com/api/gms/source/2669606/2756564', {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({ pageSize: 1, pageIndex: 1, filters: [{ field: 'hero_id', operator: 'eq', value: heroId }], sorts: [], object: [] }),
  });
  const json = await res.json();
  return json.data?.records?.[0]?.data?.relation || null;
}

const data = JSON.parse(await fs.readFile(path.join(OUTPUT_DIR, 'merged-mlbb.json'), 'utf-8'));

// Build id→name map
const idToName = {};
for (const [name, hero] of Object.entries(data.main)) {
  if (hero.heroId) idToName[hero.heroId] = name;
}

const mapHeroes = (ids) =>
  (ids || []).filter(id => id && idToName[id]).map(id => ({ name: idToName[id] }));

let done = 0, failed = 0;
for (const [name, hero] of Object.entries(data.main)) {
  if (!hero.heroId) continue;
  process.stdout.write(`  ${name}... `);
  await delay(DELAY_MS);
  try {
    const rel = await fetchRelation(hero.heroId);
    if (rel) {
      hero.bestPartners    = mapHeroes(rel.assist?.target_hero_id);
      hero.suppressingHeroes = mapHeroes(rel.strong?.target_hero_id);
      hero.suppressedHeroes  = mapHeroes(rel.weak?.target_hero_id);
      hero.relationDesc = {
        assist: rel.assist?.desc || '',
        strong: rel.strong?.desc || '',
        weak:   rel.weak?.desc   || '',
      };
      console.log(`✅ partners:${hero.bestPartners.length} strong:${hero.suppressingHeroes.length} weak:${hero.suppressedHeroes.length}`);
      done++;
    } else {
      console.log('⚠️  no relation data');
    }
  } catch(e) {
    console.log(`❌ ${e.message}`);
    failed++;
  }
}

await fs.writeFile(path.join(OUTPUT_DIR, 'merged-mlbb.json'), JSON.stringify(data, null, 2));
console.log(`\n✅ Done! ${done} heroes updated, ${failed} failed. Saved.`);
