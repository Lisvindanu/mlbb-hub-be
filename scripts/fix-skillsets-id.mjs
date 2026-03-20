/**
 * fix-skillsets-id.mjs
 * Fix skillDesc (Indonesian) in hero.skillSets[].skills[] for multi-mode heroes.
 *
 * Strategy:
 *   1. For each skill in a skillSet — if name matches something in hero.skill[],
 *      copy the Indonesian skillDesc from there.
 *   2. For skills NOT found in hero.skill[] (weapon-unique skills) — translate
 *      skillDescEn to Indonesian via Gemini.
 *
 * Usage: node scripts/fix-skillsets-id.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '../output/merged-mlbb.json');

const GEMINI_KEY = 'AQ.Ab8RN6K0xzcntUX5gzgF1HWRhUbOOrWs0TSHeoxHEJirSYPYVQ';
const GEMINI_URL = `https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`;
const DELAY_MS = 4500; // 15 RPM limit

async function translateToId(text) {
  if (!text?.trim()) return '';
  const body = {
    contents: [{
      parts: [{
        text: `Terjemahkan teks deskripsi skill game Mobile Legends berikut ke Bahasa Indonesia yang natural dan mudah dipahami. Pertahankan istilah teknis game (nama skill, damage, cooldown, dll). Hanya balas dengan terjemahan, tanpa penjelasan tambahan.\n\nTeks: ${text}`
      }]
    }]
  };
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 429) throw new Error('RATE_LIMIT');
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const json = await res.json();
  return json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  const data = JSON.parse(raw);
  const heroes = data.main;

  // Find multi-mode heroes
  const multiMode = Object.keys(heroes).filter(n => heroes[n].skillSets?.length > 1);
  console.log(`Multi-mode heroes: ${multiMode.length} — ${multiMode.join(', ')}\n`);

  let translated = 0, copied = 0, errors = 0;

  for (const heroName of multiMode) {
    const hero = heroes[heroName];
    const flatSkills = hero.skill || [];

    // Build lookup map: lowercased skillName → Indonesian skillDesc
    const idMap = new Map();
    for (const s of flatSkills) {
      if (s.skillName && s.skillDesc) {
        idMap.set(s.skillName.toLowerCase().trim(), s.skillDesc);
      }
    }

    let heroNeedsTranslation = false;

    for (const set of hero.skillSets) {
      for (const skill of set.skills) {
        // Skip if already has proper Indonesian (not same as English)
        if (skill.skillDesc && skill.skillDesc !== skill.skillDescEn) continue;

        const key = skill.skillName?.toLowerCase().trim();
        if (idMap.has(key)) {
          // Copy from flat skill list
          skill.skillDesc = idMap.get(key);
          copied++;
        } else if (skill.skillDescEn) {
          // Needs Gemini translation
          heroNeedsTranslation = true;
        }
      }
    }

    if (heroNeedsTranslation) {
      console.log(`  Translating unique skills for ${heroName}...`);
      for (const set of hero.skillSets) {
        for (const skill of set.skills) {
          if (skill.skillDesc && skill.skillDesc !== skill.skillDescEn) continue;
          const key = skill.skillName?.toLowerCase().trim();
          if (idMap.has(key)) continue; // already handled
          if (!skill.skillDescEn) continue;

          let retries = 0;
          while (retries < 3) {
            try {
              skill.skillDesc = await translateToId(skill.skillDescEn);
              translated++;
              console.log(`    ✓ ${skill.skillName}`);
              await sleep(DELAY_MS);
              break;
            } catch (e) {
              if (e.message === 'RATE_LIMIT') {
                console.log(`    ⏳ Rate limit, waiting 30s...`);
                await sleep(30000);
                retries++;
              } else {
                console.error(`    [ERROR] ${skill.skillName}: ${e.message}`);
                errors++;
                break;
              }
            }
          }
        }
      }
    }

    console.log(`✓ ${heroName}`);
  }

  await fs.writeFile(DATA_FILE, JSON.stringify(data));
  console.log(`\n✅ Done! Copied: ${copied}, Translated: ${translated}, Errors: ${errors}`);
}

main().catch(console.error);
