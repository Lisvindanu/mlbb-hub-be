/**
 * Scrape top community builds per hero dari api.mlbb.io
 * Run: node src/scrape-mlbb-builds.mjs
 * Output: output/mlbb-builds.json
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const ROOT = path.join(__dirname, '..', '..');

const HEADERS = { 'x-client-secret': '259009191be734535393edc59e865dce' };
const TOP_N = 5; // ambil top 5 builds per hero berdasarkan likes
const DELAY_MS = 300; // jeda antar request agar tidak di-rate-limit

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchBuilds(heroName) {
  try {
    const res = await fetch(`https://api.mlbb.io/api/item/item-build/hero/${encodeURIComponent(heroName)}`, {
      headers: HEADERS,
    });
    if (!res.ok) return [];
    const json = await res.json();
    return json.data || [];
  } catch {
    return [];
  }
}

async function main() {
  // Load reference data
  const heroesRaw = await fs.readFile(path.join(OUTPUT_DIR, 'merged-mlbb.json'), 'utf-8');
  const heroesData = JSON.parse(heroesRaw);
  const heroes = Object.values(heroesData.main);

  const itemsRaw = await fs.readFile(path.join(OUTPUT_DIR, 'mlbb-items.json'), 'utf-8');
  const itemsList = JSON.parse(itemsRaw);
  const itemsMap = Object.fromEntries(itemsList.map(i => [i.id, i]));

  const emblemsRaw = await fs.readFile(path.join(OUTPUT_DIR, 'mlbb-emblems.json'), 'utf-8');
  const emblemsList = JSON.parse(emblemsRaw);
  const emblemsMap = Object.fromEntries(emblemsList.map(e => [e.id, e]));

  const talentsRaw = await fs.readFile(path.join(ROOT, 'ability-emblems.json'), 'utf-8');
  const talentsData = JSON.parse(talentsRaw);
  const talentsList = talentsData.data || [];
  const talentsMap = Object.fromEntries(talentsList.map(t => [t.id, t]));

  const result = {};
  let total = 0;

  for (const hero of heroes) {
    process.stdout.write(`  Fetching ${hero.name}... `);
    const builds = await fetchBuilds(hero.name);

    // Sort by likes descending, take top N
    const topBuilds = builds
      .sort((a, b) => (b.likes_count - a.likes_count))
      .slice(0, TOP_N)
      .map(b => {
        // Resolve item IDs → item objects
        const items = (b.items || []).map(id => {
          const item = itemsMap[id];
          return item ? { id: item.id, name: item.name, icon: item.icon } : { id, name: `Item #${id}`, icon: '' };
        });

        // Resolve emblem
        const mainEmblem = emblemsMap[b.emblems?.main_id];
        const talents = (b.emblems?.ability_ids || []).map(id => {
          const t = talentsMap[id];
          return t ? {
            id: t.id,
            name: t.name,
            benefits: t.benefits,
            icon: `https://mlbb.io/_next/image?url=${encodeURIComponent('/images/emblem/ability/' + t.img_src)}&w=64&q=75`,
          } : { id, name: `Talent #${id}`, benefits: '', icon: '' };
        });

        return {
          buildId: b.build_id,
          username: b.username,
          description: b.description || '',
          battleSpell: b.battle_spell || null,
          emblem: mainEmblem ? {
            id: mainEmblem.id,
            name: mainEmblem.name,
            icon: mainEmblem.icon,
          } : null,
          talents,
          items,
          likes: b.likes_count,
          dislikes: b.dislikes_count,
          createdAt: b.created_at,
        };
      });

    result[hero.name] = topBuilds;
    total += topBuilds.length;
    console.log(`✅ ${topBuilds.length} builds`);

    await sleep(DELAY_MS);
  }

  await fs.writeFile(path.join(OUTPUT_DIR, 'mlbb-builds.json'), JSON.stringify(result));
  console.log(`\n🎉 Done! ${Object.keys(result).length} heroes, ${total} total builds → output/mlbb-builds.json`);
}

main().catch(console.error);
