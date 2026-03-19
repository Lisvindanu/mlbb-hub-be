/**
 * Transform MLBB-API data into format expected by MLBB Hub frontend
 * Run: node src/transform-mlbb.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const MLBB_API_BASE = 'https://raw.githubusercontent.com/p3hndrx/MLBB-API/main/';

// ── Hero Transformer ──────────────────────────────────────────────────────────

function transformSkill(skill) {
  return {
    skillName: skill.skill_name || '',
    skillImg: skill.skill_icon ? MLBB_API_BASE + skill.skill_icon : '',
    skillDesc: skill.description || '',
    cooldown: skill.cooldown && skill.cooldown !== 'null'
      ? String(skill.cooldown).split('/').map(v => parseFloat(v.trim()) || 0)
      : [],
    cost: skill.manacost && skill.manacost !== 'null'
      ? String(skill.manacost).split('/').map(v => parseFloat(v.trim()) || 0)
      : [],
    type: skill.type || 'active',
  };
}

function transformRelations(list = []) {
  const result = {};
  for (const item of list) {
    if (!item.heroname) continue;
    result[item.heroname] = {
      name: item.heroname,
      thumbnail: '',
      description: '',
      url: `/heroes/${String(item.heroname).toLowerCase().replace(/\s+/g, '-')}`,
    };
  }
  return result;
}

function normalizeLane(lane = '') {
  const l = lane.toLowerCase().trim();
  if (l.includes('gold')) return 'Gold Lane';
  if (l.includes('jungle') || l.includes('jung')) return 'Jungle';
  if (l.includes('exp')) return 'EXP Lane';
  if (l.includes('mid')) return 'Mid Lane';
  if (l.includes('roam')) return 'Roam';
  return lane;
}

function transformHero(hero, index) {
  const lanes = (hero.laning || []).map(normalizeLane).filter(Boolean);
  const skills = (hero.skills || []).map(transformSkill);

  return {
    heroId: parseInt(hero.mlid) || index + 1,
    name: hero.hero_name,
    title: hero.speciality?.[0] || '',
    role: hero.class || '',
    lane: lanes[0] || '',
    lanes,
    icon: hero.portrait || hero.hero_icon || '',
    skill: skills,
    skins: [],
    arcana: [],
    recommendedEquipment: [],
    buildTitle: '',
    bestPartners: transformRelations(hero.synergies || []),
    suppressingHeroes: transformRelations(hero.counters || []),
    suppressedHeroes: {},
    stats: {
      winRate: '0',
      pickRate: '0',
      banRate: '0',
      tier: '',
    },
    survivalPercentage: '0',
    attackPercentage: '0',
    abilityPercentage: '0',
    difficultyPercentage: '0',
    world: {
      region: '',
      identity: '',
      energy: '',
    },
    uid: hero.uid || '',
    speciality: hero.speciality || [],
  };
}

// ── Item Transformer ──────────────────────────────────────────────────────────

const CATEGORY_MAP = {
  'Attack': 1,
  'Magic': 2,
  'Defense': 3,
  'Movement': 4,
  'Roaming': 5,
  'Jungling': 6,
};

function transformItem(item, index) {
  const d = item.data?.[0] || {};
  const passiveSkills = (d.unique_passive || [])
    .filter(p => p.unique_passive_name && p.unique_passive_name !== 'null')
    .map((p, i) => ({
      id: index * 10 + i,
      description: `[${p.unique_passive_name}] ${p.description}`,
    }));

  return {
    id: index + 1,
    itemId: item.id,
    name: item.item_name,
    icon: item.icon || '',
    description: d.unique_passive?.[0]?.description || '',
    price: parseInt(d.cost) || 0,
    type: CATEGORY_MAP[item.item_category] || 0,
    typeName: item.item_category || '',
    level: parseInt(item.item_tier) || 1,
    levelName: item.item_tier === '3' ? 'Top Equipment' : item.item_tier === '2' ? 'Mid Tier' : 'Basic',
    isTopEquip: item.item_tier === '3',
    buildsFrom: (d.build_path || []).map(b => ({
      id: 0,
      name: b.item_name || b,
      icon: '',
    })),
    upgradesTo: [],
    passiveSkills,
    effects: Object.entries(d.modifiers?.[0] || {}).map(([key, val], i) => ({
      effectType: i,
      valueType: String(val).includes('%') ? 1 : 0,
      value: parseFloat(String(val).replace('%', '')) || 0,
      label: key.replace(/_/g, ' '),
    })),
  };
}

// ── Emblem Transformer ────────────────────────────────────────────────────────

const EMBLEM_COLOR_MAP = {
  'assassin': 1,
  'fighter': 2,
  'mage': 3,
  'marksman': 4,
  'support': 5,
  'tank': 6,
  'common': 0,
};

function transformEmblem(emblem, index) {
  const talents = emblem.data?.[0] || {};
  const allTalents = [
    ...(talents.tier1 || []),
    ...(talents.tier2 || []),
    ...(talents.tier3 || []),
  ].filter(t => t.name && t.name !== 'Talent 1');

  const statsDesc = Object.entries(emblem.modifiers?.[0] || {})
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
    .join(', ');

  return {
    id: index + 1,
    name: emblem.emblem_name,
    icon: emblem.icon || '',
    level: 3,
    description: statsDesc,
    color: EMBLEM_COLOR_MAP[emblem.emblem_role] ?? 0,
    colorName: emblem.emblem_name,
    role: emblem.emblem_role,
    modifiers: emblem.modifiers || [],
    talents: allTalents,
    effects: Object.entries(emblem.modifiers?.[0] || {}).map(([key, val], i) => ({
      effectType: i,
      valueType: String(val).includes('%') ? 1 : 0,
      value: parseFloat(String(val).replace('%', '')) || 0,
    })),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔄 Transforming MLBB-API data...');

  // Heroes
  const heroRaw = JSON.parse(await fs.readFile(path.join(OUTPUT_DIR, 'hero-meta-final.json'), 'utf-8'));
  const heroes = heroRaw.data.filter(h => h.hero_name && h.hero_name !== 'None');
  const heroMap = {};
  heroes.forEach((hero, i) => {
    const transformed = transformHero(hero, i);
    heroMap[transformed.name] = transformed;
  });
  const mergedMlbb = { main: heroMap, meta: { total: heroes.length, updatedAt: new Date().toISOString() } };
  await fs.writeFile(path.join(OUTPUT_DIR, 'merged-mlbb.json'), JSON.stringify(mergedMlbb));
  console.log(`✅ Heroes: ${heroes.length} hero ditransform → merged-mlbb.json`);

  // Items
  const itemRaw = JSON.parse(await fs.readFile(path.join(OUTPUT_DIR, 'item-meta-final.json'), 'utf-8'));
  const items = itemRaw.data.filter(i => i.item_name).map(transformItem);
  await fs.writeFile(path.join(OUTPUT_DIR, 'mlbb-items.json'), JSON.stringify(items));
  console.log(`✅ Items: ${items.length} item ditransform → mlbb-items.json`);

  // Emblems
  const emblemRaw = JSON.parse(await fs.readFile(path.join(OUTPUT_DIR, 'emblem-meta-final.json'), 'utf-8'));
  const emblems = emblemRaw.data.filter(e => e.emblem_name).map(transformEmblem);
  await fs.writeFile(path.join(OUTPUT_DIR, 'mlbb-emblems.json'), JSON.stringify(emblems));
  console.log(`✅ Emblems: ${emblems.length} emblem ditransform → mlbb-emblems.json`);

  console.log('\n🎉 Selesai! Semua data siap di folder output/');
}

main().catch(console.error);
