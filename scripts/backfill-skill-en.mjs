/**
 * backfill-skill-en.mjs
 * Fetch English skill descriptions from mlbb-stats.rone.dev for heroes missing skillDescEn
 * Usage: node scripts/backfill-skill-en.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '../output/merged-mlbb.json');

function toSlug(name) {
  return name.toLowerCase()
    .replace(/'/g, '')
    .replace(/\./g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Strip HTML tags from skill descriptions
function stripHtml(str) {
  return (str || '').replace(/<[^>]+>/g, '');
}

async function fetchSkills(heroName) {
  const slug = toSlug(heroName);
  const url = `https://mlbb-stats.rone.dev/api/hero-detail/${slug}/`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${slug}`);
  const json = await res.json();

  // Navigate to skill list
  const record = json?.data?.records?.[0];
  const heroData = record?.data?.hero?.data;
  const skillSet = heroData?.heroskilllist?.[0]?.skilllist;
  if (!skillSet || skillSet.length === 0) throw new Error(`No skills for ${slug}`);

  return skillSet.map(s => ({
    skillName: s.skillname,
    skillDesc: stripHtml(s.skilldesc || ''),
    skillIcon: s.skillicon || '',
  }));
}

async function main() {
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  const data = JSON.parse(raw);
  const heroes = data.main;

  // Find heroes missing skillDescEn
  const missing = Object.keys(heroes).filter(name =>
    heroes[name].skill?.length > 0 &&
    !heroes[name].skill.some(s => s.skillDescEn)
  );

  console.log(`Heroes missing skillDescEn: ${missing.length}`);
  let done = 0, errors = 0;

  for (const heroName of missing) {
    try {
      const apiSkills = await fetchSkills(heroName);
      const localSkills = heroes[heroName].skill;

      // Match by skillName first, fallback by index
      localSkills.forEach((localSkill, i) => {
        // Try exact name match
        let match = apiSkills.find(s =>
          s.skillName.toLowerCase() === localSkill.skillName?.toLowerCase()
        );
        // Fallback to index
        if (!match) match = apiSkills[i];

        if (match?.skillDesc) {
          localSkill.skillDescEn = match.skillDesc;
        }
      });

      done++;
      const pct = Math.round((done / missing.length) * 100);
      console.log(`[${pct}%] ✓ ${heroName} (${localSkills.length} skills)`);

      // Save every 10 heroes
      if (done % 10 === 0) {
        await fs.writeFile(DATA_FILE, JSON.stringify(data));
        console.log('  → Checkpoint saved');
      }

      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      errors++;
      console.error(`[ERROR] ${heroName}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  await fs.writeFile(DATA_FILE, JSON.stringify(data));
  console.log(`\n✅ Done! Filled: ${done}, Errors: ${errors}`);
}

main().catch(console.error);
