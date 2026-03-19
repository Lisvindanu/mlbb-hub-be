/**
 * Download item & emblem images from mlbb.io → be/public/images/items/ & be/public/images/emblems/
 * Run: node src/download-item-images.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const ITEMS_DIR = path.join(__dirname, '..', 'public', 'images', 'items');
const EMBLEMS_DIR = path.join(__dirname, '..', 'public', 'images', 'emblems');

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', async () => {
        await fs.writeFile(dest, Buffer.concat(chunks));
        resolve();
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Extract original filename from _next/image?url=... query param
function getFilenameFromNextUrl(iconUrl) {
  const u = new URL(iconUrl);
  const urlParam = u.searchParams.get('url');
  if (!urlParam) return null;
  return path.basename(decodeURIComponent(urlParam));
}

async function downloadAll(jsonFile, destDir, label) {
  await fs.mkdir(destDir, { recursive: true });

  const raw = await fs.readFile(jsonFile, 'utf-8');
  const items = JSON.parse(raw);

  let downloaded = 0, skipped = 0, failed = 0;

  for (const item of items) {
    if (!item.icon || !item.icon.startsWith('http')) continue;

    const filename = getFilenameFromNextUrl(item.icon);
    if (!filename) continue;

    const dest = path.join(destDir, filename);

    try {
      await fs.access(dest);
      skipped++;
      continue;
    } catch {}

    try {
      await downloadFile(item.icon, dest);
      process.stdout.write(`✅ ${filename}\n`);
      downloaded++;
    } catch (e) {
      process.stdout.write(`❌ ${filename}: ${e.message}\n`);
      failed++;
    }
  }

  console.log(`\n[${label}] Downloaded: ${downloaded}, Skipped: ${skipped}, Failed: ${failed}`);
  return failed === 0;
}

function toLocalPath(iconUrl, folder) {
  const filename = getFilenameFromNextUrl(iconUrl);
  return filename ? `/images/${folder}/${filename}` : iconUrl;
}

async function updatePaths(jsonFile, folder) {
  const raw = await fs.readFile(jsonFile, 'utf-8');
  const items = JSON.parse(raw);
  const updated = items.map(item => ({
    ...item,
    icon: item.icon?.startsWith('http') ? toLocalPath(item.icon, folder) : item.icon,
  }));
  await fs.writeFile(jsonFile, JSON.stringify(updated));
  console.log(`✅ Updated ${path.basename(jsonFile)} — icons now at /images/${folder}/`);
}

async function main() {
  const itemsJson = path.join(OUTPUT_DIR, 'mlbb-items.json');
  const emblemsJson = path.join(OUTPUT_DIR, 'mlbb-emblems.json');

  console.log('📦 Downloading item images...');
  const itemsOk = await downloadAll(itemsJson, ITEMS_DIR, 'items');

  console.log('\n📦 Downloading emblem images...');
  const emblemsOk = await downloadAll(emblemsJson, EMBLEMS_DIR, 'emblems');

  if (itemsOk) await updatePaths(itemsJson, 'items');
  if (emblemsOk) await updatePaths(emblemsJson, 'emblems');

  if (!itemsOk || !emblemsOk) {
    console.log('\n⚠️  Some downloads failed. Run again to retry.');
  } else {
    console.log('\n🎉 Done! Restart the API server to pick up changes.');
  }
}

main().catch(console.error);
