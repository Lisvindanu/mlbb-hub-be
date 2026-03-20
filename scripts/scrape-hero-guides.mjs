/**
 * scrape-hero-guides.mjs
 * Scrapes hero guide content from mlbbhub.com for all 132 heroes.
 * Saves to output/mlbb-hero-guides.json
 * Resume-able via output/guide-progress.json
 * Usage: node scripts/scrape-hero-guides.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE   = path.join(__dirname, '../output/mlbb-hero-guides.json');
const PROGRESS_FILE = path.join(__dirname, '../output/guide-progress.json');
const DATA_FILE     = path.join(__dirname, '../output/merged-mlbb.json');

// Convert hero name to URL slug
function toSlug(name) {
  return name
    .toLowerCase()
    .replace(/'/g, '')           // remove apostrophes (Chang'e → change)
    .replace(/\./g, '-')         // dots to hyphens (X.Borg → x-borg)
    .replace(/\s+/g, '-')        // spaces to hyphens
    .replace(/[^a-z0-9-]/g, '')  // remove other special chars
    .replace(/-+/g, '-')         // collapse multiple hyphens
    .replace(/^-|-$/g, '');      // trim hyphens
}

function unescape(str) {
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

function extractText(html, startMarker, endMarkers = []) {
  const idx = html.indexOf(startMarker);
  if (idx < 0) return null;
  let end = html.length;
  for (const em of endMarkers) {
    const ei = html.indexOf(em, idx + startMarker.length + 1);
    if (ei > 0 && ei < end) end = ei;
  }
  return unescape(html.slice(idx, end).trim());
}

function parseGuide(html, heroName) {
  const guide = {};

  // ── Description ──────────────────────────────────────────────────────────
  // Find "heroName, the ..." pattern
  const descPatterns = [
    new RegExp(`${heroName}[^"\\\\]{0,5}is a [^"\\\\]{20,500}(?=\\\\n\\\\n|How to Play)`, 'i'),
    new RegExp(`${heroName}[^"\\\\]{0,5}is an [^"\\\\]{20,500}(?=\\\\n\\\\n|How to Play)`, 'i'),
  ];
  for (const p of descPatterns) {
    const m = html.match(p);
    if (m) { guide.description = unescape(m[0]); break; }
  }
  // Fallback: find full description block
  if (!guide.description) {
    const howIdx = html.indexOf(`How to Play ${heroName}`);
    if (howIdx > 0) {
      const region = html.slice(Math.max(0, howIdx - 2000), howIdx);
      const nameIdx = region.lastIndexOf(heroName);
      if (nameIdx >= 0) {
        const raw = region.slice(nameIdx);
        const end = raw.search(/\\n\\n|How to Play/);
        if (end > 20) guide.description = unescape(raw.slice(0, end));
      }
    }
  }

  // ── How to Play ───────────────────────────────────────────────────────────
  const howStart = `How to Play ${heroName}\\n\\n`;
  guide.howToPlay = extractText(html, howStart, [
    '### Game Phase',
    '## Game Phase',
    'Game Phase Strategy\\n',
    '### Counter',
    'Heroes That Counter',
    'Pro Tips',
  ]);
  if (guide.howToPlay) {
    guide.howToPlay = guide.howToPlay.replace(/^How to Play [^\n]+\n+/, '');
  }

  // ── Game Phase Strategy ───────────────────────────────────────────────────
  const phaseBlock = extractText(html, 'Game Phase Strategy\\n\\n', [
    '### Lane',
    'Lane Assignment',
    '### Recommended',
    'Recommended Build',
    '### Counter',
    'Heroes That Counter',
    'Pro Tips',
  ]);
  if (phaseBlock) {
    const early = phaseBlock.match(/\*\*Early Game[^*]+\*\*:?\s*([^\n*]+)/)?.[1]?.trim();
    const mid   = phaseBlock.match(/\*\*Mid Game[^*]+\*\*:?\s*([^\n*]+)/)?.[1]?.trim();
    const late  = phaseBlock.match(/\*\*Late Game[^*]+\*\*:?\s*([^\n*]+)/)?.[1]?.trim();
    if (early || mid || late) {
      guide.gamePhase = {
        early: early || '',
        mid:   mid   || '',
        late:  late  || '',
      };
    }
  }

  // ── Lane Assignment ───────────────────────────────────────────────────────
  const laneBlock = extractText(html, 'Lane Assignment\\n\\n', [
    '### Recommended',
    'Recommended Build',
    'Recommended Lane',
    '### Counter',
    'Heroes That Counter',
    'Pro Tips',
  ]);
  if (laneBlock) {
    const laneMatch = laneBlock.match(/Recommended Lane:\s*([^\n.]+)/i);
    const laneDesc  = laneBlock.match(/Recommended Lane:[^\n]+\n+([^#]+)/)?.[1]?.trim();
    if (laneMatch) {
      guide.laneAssignment = {
        lane: laneMatch[1].trim(),
        desc: laneDesc || '',
      };
    }
  }

  // ── Pro Tips ──────────────────────────────────────────────────────────────
  const proBlock = extractText(html, 'Pro Tips\\n\\n', [
    '### Summary',
    '## Summary',
    'Summary\\n',
    '### Counter',
  ]);
  if (proBlock) {
    const tips = [...proBlock.matchAll(/^\d+\.\s*(.+)|^[-•]\s*(.+)/gm)]
      .map(m => (m[1] || m[2]).trim())
      .filter(Boolean);
    if (tips.length === 0) {
      // Try plain line list
      guide.proTips = proBlock
        .split('\n')
        .map(l => l.replace(/^[\d\-•.]+\s*/, '').trim())
        .filter(l => l.length > 10)
        .slice(0, 6);
    } else {
      guide.proTips = tips.slice(0, 6);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const summaryBlock = extractText(html, 'Summary\\n\\n', ['###', '"']);
  if (summaryBlock) {
    guide.summary = summaryBlock
      .replace(/^Summary\n+/, '')
      .split('\n')[0]
      .trim();
  }

  return guide;
}

async function scrapeHero(heroName) {
  const slug = toSlug(heroName);
  const url  = `https://mlbbhub.com/heroes/${slug}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (html.length < 10000) throw new Error('Response too short');

    const guide = parseGuide(html, heroName);

    // Validate — at minimum need description or howToPlay
    if (!guide.description && !guide.howToPlay) {
      throw new Error('No content extracted');
    }
    return { slug, guide };
  } catch (e) {
    throw new Error(`${url} — ${e.message}`);
  }
}

async function main() {
  const raw   = await fs.readFile(DATA_FILE, 'utf8');
  const data  = JSON.parse(raw);
  const heroNames = Object.keys(data.main);

  let guides   = {};
  let progress = {};
  try { guides   = JSON.parse(await fs.readFile(OUTPUT_FILE,   'utf8')); } catch {}
  try { progress = JSON.parse(await fs.readFile(PROGRESS_FILE, 'utf8')); } catch {}

  const total   = heroNames.length;
  let done = 0, skipped = 0, errors = 0;

  console.log(`Total heroes: ${total}`);
  if (Object.keys(progress).length > 0) {
    console.log(`Resume — ${Object.keys(progress).filter(k => progress[k]).length} already done\n`);
  }

  for (const heroName of heroNames) {
    if (progress[heroName]) { skipped++; continue; }

    try {
      const { slug, guide } = await scrapeHero(heroName);
      guides[heroName] = guide;
      progress[heroName] = true;
      done++;

      const pct = Math.round(((done + skipped) / total) * 100);
      const fields = Object.keys(guide).join(', ');
      console.log(`[${pct}%] ✓ ${heroName} (${slug}) — ${fields}`);

      // Save every 10 heroes
      if (done % 10 === 0) {
        await fs.writeFile(OUTPUT_FILE,   JSON.stringify(guides));
        await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress));
        console.log('  → Checkpoint saved\n');
      }

      // 500ms delay to be polite
      await new Promise(r => setTimeout(r, 500));

    } catch (e) {
      errors++;
      progress[heroName] = false; // mark as failed so we can retry
      console.error(`[ERROR] ${heroName}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  await fs.writeFile(OUTPUT_FILE,   JSON.stringify(guides));
  await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress));

  console.log(`\n✅ Selesai!`);
  console.log(`   Scraped : ${done}`);
  console.log(`   Skipped : ${skipped}`);
  console.log(`   Errors  : ${errors}`);
}

main().catch(console.error);
