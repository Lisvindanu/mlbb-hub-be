/**
 * Import skin data from Fandom wiki Module:Skin/data
 * Fetches the Lua data module, parses all hero skins, and updates merged-mlbb.json
 * with complete skin names, tags, tiers, and image URLs from existing local files.
 *
 * Usage: node src/import-fandom-skins.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const SKINS_DIR = path.join(__dirname, '..', 'public', 'images', 'skins');
const DATA_FILE = path.join(OUTPUT_DIR, 'merged-mlbb.json');

const FANDOM_API = 'https://mobile-legends.fandom.com/api.php';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 mlbb-hub/1.0 (educational project)' };

// Tag → tierName + tierColor mapping (case-insensitive keys handled in getTagTier)
const TAG_TIER = {
  'collector':        { name: 'Collector',  color: '#FF6B35' },
  'lightborn':        { name: 'Lightborn',  color: '#60A5FA' },
  'legend':           { name: 'Legend',     color: '#FFD700' },
  'starlight':        { name: 'Starlight',  color: '#C084FC' },
  'annual starlight': { name: 'Starlight',  color: '#C084FC' },
  'epic':             { name: 'Epic',       color: '#A78BFA' },
  'special':          { name: 'Special',    color: '#34D399' },
  'elite':            { name: 'Elite',      color: '#F59E0B' },
  'limited':          { name: 'Limited',    color: '#F43F5E' },
  'luckybox':         { name: 'Limited',    color: '#F43F5E' },
  'fmvp':             { name: 'FMVP',       color: '#EF4444' },
};

// Tags that are collab series — Collab tier
const COLLAB_KEYWORDS = [
  'naruto', 'king of fighters', 'kof', 'star wars', 'jujutsu kaisen',
  'attack on titan', 'transformers', 'venom', 'saint seiya', 'sanrio',
  'kung fu panda', 'neymar', 'pacquiao', 'ducati', 'atomic pop',
  'neobeasts', 'dragon ball', 'one piece', 'fate',
];

// Normalize tag name to canonical series name
const SERIES_CANONICAL = {
  'naruto': 'Naruto Shippuden',
  'naruto shippuden': 'Naruto Shippuden',
  'king of fighters': 'King of Fighters',
  'kof': 'King of Fighters',
  'attack on titan': 'Attack on Titan',
  'aot': 'Attack on Titan',
  'jujutsu kaisen': 'Jujutsu Kaisen',
  'saint seiya': 'Saint Seiya',
  'sanrio characters': 'Sanrio Characters',
  'sanrio': 'Sanrio Characters',
  'kung fu panda': 'Kung Fu Panda',
  'neymar jr': 'Neymar Jr.',
  'neymar': 'Neymar Jr.',
  'the exorcists': 'Exorcist',
  'exorcist': 'Exorcist',
  'the aspirants': 'The Aspirants',
  'aspirants': 'The Aspirants',
  'zodiac': 'Zodiac',
  'abyss': 'ABYSS',
  'prime': 'PRIME',
  'soul vessel': 'Soul Vessel',
  'kishin': 'Kishin',
  'mistbenders': 'Mistbenders',
  'blazing': 'Blazing',
  's.t.u.n.': 'S.T.U.N.',
  'stun': 'S.T.U.N.',
  'hunter': 'Hunter',
  'sparkle': 'Sparkle',
  'covenant': 'Covenant',
  'beyond the clouds': 'Beyond The Clouds',
  'm-world': 'M-World',
  'neobeasts': 'Neobeasts',
  'atomic': 'Atomic',
  'star wars': 'Star Wars',
  'transformers': 'Transformers',
  'venom': 'Venom',
  'ducati': 'Ducati',
  'saber': 'S.A.B.E.R.',
};

function getTagTier(tag) {
  if (!tag) return { name: 'Default', color: '#6B7280' };
  const tl = tag.toLowerCase();
  if (TAG_TIER[tl]) return TAG_TIER[tl];
  // Collab
  if (COLLAB_KEYWORDS.some(k => tl.includes(k))) return { name: 'Collab', color: '#F59E42' };
  // Collab series that are also premium
  if (['the exorcists','exorcist','the aspirants','abyss','prime','soul vessel','kishin','mistbenders','blazing','s.t.u.n.','covenant'].some(k => tl.includes(k)))
    return { name: 'Epic', color: '#A78BFA' };
  // MPL / tournament
  if (/^m\d$/.test(tl) || ['mpl','msc','champion','hero','create','allstar'].includes(tl))
    return { name: ['mpl','msc'].includes(tl) ? 'MPL' : 'FMVP', color: '#EF4444' };
  // Events → Special
  if (['summer','christmas','valentine','halloween','lunar','double 11','anniversary','first recharge','seasonal','515','11.11','zodiac'].some(k => tl.includes(k)))
    return { name: 'Special', color: '#34D399' };
  return { name: 'Special', color: '#34D399' };
}

function getSkinSeries(tag) {
  if (!tag) return null;
  const tl = tag.toLowerCase();
  return SERIES_CANONICAL[tl] || null;
}

/**
 * Parse a Lua table block into a flat key→value object.
 * Handles one level of nesting (price sub-table is ignored).
 */
function parseLuaTable(block) {
  const result = {};
  const re = /\["(\w+)"\]\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    result[m[1]] = m[2];
  }
  // Detect painted skin: has ["tc"] key in price block
  result._isPainted = /\["tc"\]/.test(block);
  return result;
}

/**
 * Parse all heroes and their skins from the Lua module content
 */
function parseLuaModule(lua) {
  const heroes = {};
  // Match ["HeroName"] = { ... }
  const heroRe = /\["([A-Za-z'. \-]+)"\]\s*=\s*\{/g;
  let hm;
  while ((hm = heroRe.exec(lua)) !== null) {
    const heroName = hm[1];
    if (heroName === 'skins' || heroName === 'price') continue;

    // Find the full hero block
    let depth = 0, i = hm.index + hm[0].length - 1;
    const blockStart = i;
    while (i < lua.length) {
      if (lua[i] === '{') depth++;
      else if (lua[i] === '}') { depth--; if (depth === 0) break; }
      i++;
    }
    const heroBlock = lua.slice(blockStart, i + 1);

    // Extract skins sub-block
    const skinsIdx = heroBlock.indexOf('["skins"] = {');
    if (skinsIdx === -1) continue;

    const skins = [];
    // Find each skin entry ["NNN"] = { ... }
    const skinRe = /\["\d+"\]\s*=\s*\{/g;
    let sm;
    while ((sm = skinRe.exec(heroBlock)) !== null) {
      let sdepth = 0, si = sm.index + sm[0].length - 1;
      const sstart = si;
      while (si < heroBlock.length) {
        if (heroBlock[si] === '{') sdepth++;
        else if (heroBlock[si] === '}') { sdepth--; if (sdepth === 0) break; }
        si++;
      }
      const skinBlock = heroBlock.slice(sstart, si + 1);
      const parsed = parseLuaTable(skinBlock);
      if (parsed.name && !parsed._isPainted) skins.push(parsed);
    }

    heroes[heroName] = skins;
  }
  return heroes;
}

function safeName(str) {
  return str.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_');
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
console.log('\n📥 Fetching Fandom skin data module...');
const url = FANDOM_API + '?' + new URLSearchParams({
  action: 'query', titles: 'Module:Skin/data', prop: 'revisions', rvprop: 'content', format: 'json'
});
const res = await fetch(url, { headers: HEADERS });
const apiData = await res.json();
const pages = apiData.query?.pages || {};
let lua = '';
for (const page of Object.values(pages)) {
  lua = page.revisions?.[0]?.['*'] || '';
}
if (!lua) { console.error('❌ Failed to fetch Lua module'); process.exit(1); }
console.log(`✅ Got ${(lua.length / 1024).toFixed(0)}KB of skin data`);

console.log('\n🔍 Parsing skin data...');
const fandomHeroes = parseLuaModule(lua);
console.log(`Parsed ${Object.keys(fandomHeroes).length} heroes`);

// Load existing data
const rawData = JSON.parse(await fs.readFile(DATA_FILE, 'utf-8'));
const heroes = rawData.main;

// Get list of downloaded skin images per hero
async function getLocalImages(heroName) {
  const heroDir = path.join(SKINS_DIR, safeName(heroName));
  try {
    const files = await fs.readdir(heroDir);
    return files.map(f => ({ file: f, base: f.replace(/\.[^.]+$/, '').toLowerCase() }));
  } catch { return []; }
}

function findLocalImage(localImages, skinName) {
  const target = safeName(skinName).toLowerCase();
  const match = localImages.find(img => img.base === target);
  return match ? match.file : null;
}

console.log('\n🔄 Updating heroes...\n');
let updated = 0, heroNotFound = 0, totalSkins = 0;

for (const [fandomName, fandomSkins] of Object.entries(fandomHeroes)) {
  // Try to find matching hero in our data (name variations)
  let hero = heroes[fandomName];
  if (!hero) {
    // Try common name variants
    const variants = [
      fandomName.replace(/\s+/g, ''),
      fandomName.split(' ').map((w,i) => i === 0 ? w : w).join(' '),
    ];
    for (const v of variants) {
      if (heroes[v]) { hero = heroes[v]; break; }
    }
  }
  if (!hero) { heroNotFound++; continue; }

  const localImages = await getLocalImages(fandomName);

  const skins = [];
  for (const fd of fandomSkins) {
    const tag = fd.tag || '';
    const tier = getTagTier(tag);
    const series = getSkinSeries(tag);

    // Find local image (Liquipedia download)
    const localFile = findLocalImage(localImages, fd.name);
    const heroSafe = safeName(fandomName);
    // Prefer Liquipedia file if exists, else will be downloaded from Fandom later
    const skinImage = localFile
      ? `/images/skins/${heroSafe}/${localFile}`
      : null;

    skins.push({
      skinName: fd.name,
      skinType: tag || fd.tier || 'Default',
      skinImage,
      tierName: tier.name,
      tierColor: tier.color,
      skinSeries: series,
      fandomId: fd.id,
      source: 'fandom',
    });
  }

  hero.skins = skins;
  updated++;
  totalSkins += skins.length;
  process.stdout.write(`  ✅ ${fandomName}: ${skins.length} skins\n`);
}

rawData.meta.updatedAt = new Date().toISOString();
await fs.writeFile(DATA_FILE, JSON.stringify(rawData, null, 2));

console.log(`\n🎉 Done!`);
console.log(`   Heroes updated: ${updated}`);
console.log(`   Heroes not matched: ${heroNotFound}`);
console.log(`   Total skins: ${totalSkins}`);
