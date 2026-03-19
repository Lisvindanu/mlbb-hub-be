/**
 * Transform items.json (from api.mlbb.io) → mlbb-items.json (FE format)
 * Run: node src/transform-mlbb-items.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

const IMAGE_BASE = 'https://mlbb.io/_next/image';

const CATEGORY_TO_TYPE = {
  'Attack': { id: 1, name: 'Physical' },
  'Magic': { id: 2, name: 'Magical' },
  'Defense': { id: 3, name: 'Defense' },
  'Movement': { id: 4, name: 'Boots' },
  'Attack & Magic': { id: 1, name: 'Physical' },
  'Attack, Magic & Defense': { id: 3, name: 'Defense' },
};

function getLevel(price) {
  if (price < 800) return { id: 1, name: 'Basic' };
  if (price < 1600) return { id: 2, name: 'Mid-Tier' };
  return { id: 3, name: 'Advanced' };
}

async function main() {
  const raw = await fs.readFile(path.join(ROOT, 'items.json'), 'utf-8');
  const source = JSON.parse(raw);
  const items = source.data;

  const result = items
    .filter(item => !item.removed)
    .map(item => {
      const typeInfo = CATEGORY_TO_TYPE[item.category] || { id: 0, name: item.category };
      const levelInfo = getLevel(item.price_total);
      const isTopEquip = levelInfo.id === 3;

      // Build passiveSkills from passive_description
      const passiveSkills = [];
      if (item.passive_description) {
        // Split by "Unique Passive" or "Unique Attribute" markers
        const parts = item.passive_description
          .split(/(?=Unique Passive|Unique Attribute)/)
          .map(p => p.trim())
          .filter(Boolean);
        parts.forEach((p, idx) => {
          passiveSkills.push({ id: idx, description: p });
        });
      }

      // Build effects from known stats
      const effects = [];
      const statsMap = [
        { field: 'physical_attack', label: 'Physical Attack', effectType: 0, valueType: 0 },
        { field: 'magic_power', label: 'Magic Power', effectType: 1, valueType: 0 },
        { field: 'hp', label: 'HP', effectType: 2, valueType: 0 },
        { field: 'physical_defense', label: 'Physical Defense', effectType: 3, valueType: 0 },
        { field: 'magic_defense', label: 'Magic Defense', effectType: 4, valueType: 0 },
        { field: 'movement_speed', label: 'Movement Speed', effectType: 5, valueType: 0 },
        { field: 'attack_speed', label: 'Attack Speed', effectType: 6, valueType: 1 },
        { field: 'cooldown_reduction', label: 'Cooldown Reduction', effectType: 7, valueType: 1 },
        { field: 'lifesteal', label: 'Lifesteal', effectType: 8, valueType: 1 },
        { field: 'spell_vamp', label: 'Spell Vamp', effectType: 9, valueType: 1 },
        { field: 'penetration', label: 'Penetration', effectType: 10, valueType: 0 },
      ];
      statsMap.forEach(({ field, label, effectType, valueType }) => {
        if (item[field] && item[field] !== 0) {
          effects.push({ effectType, valueType, value: item[field], label });
        }
      });

      return {
        id: item.id,
        name: item.name,
        icon: `${IMAGE_BASE}?url=${encodeURIComponent(item.image_path)}&w=128&q=75`,
        description: item.passive_description || item.stats_other || '',
        price: item.price_total,
        type: typeInfo.id,
        typeName: typeInfo.name,
        level: levelInfo.id,
        levelName: levelInfo.name,
        isTopEquip,
        buildsFrom: [],
        upgradesTo: [],
        passiveSkills,
        effects,
      };
    });

  await fs.writeFile(
    path.join(OUTPUT_DIR, 'mlbb-items.json'),
    JSON.stringify(result)
  );

  console.log(`✅ Transformed ${result.length} items → output/mlbb-items.json`);
  console.log(`   Types: ${[...new Set(result.map(i => i.typeName))].join(', ')}`);
}

main().catch(console.error);
