/**
 * Transform main-emblems.json (from api.mlbb.io) → mlbb-emblems.json (FE format)
 * Run: node src/transform-mlbb-emblems.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

const NEXT_IMG = 'https://mlbb.io/_next/image';
const EMBLEM_PATH = '/images/emblem/main/';

// Role → color mapping (matches FE Arcana type: 1=red, 2=blue, 3=green, 4=yellow, 5=purple, 6=cyan)
const ROLE_COLOR = {
  'common': { color: 0, colorName: 'Common' },
  'assassin': { color: 1, colorName: 'Assassin' },
  'fighter': { color: 2, colorName: 'Fighter' },
  'mage': { color: 3, colorName: 'Mage' },
  'marksman': { color: 4, colorName: 'Marksman' },
  'support': { color: 5, colorName: 'Support' },
  'tank': { color: 6, colorName: 'Tank' },
};

function parseAttributes(attributes) {
  const effects = [];
  const modifiers = {};

  attributes.forEach((attr, idx) => {
    // Parse "Hybrid Regen +12.00" → { key: 'hybrid_regen', value: 12.00 }
    const match = attr.match(/^(.+?)\s+\+(\d+(?:\.\d+)?)(%)?\s*$/);
    if (match) {
      const key = match[1].toLowerCase().replace(/\s+/g, '_');
      const value = parseFloat(match[2]);
      const isPercent = !!match[3];
      modifiers[key] = match[3] ? `${match[2]}%` : match[2];
      effects.push({ effectType: idx, valueType: isPercent ? 1 : 0, value });
    }
  });

  return { effects, modifiers };
}

async function main() {
  const raw = await fs.readFile(path.join(ROOT, 'main-emblems.json'), 'utf-8');
  const source = JSON.parse(raw);
  const emblems = source.data;

  const result = emblems.map(emblem => {
    const role = emblem.name.toLowerCase();
    const colorInfo = ROLE_COLOR[role] || { color: 0, colorName: emblem.name };
    const { effects, modifiers } = parseAttributes(emblem.attributes);
    const description = emblem.attributes.join(', ').toLowerCase().replace(/\+/g, '').trim();

    return {
      id: emblem.id,
      name: emblem.name,
      icon: `${NEXT_IMG}?url=${encodeURIComponent(EMBLEM_PATH + emblem.img_src)}&w=128&q=75`,
      level: 3,
      description,
      color: colorInfo.color,
      colorName: colorInfo.colorName,
      role,
      modifiers: [modifiers],
      effects,
    };
  });

  await fs.writeFile(
    path.join(OUTPUT_DIR, 'mlbb-emblems.json'),
    JSON.stringify(result)
  );

  console.log(`✅ Transformed ${result.length} emblems → output/mlbb-emblems.json`);
  result.forEach(e => console.log(`   ${e.name}: ${e.icon}`));
}

main().catch(console.error);
