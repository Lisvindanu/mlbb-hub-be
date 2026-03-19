/**
 * Convert all jpg/png images in public/images to WebP
 * then update paths in output/merged-mlbb.json
 */
import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const IMG_DIR = path.join(ROOT, 'public', 'images');
const DATA_FILE = path.join(ROOT, 'output', 'merged-mlbb.json');

async function getAllImages(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await getAllImages(full));
    } else if (/\.(jpg|jpeg|png)$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const images = await getAllImages(IMG_DIR);
  console.log(`Found ${images.length} images to convert`);

  let converted = 0;
  let skipped = 0;
  let failed = 0;

  for (const imgPath of images) {
    const webpPath = imgPath.replace(/\.(jpg|jpeg|png)$/i, '.webp');

    // Skip if webp already exists
    try {
      await fs.access(webpPath);
      skipped++;
      continue;
    } catch {}

    try {
      await sharp(imgPath)
        .webp({ quality: 85 })
        .toFile(webpPath);
      // Remove original
      await fs.unlink(imgPath);
      converted++;
      if (converted % 100 === 0) console.log(`  Converted ${converted}/${images.length - skipped}...`);
    } catch (err) {
      console.error(`  Failed: ${path.basename(imgPath)} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\n✅ Converted: ${converted} | Skipped (already webp): ${skipped} | Failed: ${failed}`);

  // Update merged-mlbb.json paths
  console.log('\nUpdating merged-mlbb.json...');
  const raw = await fs.readFile(DATA_FILE, 'utf-8');
  const updated = raw
    .replace(/\.jpg"/g, '.webp"')
    .replace(/\.jpeg"/g, '.webp"')
    .replace(/\.png"/g, '.webp"');

  if (updated !== raw) {
    await fs.writeFile(DATA_FILE, updated);
    const count = (raw.match(/\.(jpg|jpeg|png)"/g) || []).length;
    console.log(`✅ Updated ${count} path references in merged-mlbb.json`);
  } else {
    console.log('No path updates needed in merged-mlbb.json');
  }
}

main().catch(console.error);
