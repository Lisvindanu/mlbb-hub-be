/**
 * Scrape hero stats per rank tier dari Moonton API
 * Ranks: Epic(5), Legend(6), Mythic(7), Mythical Honor(8), Mythical Glory+(9)
 * Run: node src/scrape-meta-ranks.mjs
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

const RANKS = [
  { key: 'epic',           label: 'Epic',            bigrank: 5 },
  { key: 'legend',         label: 'Legend',          bigrank: 6 },
  { key: 'mythic',         label: 'Mythic',          bigrank: 7 },
  { key: 'mythical_honor', label: 'Mythical Honor',  bigrank: 8 },
  { key: 'mythical_glory', label: 'Mythical Glory+', bigrank: 9 },
];

function getTier(wr) {
  if (wr >= 54) return 'S+';
  if (wr >= 52) return 'S';
  if (wr >= 50) return 'A';
  if (wr >= 48) return 'B';
  return 'C';
}

async function fetchRankStats(bigrank) {
  const res = await fetch('https://api.gms.moontontech.com/api/gms/source/2669606/2756567', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      pageSize: 200,
      pageIndex: 1,
      filters: [
        { field: 'bigrank', operator: 'eq', value: bigrank },
        { field: 'match_type', operator: 'eq', value: 1 },
      ],
      sorts: [{ field: 'main_hero_win_rate', order: 'desc' }],
    }),
  });
  const json = await res.json();
  return json.data?.records || [];
}

async function main() {
  const result = { updatedAt: new Date().toISOString(), ranks: {} };

  for (const rank of RANKS) {
    process.stdout.write(`  Fetching ${rank.label} (bigrank ${rank.bigrank})... `);
    const records = await fetchRankStats(rank.bigrank);

    const heroes = records.map(r => {
      const d = r.data;
      const wr = d.main_hero_win_rate * 100;
      return {
        heroId: d.main_heroid,
        name: d.main_hero?.data?.name || '',
        icon: d.main_hero?.data?.head || '',
        winRate: wr.toFixed(2),
        pickRate: (d.main_hero_appearance_rate * 100).toFixed(2),
        banRate: (d.main_hero_ban_rate * 100).toFixed(2),
        tier: getTier(wr),
      };
    }).filter(h => h.name);

    result.ranks[rank.key] = {
      label: rank.label,
      bigrank: rank.bigrank,
      heroes,
    };

    console.log(`✅ ${heroes.length} heroes`);
  }

  const outputFile = path.join(OUTPUT_DIR, 'mlbb-meta-ranks.json');
  await fs.writeFile(outputFile, JSON.stringify(result));
  console.log(`\n🎉 Selesai! Saved to output/mlbb-meta-ranks.json`);
}

main().catch(console.error);
