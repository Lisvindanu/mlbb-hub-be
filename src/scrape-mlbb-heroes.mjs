/**
 * Scrape hero data from Moonton API (no Puppeteer needed)
 * Sources:
 *   - Hero detail + skills: api.gms.moontontech.com/api/gms/source/2669606/2756564
 *   - Skill icons:          api.gms.moontontech.com/api/gms/source/2669606/2674711
 *   - Win/ban/pick rates:   api.gms.moontontech.com/api/gms/source/2669606/2756567
 * Run: node src/scrape-mlbb-heroes.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

const API_BASE = 'https://api.gms.moontontech.com/api/gms/source/2669606';
const HEADERS = {
  'Content-Type': 'application/json',
  'Origin': 'https://www.mobilelegends.com',
  'Referer': 'https://www.mobilelegends.com/',
};

const TOTAL_HEROES = 132;
const DELAY_MS = 800;
const delay = ms => new Promise(r => setTimeout(r, ms));

async function postApi(sourceId, filters, extra = {}) {
  const body = JSON.stringify({
    pageSize: 20,
    pageIndex: 1,
    filters,
    sorts: [],
    ...extra,
  });

  const res = await fetch(`${API_BASE}/${sourceId}`, {
    method: 'POST',
    headers: HEADERS,
    body,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.data?.records || [];
}

async function fetchHeroDetail(heroId) {
  const records = await postApi('2756564',
    [{ field: 'hero_id', operator: 'eq', value: heroId }],
    { object: [] }
  );
  return records[0]?.data || null;
}

async function fetchSkillIcons(heroId) {
  const records = await postApi('2674711',
    [{ field: 'hero_id', operator: 'eq', value: heroId }],
    { object: [2684183] }
  );
  const skillIds = records[0]?.data?.skill_id || [];
  // Returns map: skillid -> icon url
  const iconMap = {};
  skillIds.forEach(s => {
    if (s.data?.skillid && s.data?.skillicon) {
      iconMap[s.data.skillid] = s.data.skillicon;
    }
  });
  return iconMap;
}

async function fetchStats(heroId) {
  const records = await postApi('2756567', [
    { field: 'main_heroid', operator: 'eq', value: heroId },
    { field: 'bigrank', operator: 'eq', value: 101 },
    { field: 'match_type', operator: 'eq', value: 1 },
  ]);
  const r = records[0]?.data;
  if (!r) return null;
  return {
    winRate: r.main_hero_win_rate || 0,
    banRate: r.main_hero_ban_rate || 0,
    pickRate: r.main_hero_appearance_rate || 0,
    bigrank: r.bigrank || 0,
  };
}

function parseSkillCost(cdCost = '') {
  // Format: "CD: 11.0s  Cost: 50/55/60/65/70/75"
  const cdMatch = cdCost.match(/CD[:\s]+([0-9.\/\s]+)/i);
  const costMatch = cdCost.match(/Cost[:\s]+([0-9.\/\s]+)/i);
  const parseVals = str => str ? str.split('/').map(v => parseFloat(v.trim())).filter(Boolean) : [];
  return {
    cooldown: parseVals(cdMatch?.[1]),
    cost: parseVals(costMatch?.[1]),
  };
}

function stripHtml(str = '') {
  return str.replace(/<[^>]+>/g, '').trim();
}

async function scrapeHero(heroId) {
  try {
    const [detail, stats] = await Promise.all([
      fetchHeroDetail(heroId),
      fetchStats(heroId),
    ]);

    if (!detail) return null;

    const hero = detail.hero?.data;
    if (!hero || !hero.name) return null;

    // Skill icons from 2nd endpoint
    const iconMap = await fetchSkillIcons(heroId);

    // Skills
    const rawSkills = hero.heroskilllist?.[0]?.skilllist || [];
    const skills = rawSkills.map(s => {
      const { cooldown, cost } = parseSkillCost(s['skillcd&cost']);
      // Use skill icon from iconMap if available, else use skillicon from skill obj
      const skillImg = iconMap[s.skillid] || s.skillicon || '';
      return {
        skillName: s.skillname || '',
        skillImg,
        skillDesc: stripHtml(s.skilldesc || ''),
        skillTag: s.skilltag || '',
        cooldown,
        cost,
      };
    });

    // Tier dari win rate
    const wr = stats ? stats.winRate * 100 : 0;
    let tier = 'C';
    if (wr >= 54) tier = 'S+';
    else if (wr >= 52) tier = 'S';
    else if (wr >= 50) tier = 'A';
    else if (wr >= 48) tier = 'B';

    return {
      heroId,
      name: hero.name,
      title: hero.speciality?.[0] || '',
      role: hero.sortlabel?.[0] || '',
      lane: hero.roadsortlabel?.[0] || '',
      lanes: (hero.roadsortlabel || []).filter(Boolean),
      icon: hero.head || '',
      iconBig: hero.squarehead || hero.head_big || '',
      speciality: hero.speciality || [],
      skill: skills,
      skins: [],
      arcana: [],
      recommendedEquipment: [],
      buildTitle: '',
      bestPartners: {},
      suppressingHeroes: {},
      suppressedHeroes: {},
      stats: {
        winRate: stats ? String((stats.winRate * 100).toFixed(2)) : '0',
        pickRate: stats ? String((stats.pickRate * 100).toFixed(2)) : '0',
        banRate: stats ? String((stats.banRate * 100).toFixed(2)) : '0',
        tier,
      },
      survivalPercentage: hero.abilityshow?.[0] || '0',
      attackPercentage: hero.abilityshow?.[1] || '0',
      abilityPercentage: hero.abilityshow?.[2] || '0',
      difficultyPercentage: hero.difficulty || '0',
      world: { region: '', identity: '', energy: '' },
    };
  } catch (err) {
    console.error(`  ❌ Hero ${heroId}: ${err.message}`);
    return null;
  }
}

async function main() {
  const outputFile = path.join(OUTPUT_DIR, 'merged-mlbb.json');

  // Load existing untuk resume
  let heroMap = {};
  let doneIds = new Set();
  try {
    const existing = JSON.parse(await fs.readFile(outputFile, 'utf-8'));
    heroMap = existing.main || {};
    doneIds = new Set(Object.values(heroMap).map(h => h.heroId));
    console.log(`📂 Resume: ${doneIds.size} hero sudah ada`);
  } catch {
    console.log('📂 Mulai dari awal');
  }

  console.log(`🚀 Scraping ${TOTAL_HEROES} hero dari Moonton API...\n`);

  for (let id = 1; id <= TOTAL_HEROES; id++) {
    if (doneIds.has(id)) {
      process.stdout.write(`  ⏭️  ${id} skip\n`);
      continue;
    }

    process.stdout.write(`  🔍 Hero ${id}/${TOTAL_HEROES}... `);

    const hero = await scrapeHero(id);

    if (hero) {
      heroMap[hero.name] = hero;
      console.log(`✅ ${hero.name} | ${hero.role} | tier: ${hero.stats.tier} | WR: ${hero.stats.winRate}%`);
    } else {
      console.log(`⚠️  no data`);
    }

    // Save setiap 10 hero
    if (id % 10 === 0) {
      const out = { main: heroMap, meta: { total: Object.keys(heroMap).length, updatedAt: new Date().toISOString() } };
      await fs.writeFile(outputFile, JSON.stringify(out));
      console.log(`  💾 Saved ${Object.keys(heroMap).length} heroes`);
    }

    await delay(DELAY_MS);
  }

  const out = { main: heroMap, meta: { total: Object.keys(heroMap).length, updatedAt: new Date().toISOString() } };
  await fs.writeFile(outputFile, JSON.stringify(out));

  console.log(`\n🎉 Selesai! ${Object.keys(heroMap).length} hero berhasil di-scrape`);
  console.log(`📄 Output: output/merged-mlbb.json`);
}

main().catch(console.error);
