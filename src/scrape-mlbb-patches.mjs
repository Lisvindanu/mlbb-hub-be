/**
 * Scrape MLBB patch notes dari Liquipedia
 * Run: node src/scrape-mlbb-patches.mjs
 * Output: output/mlbb-patches.json
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
const DELAY_MS = 5000; // Liquipedia rate limit

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
      // Rate limited — wait longer and retry
      const wait = (i + 1) * 30000; // 30s, 60s, 90s, 120s, 150s
      process.stdout.write(` [rate-limited, wait ${wait/1000}s] `);
      await sleep(wait);
    } catch (e) {
      const wait = (i + 1) * 10000;
      process.stdout.write(` [error: ${e.message}, wait ${wait/1000}s] `);
      await sleep(wait);
    }
  }
  throw new Error('fetch failed after retries');
}

// Ambil semua halaman patch
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

// Parse {{Herobc}} templates dari wikitext
function parseHeroAdjustments(wikitext) {
  const heroes = [];
  let i = 0;

  while (i < wikitext.length) {
    const start = wikitext.indexOf('{{Herobc', i);
    if (start === -1) break;

    // Find matching closing }} counting brace depth
    let depth = 0;
    let end = start;
    while (end < wikitext.length) {
      if (wikitext[end] === '{' && wikitext[end + 1] === '{') {
        depth++;
        end += 2;
      } else if (wikitext[end] === '}' && wikitext[end + 1] === '}') {
        depth--;
        end += 2;
        if (depth === 0) break;
      } else {
        end++;
      }
    }

    const block = wikitext.slice(start + 8, end - 2); // skip {{Herobc prefix and }}

    // Split params on newline+| while respecting nested {{ }} depth
    const params = {};
    let pdepth = 0;
    let segStart = 0;
    const segments = [];
    for (let j = 0; j < block.length; j++) {
      if (block[j] === '{' && block[j + 1] === '{') { pdepth++; j++; }
      else if (block[j] === '}' && block[j + 1] === '}') { pdepth--; j++; }
      else if (block[j] === '\n' && block[j + 1] === '|' && pdepth === 0) {
        segments.push(block.slice(segStart, j));
        segStart = j + 2; // skip \n|
      }
    }
    segments.push(block.slice(segStart));
    for (const seg of segments) {
      const eqIdx = seg.indexOf('=');
      if (eqIdx === -1) continue;
      const key = seg.slice(0, eqIdx).trim().toLowerCase();
      const value = seg.slice(eqIdx + 1).trim();
      params[key] = value;
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

// Parse release date dari infobox
function parseReleaseDate(wikitext) {
  const m = wikitext.match(/\|release\s*=\s*([\d-]+)/);
  return m?.[1] || null;
}

// Parse patch version dari title
function parseVersion(title) {
  return title.replace(/^Patch\s+/i, '').trim();
}

async function fetchPatchData(title) {
  const data = await fetchJson({
    action: 'parse',
    page: title,
    prop: 'wikitext',
  });
  const wikitext = data.parse?.wikitext?.['*'] || '';
  return {
    version: parseVersion(title),
    releaseDate: parseReleaseDate(wikitext),
    heroes: parseHeroAdjustments(wikitext),
    rawTitle: title,
  };
}

async function main() {
  console.log('Fetching patch list from Liquipedia...');
  const patches = await getAllPatches();
  console.log(`Found ${patches.length} patches\n`);

  // Resume: load existing data
  let result = [];
  const outputFile = path.join(OUTPUT_DIR, 'mlbb-patches.json');
  try {
    result = JSON.parse(await fs.readFile(outputFile, 'utf-8'));
    console.log(`Resuming: ${result.length} patches already scraped\n`);
  } catch {}

  // Load failed/skipped list to avoid retrying rate-limited patches
  const skipFile = path.join(OUTPUT_DIR, 'mlbb-patches-skip.json');
  let skipList = new Set();
  try {
    const skipped = JSON.parse(await fs.readFile(skipFile, 'utf-8'));
    skipList = new Set(skipped);
    console.log(`Skipping ${skipList.size} previously failed patches\n`);
  } catch {}

  const done = new Set(result.map(p => p.rawTitle));
  let total = result.reduce((s, p) => s + p.heroes.length, 0);

  for (const title of patches) {
    if (done.has(title)) { process.stdout.write(`  ⏩ ${title}\n`); continue; }
    if (skipList.has(title)) { process.stdout.write(`  ⛔ ${title} (skipped)\n`); continue; }
    process.stdout.write(`  ${title}... `);
    await sleep(DELAY_MS);

    try {
      const patch = await fetchPatchData(title);
      result.push(patch);
      total += patch.heroes.length;
      console.log(`✅ ${patch.heroes.length} hero adjustments (${patch.releaseDate || 'no date'})`);
      // Save after every successful patch
      await fs.writeFile(outputFile, JSON.stringify(result, null, 2));
    } catch (e) {
      console.log(`❌ ${e.message} — adding to skip list`);
      skipList.add(title);
      await fs.writeFile(skipFile, JSON.stringify([...skipList], null, 2));
    }
  }

  await fs.writeFile(
    path.join(OUTPUT_DIR, 'mlbb-patches.json'),
    JSON.stringify(result, null, 2)
  );

  console.log(`\n🎉 Done! ${result.length} patches, ${total} total hero adjustments`);
  console.log(`   Saved to output/mlbb-patches.json`);
}

main().catch(console.error);
