/**
 * translate-items-emblems.mjs
 * Translate item and emblem descriptions to Indonesian.
 * Saves original English to descriptionEn / passiveSkills[].descriptionEn
 * Usage: node scripts/translate-items-emblems.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ITEMS_FILE   = path.join(__dirname, '../output/mlbb-items.json');
const EMBLEMS_FILE = path.join(__dirname, '../output/mlbb-emblems.json');

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
  'Cooldown','Gold','EXP','Kill','Assist','Jungle','Lane',
  'Unique Passive','Unique Active','Marksman','Mage','Fighter','Tank','Support','Assassin',
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
  throw new Error('Max retries exceeded');
}

async function translateTexts(label, texts) {
  const protected_ = texts.map(t => protect(t));
  const input = protected_.map((p, i) => ({ i, desc: p.text }));

  const prompt = `Terjemahkan deskripsi berikut dari game Mobile Legends ke Bahasa Indonesia yang natural.

Aturan WAJIB:
- Placeholder __T0__, __T1__, dst adalah istilah game — salin PERSIS
- Angka, %, formula harus PERSIS sama
- Output HANYA JSON array

Output format: [{"i":0,"desc":"terjemahan"},...]

Context: ${label}
Input:
${JSON.stringify(input)}`;

  const text = (await gemini(prompt)).trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`No JSON: ${text.slice(0, 200)}`);

  const translated = JSON.parse(jsonMatch[0]);
  return translated.map(({ i, desc }) => ({
    i,
    desc: restore(desc, protected_[i].map),
  }));
}

async function translateItems() {
  const raw = await fs.readFile(ITEMS_FILE, 'utf8');
  const items = JSON.parse(raw);
  const vals = Array.isArray(items) ? items : Object.values(items);

  console.log(`\n=== ITEMS (${vals.length}) ===`);
  let done = 0;

  // Batch 10 items at a time
  for (let i = 0; i < vals.length; i += 10) {
    const batch = vals.slice(i, i + 10);

    // Translate main descriptions
    const mainDescs = batch.map(item => item.descriptionEn || item.description || '');
    const mainTranslated = await translateTexts('item descriptions', mainDescs);
    mainTranslated.forEach(({ i: idx, desc }) => {
      const item = batch[idx];
      if (!item.descriptionEn) item.descriptionEn = item.description;
      item.description = desc;
    });

    // Translate passive skill descriptions
    for (const item of batch) {
      if (!item.passiveSkills?.length) continue;
      const passiveDescs = item.passiveSkills.map(p => p.descriptionEn || p.description || '');
      if (passiveDescs.every(d => !d)) continue;

      const passiveTranslated = await translateTexts(`passive skills of ${item.name}`, passiveDescs);
      passiveTranslated.forEach(({ i: idx, desc }) => {
        const ps = item.passiveSkills[idx];
        if (!ps.descriptionEn) ps.descriptionEn = ps.description;
        ps.description = desc;
      });
      await new Promise(r => setTimeout(r, 4500));
    }

    done += batch.length;
    console.log(`  [${done}/${vals.length}] ✓ batch ${Math.ceil(i/10)+1}`);
    await new Promise(r => setTimeout(r, 4500));
  }

  await fs.writeFile(ITEMS_FILE, JSON.stringify(items));
  console.log('Items saved.');
}

async function translateEmblems() {
  const raw = await fs.readFile(EMBLEMS_FILE, 'utf8');
  const emblems = JSON.parse(raw);
  const vals = Array.isArray(emblems) ? emblems : Object.values(emblems);

  // Filter emblems with meaningful descriptions
  const withDesc = vals.filter(e => e.description && e.description.length > 5);
  console.log(`\n=== EMBLEMS (${withDesc.length} with desc) ===`);

  const descs = withDesc.map(e => e.descriptionEn || e.description);
  const translated = await translateTexts('emblem descriptions', descs);
  translated.forEach(({ i, desc }) => {
    const emb = withDesc[i];
    if (!emb.descriptionEn) emb.descriptionEn = emb.description;
    emb.description = desc;
  });

  await fs.writeFile(EMBLEMS_FILE, JSON.stringify(emblems));
  console.log('Emblems saved.');
}

async function main() {
  await translateItems();
  await translateEmblems();
  console.log('\n✅ Semua selesai!');
}

main().catch(console.error);
