/**
 * translate-skills.mjs
 * Translate MLBB hero skill descriptions to Indonesian using Gemini via Vertex AI Express.
 * - Saves original English to skillDescEn
 * - Translated Indonesian goes to skillDesc (default display)
 * - Supports resume (skips already-done heroes)
 * Usage: node scripts/translate-skills.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE     = path.join(__dirname, '../output/merged-mlbb.json');
const PROGRESS_FILE = path.join(__dirname, '../output/translate-progress.json');

const API_KEY = 'AQ.Ab8RN6K0xzcntUX5gzgF1HWRhUbOOrWs0TSHeoxHEJirSYPYVQ';
const ENDPOINT = `https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash-lite:generateContent?key=${API_KEY}`;

// Game terms to keep in English
const GAME_TERMS = [
  'Total Physical Attack','Total Magic Power','Extra Physical Attack','Extra Magic Power',
  'Physical Damage','Magic Damage','True Damage','Physical Defense','Magic Defense',
  'Physical Attack','Magic Power','Basic Attack','Attack Speed','Movement Speed',
  'Critical Chance','Critical Damage','Crowd Control','Spell Vamp',
  'HP','Mana','Shield','Heal','Regeneration','Lifesteal',
  'Stun','Slow','Knock Back','Knock Up','Suppress','Silence',
  'Immobilize','Airborne','Fear','Taunt','Root','Critical',
  'Blink','Dash','Teleport','Charge','Flicker',
  'Buff','Debuff','Stack','Passive','Active','Toggle','AOE','Burst',
  'Cooldown','Gold','EXP','Kill','Assist',
  'Jungle','Lane','Turret','Base','Lord','Turtle','Minion',
  'Marksman','Mage','Fighter','Tank','Support','Assassin',
  'Respawn','Recall',
];

function protect(text) {
  const map = {};
  let idx = 0;
  let result = text;
  for (const term of GAME_TERMS) {
    const re = new RegExp(`\\b${term}\\b`, 'g');
    if (re.test(result)) {
      const ph = `__T${idx}__`;
      map[ph] = term;
      result = result.replace(new RegExp(`\\b${term}\\b`, 'g'), ph);
      idx++;
    }
  }
  return { text: result, map };
}

function restore(text, map) {
  let result = text;
  for (const [ph, term] of Object.entries(map)) {
    result = result.split(ph).join(term);
  }
  return result;
}

async function gemini(prompt, retries = 6) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
      }),
    });
    if (res.status === 429) {
      const wait = 6000 * (attempt + 1);
      console.log(`  Rate limit, tunggu ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API error ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }
  throw new Error('Max retries exceeded (rate limit)');
}

async function translateBatch(heroName, skills) {
  const protected_ = skills.map(s => protect(s.skillDescEn || s.skillDesc || ''));
  const input = protected_.map((p, i) => ({ i, desc: p.text }));

  const prompt = `Terjemahkan deskripsi skill hero "${heroName}" dari Mobile Legends ke Bahasa Indonesia yang natural.

Aturan WAJIB:
- Placeholder __T0__, __T1__, dst adalah istilah game — salin PERSIS, jangan ubah
- Angka, %, dan formula seperti (30 (+25% __T0__)) harus PERSIS sama
- Pertahankan \\n\\n di posisi yang sama
- Output HANYA JSON array, tidak ada teks lain sebelum atau sesudah

Output format: [{"i":0,"desc":"terjemahan"},{"i":1,"desc":"..."}]

Input:
${JSON.stringify(input)}`;

  const text = (await gemini(prompt)).trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`No JSON for ${heroName}: ${text.slice(0, 200)}`);

  const translated = JSON.parse(jsonMatch[0]);
  return translated.map(({ i, desc }) => ({
    i,
    desc: restore(desc, protected_[i].map),
  }));
}

async function main() {
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  const data = JSON.parse(raw);
  const heroes = data.main;

  let progress = {};
  try {
    progress = JSON.parse(await fs.readFile(PROGRESS_FILE, 'utf8'));
    console.log(`Resume — ${Object.keys(progress).length} hero sudah selesai`);
  } catch { /* fresh start */ }

  const heroNames = Object.keys(heroes);
  const total = heroNames.length;
  let done = 0, skipped = 0, errors = 0;

  console.log(`Total hero: ${total}\n`);

  for (const heroName of heroNames) {
    if (progress[heroName]) { skipped++; continue; }

    const hero = heroes[heroName];
    const skills = hero.skill || [];
    if (skills.length === 0) {
      progress[heroName] = true;
      skipped++;
      continue;
    }

    try {
      const translated = await translateBatch(heroName, skills);
      translated.forEach(({ i, desc }) => {
        if (!skills[i]) return;
        // Backup English jika belum ada
        if (!skills[i].skillDescEn) {
          skills[i].skillDescEn = skills[i].skillDesc;
        }
        // Set Indonesian as default
        skills[i].skillDesc = desc;
      });

      progress[heroName] = true;
      done++;
      const pct = Math.round(((done + skipped) / total) * 100);
      console.log(`[${pct}%] ✓ ${heroName} (${skills.length} skills)`);

      // Save setiap 5 hero
      if (done % 5 === 0) {
        await fs.writeFile(DATA_FILE, JSON.stringify(data));
        await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress));
        console.log('  → Checkpoint saved\n');
      }

      // 15 RPM = ~4s per request minimum
      await new Promise(r => setTimeout(r, 4500));

    } catch (e) {
      errors++;
      console.error(`[ERROR] ${heroName}: ${e.message}`);
      await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress));
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // Final save
  await fs.writeFile(DATA_FILE, JSON.stringify(data));
  await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress));

  console.log(`\n✅ Selesai!`);
  console.log(`   Diterjemah : ${done} hero`);
  console.log(`   Di-skip    : ${skipped} hero`);
  console.log(`   Error      : ${errors} hero`);
}

main().catch(console.error);
