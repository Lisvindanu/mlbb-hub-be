/**
 * Scrape MLBB patch notes dari Liquipedia - SHARD mode
 * Usage: node src/scrape-patches-shard.mjs --shard 0 --total 3
 *   shard: index shard ini (0-based)
 *   total: total jumlah shard/VPS
 *
 * Output: output/mlbb-patches-shard-{shard}.json
 * Merge: node src/scrape-patches-shard.mjs --merge
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

const LP_API = 'https://liquipedia.net/mobilelegends/api.php';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 mlbb-hub/1.0 (educational project)',
  'Accept-Encoding': 'gzip',
};
const DELAY_MS = 5000;

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    args[key] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchJson(params, retries = 5) {
  const url = LP_API + '?' + new URLSearchParams({ ...params, format: 'json' });
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      const text = await res.text();
      if (text.startsWith('{')) return JSON.parse(text);
      const wait = (i + 1) * 30000;
      process.stdout.write(` [rate-limited, wait ${wait / 1000}s] `);
      await sleep(wait);
    } catch (e) {
      const wait = (i + 1) * 10000;
      process.stdout.write(` [error: ${e.message}, wait ${wait / 1000}s] `);
      await sleep(wait);
    }
  }
  throw new Error('fetch failed after retries');
}

async function getAllPatches() {
  const data = await fetchJson({
    action: 'query',
    list: 'allpages',
    apprefix: 'Patch',
    aplimit: '500',
  });
  return (data.query?.allpages || [])
    .map(p => p.title)
    .filter(t => /^Patch[\s_][\d.]/.test(t))
    .sort((a, b) => b.localeCompare(a)); // newest first
}

function parseHeroAdjustments(wikitext) {
  const heroes = [];
  let i = 0;
  while (i < wikitext.length) {
    const start = wikitext.indexOf('{{Herobc', i);
    if (start === -1) break;
    let depth = 0;
    let end = start;
    while (end < wikitext.length) {
      if (wikitext[end] === '{' && wikitext[end + 1] === '{') { depth++; end += 2; }
      else if (wikitext[end] === '}' && wikitext[end + 1] === '}') { depth--; end += 2; if (depth === 0) break; }
      else end++;
    }
    const block = wikitext.slice(start + 8, end - 2);
    const params = {};
    let pdepth = 0, segStart = 0;
    const segments = [];
    for (let j = 0; j < block.length; j++) {
      if (block[j] === '{' && block[j+1] === '{') { pdepth++; j++; }
      else if (block[j] === '}' && block[j+1] === '}') { pdepth--; j++; }
      else if (block[j] === '\n' && block[j+1] === '|' && pdepth === 0) {
        segments.push(block.slice(segStart, j));
        segStart = j + 2;
      }
    }
    segments.push(block.slice(segStart));
    for (const seg of segments) {
      const eqIdx = seg.indexOf('=');
      if (eqIdx === -1) continue;
      params[seg.slice(0, eqIdx).trim().toLowerCase()] = seg.slice(eqIdx + 1).trim();
    }
    const hero = params['hero'];
    if (hero) {
      const type = (params['type'] || 'adjust').toLowerCase();
      const note = params['note'] || '';
      const adjustment = (params['adjustment'] || '')
        .replace(/'''(.*?)'''/g, '$1')
        .replace(/\{\{ai\|[^|]*\|([^}]*)\}\}/g, '$1')
        .replace(/\{\{TextID\|([^}]*)\}\}/g, '[$1]')
        .replace(/\{\{[^}]*\}\}/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      heroes.push({ hero, type: type || 'adjust', note, changes: adjustment });
    }
    i = end;
  }
  return heroes;
}

function parseReleaseDate(wikitext) {
  return wikitext.match(/\|release\s*=\s*([\d-]+)/)?.[1] || null;
}

function parseVersion(title) {
  return title.replace(/^Patch\s+/i, '').trim();
}

async function fetchPatchData(title) {
  const data = await fetchJson({ action: 'parse', page: title, prop: 'wikitext' });
  const wikitext = data.parse?.wikitext?.['*'] || '';
  return { version: parseVersion(title), releaseDate: parseReleaseDate(wikitext), heroes: parseHeroAdjustments(wikitext), rawTitle: title };
}

// ── MERGE MODE ────────────────────────────────────────────────────────────────
if (args.merge) {
  const files = (await fs.readdir(OUTPUT_DIR)).filter(f => f.match(/^mlbb-patches-shard-\d+\.json$/));
  const base = JSON.parse(await fs.readFile(path.join(OUTPUT_DIR, 'mlbb-patches.json'), 'utf-8').catch(() => '[]'));
  const doneSet = new Set(base.map(p => p.rawTitle));
  let merged = [...base];
  let added = 0;
  for (const file of files) {
    const shard = JSON.parse(await fs.readFile(path.join(OUTPUT_DIR, file), 'utf-8'));
    for (const p of shard) {
      if (!doneSet.has(p.rawTitle)) { merged.push(p); doneSet.add(p.rawTitle); added++; }
    }
  }
  merged.sort((a, b) => b.version.localeCompare(a.version));
  await fs.writeFile(path.join(OUTPUT_DIR, 'mlbb-patches.json'), JSON.stringify(merged, null, 2));
  console.log(`✅ Merged! ${added} new patches added. Total: ${merged.length}`);
  process.exit(0);
}

// ── SHARD MODE ────────────────────────────────────────────────────────────────
const shardIdx = parseInt(args.shard ?? '0');
const totalShards = parseInt(args.total ?? '1');

console.log(`🔀 Shard ${shardIdx + 1}/${totalShards}`);

// Use cached patch list if available, otherwise fetch from Liquipedia
let allPatches;
const listFile = path.join(OUTPUT_DIR, 'mlbb-patch-list.json');
try {
  allPatches = JSON.parse(await fs.readFile(listFile, 'utf-8'));
  console.log(`Using cached patch list: ${allPatches.length} patches\n`);
} catch {
  console.log('Fetching patch list from Liquipedia...');
  allPatches = await getAllPatches();
  await fs.writeFile(listFile, JSON.stringify(allPatches, null, 2));
  console.log(`Found ${allPatches.length} patches total\n`);
}

// Load already-done patches (from main file)
let done = new Set();
try {
  const base = JSON.parse(await fs.readFile(path.join(OUTPUT_DIR, 'mlbb-patches.json'), 'utf-8'));
  done = new Set(base.map(p => p.rawTitle));
  console.log(`Skipping ${done.size} already scraped patches\n`);
} catch {}

// Filter remaining and assign this shard's slice
const remaining = allPatches.filter(t => !done.has(t));
const myPatches = remaining.filter((_, i) => i % totalShards === shardIdx);
console.log(`This shard: ${myPatches.length} patches to scrape\n`);

const outputFile = path.join(OUTPUT_DIR, `mlbb-patches-shard-${shardIdx}.json`);
let result = [];
try {
  result = JSON.parse(await fs.readFile(outputFile, 'utf-8'));
  console.log(`Resuming: ${result.length} patches already in shard file\n`);
} catch {}

const shardDone = new Set(result.map(p => p.rawTitle));

for (const title of myPatches) {
  if (shardDone.has(title)) { process.stdout.write(`  ⏩ ${title}\n`); continue; }
  process.stdout.write(`  ${title}... `);
  await sleep(DELAY_MS);
  try {
    const patch = await fetchPatchData(title);
    result.push(patch);
    console.log(`✅ ${patch.heroes.length} hero adjustments (${patch.releaseDate || 'no date'})`);
    await fs.writeFile(outputFile, JSON.stringify(result, null, 2));
  } catch (e) {
    console.log(`❌ ${e.message}`);
  }
}

await fs.writeFile(outputFile, JSON.stringify(result, null, 2));
console.log(`\n🎉 Shard ${shardIdx} done! ${result.length} patches scraped.`);
console.log(`   Saved to output/mlbb-patches-shard-${shardIdx}.json`);
console.log(`\nMerge all shards with: node src/scrape-patches-shard.mjs --merge`);
