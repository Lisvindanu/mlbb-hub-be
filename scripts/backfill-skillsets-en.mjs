/**
 * backfill-skillsets-en.mjs
 * Backfill skillDescEn for multi-mode heroes (skillSets[].skills[])
 * Usage: node scripts/backfill-skillsets-en.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '../output/merged-mlbb.json');

function toSlug(name) {
  return name.toLowerCase()
    .replace(/'/g, '').replace(/\./g, '-').replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function stripHtml(str) {
  return (str || '').replace(/<[^>]+>/g, '');
}

async function fetchSkillSets(heroName) {
  const slug = toSlug(heroName);
  const res = await fetch(`https://mlbb-stats.rone.dev/api/hero-detail/${slug}/`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const sets = json?.data?.records?.[0]?.data?.hero?.data?.heroskilllist;
  if (!sets?.length) throw new Error('No skill sets');
  return sets.map(ss => ({
    id: ss.skilllistid,
    skills: (ss.skilllist || []).map(s => ({
      skillName: s.skillname,
      skillDescEn: stripHtml(s.skilldesc || ''),
    })),
  }));
}

async function main() {
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  const data = JSON.parse(raw);

  const multiMode = Object.keys(data.main).filter(n =>
    data.main[n].skillSets?.length > 1
  );
  console.log(`Multi-mode heroes: ${multiMode.length} — ${multiMode.join(', ')}\n`);

  let done = 0, errors = 0;

  for (const heroName of multiMode) {
    try {
      const apiSets = await fetchSkillSets(heroName);
      const localSets = data.main[heroName].skillSets;

      // Match by index (same order from API)
      localSets.forEach((localSet, setIdx) => {
        const apiSet = apiSets[setIdx];
        if (!apiSet) return;
        localSet.skills.forEach((skill, skillIdx) => {
          // Try name match first, fallback to index
          const match = apiSet.skills.find(s =>
            s.skillName.toLowerCase() === skill.skillName?.toLowerCase()
          ) || apiSet.skills[skillIdx];
          if (match?.skillDescEn) skill.skillDescEn = match.skillDescEn;
        });
      });

      done++;
      console.log(`✓ ${heroName} (${localSets.length} sets)`);
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      errors++;
      console.error(`[ERROR] ${heroName}: ${e.message}`);
    }
  }

  await fs.writeFile(DATA_FILE, JSON.stringify(data));
  console.log(`\n✅ Done! Filled: ${done}, Errors: ${errors}`);
}

main().catch(console.error);
