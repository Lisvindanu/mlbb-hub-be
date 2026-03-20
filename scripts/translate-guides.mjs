/**
 * translate-guides.mjs
 * Translate scraped hero guide content to Indonesian using Gemini via Vertex AI Express.
 * - Saves original English to *En fields
 * - Translated Indonesian is the default
 * - Resume-able via output/guides-translate-progress.json
 * Usage: node scripts/translate-guides.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUIDES_FILE    = path.join(__dirname, '../output/mlbb-hero-guides.json');
const PROGRESS_FILE  = path.join(__dirname, '../output/guides-translate-progress.json');

const API_KEY  = 'AQ.Ab8RN6K0xzcntUX5gzgF1HWRhUbOOrWs0TSHeoxHEJirSYPYVQ';
const ENDPOINT = `https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash-lite:generateContent?key=${API_KEY}`;

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
  'Respawn','Recall','Roam','Rotate','Gank','Poke','Engage','Disengage',
  'Late Game','Mid Game','Early Game','Teamfight','Team Fight','Split Push',
  'Exp Lane','Gold Lane','Mid Lane','Roam','Jungler',
];

function protect(text) {
  const map = {};
  let idx = 0;
  let result = text;
  for (const term of GAME_TERMS) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`, 'g');
    if (re.test(result)) {
      const ph = `__T${idx}__`;
      map[ph] = term;
      result = result.replace(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`, 'g'), ph);
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
    try {
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
        console.warn(`  429 rate limit — waiting ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const json = await res.json();
      return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error('Max retries exceeded');
}

async function translateGuide(heroName, guide) {
  // Build a single prompt with all fields at once
  const sections = [];

  if (guide.description) {
    const { text, map } = protect(guide.description);
    sections.push({ field: 'description', text, map });
  }
  if (guide.howToPlay) {
    const { text, map } = protect(guide.howToPlay);
    sections.push({ field: 'howToPlay', text, map });
  }
  if (guide.gamePhase) {
    for (const phase of ['early', 'mid', 'late']) {
      if (guide.gamePhase[phase]) {
        const { text, map } = protect(guide.gamePhase[phase]);
        sections.push({ field: `gamePhase.${phase}`, text, map });
      }
    }
  }
  if (guide.laneAssignment?.desc) {
    const { text, map } = protect(guide.laneAssignment.desc);
    sections.push({ field: 'laneAssignment.desc', text, map });
  }
  if (guide.proTips?.length) {
    guide.proTips.forEach((tip, i) => {
      const { text, map } = protect(tip);
      sections.push({ field: `proTip.${i}`, text, map });
    });
  }
  if (guide.summary) {
    const { text, map } = protect(guide.summary);
    sections.push({ field: 'summary', text, map });
  }

  // Build prompt
  const input = sections.map((s, i) => `[${i}] ${s.text}`).join('\n\n');
  const prompt = `Terjemahkan teks panduan hero Mobile Legends berikut ke Bahasa Indonesia yang natural dan mudah dipahami.
- Pertahankan placeholder seperti __T0__, __T1__, dst PERSIS seperti aslinya (jangan ubah, jangan hapus)
- Nama hero, istilah game (placeholder), dan angka tetap sama
- Terjemahan harus natural dalam Bahasa Indonesia
- Format output: hanya teks terjemahan per nomor, pisahkan dengan baris kosong, format: [0] terjemahan\\n\\n[1] terjemahan\\n\\ndst

${input}`;

  const raw = await gemini(prompt);

  // Parse output
  const translated = {};
  const matches = [...raw.matchAll(/\[(\d+)\]\s*([\s\S]*?)(?=\n\n\[|\n\[\d+\]|$)/g)];
  for (const m of matches) {
    translated[parseInt(m[1])] = m[2].trim();
  }

  // Apply translations back
  const result = { ...guide };

  sections.forEach((s, i) => {
    const t = translated[i];
    if (!t) return;
    const restored = restore(t, s.map);

    if (s.field === 'description') {
      result.descriptionEn = guide.description;
      result.description = restored;
    } else if (s.field === 'howToPlay') {
      result.howToPlayEn = guide.howToPlay;
      result.howToPlay = restored;
    } else if (s.field.startsWith('gamePhase.')) {
      const phase = s.field.split('.')[1];
      if (!result.gamePhaseEn) result.gamePhaseEn = { ...guide.gamePhase };
      result.gamePhase[phase] = restored;
    } else if (s.field === 'laneAssignment.desc') {
      if (!result.laneAssignmentEn) result.laneAssignmentEn = { ...guide.laneAssignment };
      result.laneAssignment = { ...guide.laneAssignment, desc: restored };
    } else if (s.field.startsWith('proTip.')) {
      const idx = parseInt(s.field.split('.')[1]);
      if (!result.proTipsEn) result.proTipsEn = [...guide.proTips];
      result.proTips[idx] = restored;
    } else if (s.field === 'summary') {
      result.summaryEn = guide.summary;
      result.summary = restored;
    }
  });

  return result;
}

async function main() {
  const guidesRaw = await fs.readFile(GUIDES_FILE, 'utf8');
  const guides = JSON.parse(guidesRaw);
  const heroNames = Object.keys(guides);

  let progress = {};
  try { progress = JSON.parse(await fs.readFile(PROGRESS_FILE, 'utf8')); } catch {}

  const total = heroNames.length;
  let done = 0, skipped = 0, errors = 0;

  console.log(`Total heroes: ${total}`);
  const alreadyDone = Object.keys(progress).filter(k => progress[k]).length;
  if (alreadyDone > 0) console.log(`Resume — ${alreadyDone} already done\n`);

  for (const heroName of heroNames) {
    if (progress[heroName]) { skipped++; continue; }

    try {
      const translated = await translateGuide(heroName, guides[heroName]);
      guides[heroName] = translated;
      progress[heroName] = true;
      done++;

      const pct = Math.round(((done + skipped) / total) * 100);
      console.log(`[${pct}%] ✓ ${heroName}`);

      if (done % 10 === 0) {
        await fs.writeFile(GUIDES_FILE, JSON.stringify(guides));
        await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress));
        console.log('  → Checkpoint saved\n');
      }

      await new Promise(r => setTimeout(r, 4500));
    } catch (e) {
      errors++;
      progress[heroName] = false;
      console.error(`[ERROR] ${heroName}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  await fs.writeFile(GUIDES_FILE, JSON.stringify(guides));
  await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress));

  console.log(`\n✅ Selesai!`);
  console.log(`   Translated: ${done}`);
  console.log(`   Skipped   : ${skipped}`);
  console.log(`   Errors    : ${errors}`);
}

main().catch(console.error);
