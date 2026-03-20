import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import emailService from './email-service.js';
import { handleCommunityRoutes } from "./community-routes.js";
import { handlePostsRoutes } from "./posts-routes.js";
import { handleTournamentRoutes, initTournamentTables } from "./tournament-routes.js";

const execPromise = promisify(exec);
const PORT = process.env.PORT || 8090;

// Simple auth token (in production, use proper auth)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-secret-token-2024';

// ── In-memory cache for large static JSON files ──────────────────────────────
// Files are read once from disk then served from memory on every subsequent request.
const FILE_CACHE = new Map();
let ADJ_FULL_PARSED = null; // Parsed object cache for season-lookup queries

async function readFileCached(filePath) {
  if (!FILE_CACHE.has(filePath)) {
    FILE_CACHE.set(filePath, await fs.readFile(filePath, 'utf-8'));
  }
  return FILE_CACHE.get(filePath);
}

async function getAdjFullParsed() {
  if (!ADJ_FULL_PARSED) {
    const raw = await readFileCached(path.join(process.cwd(), 'output', 'adjustments-full.json'));
    ADJ_FULL_PARSED = JSON.parse(raw);
  }
  return ADJ_FULL_PARSED;
}

// Preload heavy files at startup so first request is instant
(async () => {
  try {
    await readFileCached(path.join(process.cwd(), 'output', 'merged-mlbb.json'));
    await readFileCached(path.join(process.cwd(), 'output', 'mlbb-items.json'));
    await readFileCached(path.join(process.cwd(), 'output', 'mlbb-emblems.json'));
    await readFileCached(path.join(process.cwd(), 'output', 'mlbb-builds.json'));
    await readFileCached(path.join(process.cwd(), 'output', 'mlbb-patches.json'));
    console.log('✅ File cache warm (merged-mlbb + mlbb-items + mlbb-emblems + mlbb-builds + mlbb-patches)');
  } catch (e) {
    console.warn('⚠️  Could not preload cache:', e.message);
  }
})();

// Prevent unhandled DB / async errors from crashing the process
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});

async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  res.setHeader('Content-Type', 'application/json');

  // Serve static images and uploads
  if (req.url.startsWith("/images/") || req.url.startsWith("/uploads/")) {
    const imagePath = path.join(process.cwd(), "public", decodeURIComponent(req.url));
    try {
      const stat = await fs.stat(imagePath);
      if (stat.isFile()) {
        const ext = path.extname(imagePath).toLowerCase();
        const mimeTypes = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml" };
        const contentType = mimeTypes[ext] || "application/octet-stream";
        const data = await fs.readFile(imagePath);
        res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "public, max-age=31536000, immutable" });
        res.end(data);
        return;
      }
    } catch (err) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Image not found" }));
      return;
    }
  }

  // Main API endpoints — hero data
  if (req.url === '/api/mlbb' || req.url === '/api/hok' || req.url === '/' || req.url === '/api') {
    try {
      const filePath = path.join(process.cwd(), 'output', 'merged-mlbb.json');
      const data = await readFileCached(filePath);
      res.writeHead(200, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600' });
      res.end(data);
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Data belum siap. Jalankan transform-mlbb.mjs terlebih dahulu.' }));
    }
  }

  // Image proxy — bypass Liquipedia hotlink block
  // GET /api/proxy-image?url=https://liquipedia.net/commons/images/...
  else if (req.url.startsWith("/api/proxy-image")) {
    const params = new URL(req.url, "http://localhost").searchParams;
    const imgUrl = params.get("url");
    if (!imgUrl || !imgUrl.startsWith("https://liquipedia.net/")) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid URL" }));
      return;
    }
    try {
      const upstream = await fetch(imgUrl, {
        headers: { "User-Agent": "Mozilla/5.0 mlbb-hub/1.0 (educational project)" },
      });
      if (!upstream.ok) {
        res.writeHead(upstream.status);
        res.end();
        return;
      }
      const contentType = upstream.headers.get("content-type") || "image/jpeg";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=604800",
        "Access-Control-Allow-Origin": "*",
      });
      const buf = await upstream.arrayBuffer();
      res.end(Buffer.from(buf));
    } catch (e) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Patch notes — /api/patches?version=2.1.61 or /api/patches?hero=Layla
  else if (req.url.startsWith("/api/patches") && req.method === "GET") {
    try {
      const filePath = path.join(process.cwd(), 'output', 'mlbb-patches.json');
      const raw = await readFileCached(filePath);
      const patches = JSON.parse(raw);
      const params = new URL(req.url, "http://localhost").searchParams;
      const version = params.get("version");
      const hero = params.get("hero");

      if (version) {
        const patch = patches.find(p => p.version === version);
        res.writeHead(200, { 'Cache-Control': 'public, max-age=3600' });
        res.end(JSON.stringify(patch || null));
      } else if (hero) {
        // Get all patches that affected this hero
        const result = patches
          .filter(p => p.heroes.some(h => h.hero.toLowerCase() === hero.toLowerCase()))
          .map(p => ({
            version: p.version,
            releaseDate: p.releaseDate,
            changes: p.heroes.filter(h => h.hero.toLowerCase() === hero.toLowerCase()),
          }));
        res.writeHead(200, { 'Cache-Control': 'public, max-age=3600' });
        res.end(JSON.stringify(result));
      } else {
        // Return all patches (summary — no hero details to keep payload small)
        const summary = patches.map(p => ({
          version: p.version,
          releaseDate: p.releaseDate,
          heroCount: p.heroes.length,
          heroes: p.heroes,
        }));
        res.writeHead(200, { 'Cache-Control': 'public, max-age=300' });
        res.end(JSON.stringify(summary));
      }
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Patch data tidak tersedia' }));
    }
  }

  // Hero icons + skill icons map — for patch notes UI
  else if (req.url === "/api/hero-icons" && req.method === "GET") {
    try {
      const raw = await readFileCached(path.join(process.cwd(), 'output', 'merged-mlbb.json'));
      const data = JSON.parse(raw);
      const heroMap = {};
      for (const [name, hero] of Object.entries(data.main || {})) {
        heroMap[name] = {
          icon: hero.icon || null,
          skills: (hero.skill || []).map(s => ({ skillName: s.skillName, skillImg: s.skillImg })),
        };
      }
      res.writeHead(200, { 'Cache-Control': 'public, max-age=3600' });
      res.end(JSON.stringify(heroMap));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Hero icons tidak tersedia' }));
    }
  }

  // Legacy adjustments — keep for compat
  else if (req.url.startsWith("/api/adjustments") && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ scrapedAt: null, season: null, adjustments: [], allSeasons: {} }));
  }

  // Items API endpoint
  else if (req.url === "/api/items" && req.method === "GET") {
    try {
      const filePath = path.join(process.cwd(), "output", "mlbb-items.json");
      const data = await readFileCached(filePath);
      res.writeHead(200, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600' });
      res.end(data);
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Data item tidak tersedia" }));
    }
  }

  // Emblem API endpoint (masih /api/arcana agar FE tidak perlu diubah)
  else if (req.url === "/api/arcana" && req.method === "GET") {
    try {
      const filePath = path.join(process.cwd(), "output", "mlbb-emblems.json");
      const data = await readFileCached(filePath);
      res.writeHead(200, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600' });
      res.end(data);
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Data emblem tidak tersedia" }));
    }
  }

  // Talents API endpoint
  else if (req.url === "/api/talents" && req.method === "GET") {
    try {
      const filePath = path.join(process.cwd(), "output", "mlbb-talents.json");
      const data = await readFileCached(filePath);
      res.writeHead(200, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600' });
      res.end(data);
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Data talent tidak tersedia" }));
    }
  }

  // Hero Guides endpoint — /api/hero-guides (all) or /api/hero-guides?hero=Miya
  else if (req.url.startsWith("/api/hero-guides") && req.method === "GET") {
    try {
      const filePath = path.join(process.cwd(), "output", "mlbb-hero-guides.json");
      const raw = await readFileCached(filePath);
      const heroName = new URL(req.url, "http://localhost").searchParams.get("hero");
      if (heroName) {
        const parsed = JSON.parse(raw);
        const guide = parsed[heroName];
        if (!guide) { res.writeHead(404); res.end(JSON.stringify({ error: 'Hero not found' })); return; }
        res.writeHead(200, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600' });
        res.end(JSON.stringify(guide));
      } else {
        res.writeHead(200, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600' });
        res.end(raw);
      }
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Data panduan hero tidak tersedia" }));
    }
  }

  // Builds endpoint — /api/builds (all) or /api/builds?hero=Miya
  else if (req.url.startsWith("/api/builds") && req.method === "GET") {
    try {
      const filePath = path.join(process.cwd(), "output", "mlbb-builds.json");
      const raw = await readFileCached(filePath);
      const parsed = JSON.parse(raw);
      const heroName = new URL(req.url, "http://localhost").searchParams.get("hero");
      if (heroName) {
        const builds = parsed[heroName] || [];
        res.writeHead(200, { 'Cache-Control': 'public, max-age=300' });
        res.end(JSON.stringify(builds));
      } else {
        res.writeHead(200, { 'Cache-Control': 'public, max-age=300' });
        res.end(raw);
      }
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Data builds tidak tersedia" }));
    }
  }

  // Meta ranks endpoint
  else if (req.url === "/api/meta-ranks" && req.method === "GET") {
    try {
      const filePath = path.join(process.cwd(), "output", "mlbb-meta-ranks.json");
      const data = await readFileCached(filePath);
      res.writeHead(200, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600' });
      res.end(data);
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Data meta ranks tidak tersedia" }));
    }
  }

  // Image proxy endpoint for CORS bypass
  else if (req.url.startsWith("/proxy-image/") && req.method === "GET") {
    const imagePath = req.url.replace("/proxy-image/", "");
    const imageUrl = "https://cdn.mobilelegends.com/" + imagePath;
    
    try {
      const https = await import("https");
      
      https.default.get(imageUrl, (imgRes) => {
        const contentType = imgRes.headers["content-type"] || "image/jpeg";
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=31536000");
        res.writeHead(imgRes.statusCode);
        imgRes.pipe(res);
      }).on("error", (err) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Failed to fetch image" }));
      });
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Image proxy error" }));
    }
  }

  // Submit contribution
  else if (req.url === '/api/contribute' && req.method === 'POST') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const contribution = JSON.parse(body);

        // Validate
        if (!contribution.type || !contribution.data) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing required fields: type and data' }));
          return;
        }

        if (!['skin', 'hero', 'series', 'counter', 'skin-edit'].includes(contribution.type)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid type. Must be: skin, hero, series, counter, or skin-edit' }));
          return;
        }

        // Check for authenticated user
        let contributorId = null;
        let contributorName = contribution.contributorName || 'Anonymous';
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          try {
            const { verifyToken } = await import('./auth-middleware.js');
            const token = authHeader.split(' ')[1];
            const decoded = verifyToken(token);
            if (decoded && decoded.userId) {
              contributorId = decoded.userId;
              contributorName = decoded.name || contributorName;
            }
          } catch (e) {
            // Token verification failed, continue as anonymous
          }
        }

        // Save to pending files
        const contributionsDir = path.join(process.cwd(), 'contributions', 'pending');
        await fs.mkdir(contributionsDir, { recursive: true });

        const timestamp = Date.now();
        const id = `${contribution.type}-${timestamp}`;
        const filename = `${id}.json`;
        const filepath = path.join(contributionsDir, filename);

        const contributionData = {
          ...contribution,
          contributorId,
          contributorName,
          submittedAt: new Date().toISOString(),
          status: 'pending',
          id
        };

        await fs.writeFile(filepath, JSON.stringify(contributionData, null, 2));

        // Also save to database if user is authenticated
        if (contributorId) {
          const communityDb = await import('./community-db.js');
          await communityDb.createContribution({
            contributorId,
            type: contribution.type,
            data: contribution.data,
            status: 'pending'
          });
          // Increment contribution count for the user
          await communityDb.incrementContributorContributions(contributorId);
        }

        console.log(`✅ New contribution: ${filename}` + (contributorId ? ` (by user ${contributorId})` : ' (anonymous)'));

        // Send notification
        await emailService.notifyContributionReceived(contributionData).catch(err =>
          console.error('Email notification failed:', err)
        );

        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          message: 'Contribution submitted successfully',
          id
        }));

      } catch (error) {
        console.error('Error processing contribution:', error);
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON or processing error' }));
      }
    });
  }

  // List pending contributions
  else if (req.url === '/api/contributions/pending' && req.method === 'GET') {
    try {
      const contributionsDir = path.join(process.cwd(), 'contributions', 'pending');
      await fs.mkdir(contributionsDir, { recursive: true });

      const files = await fs.readdir(contributionsDir);
      const contributions = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const content = await fs.readFile(path.join(contributionsDir, file), 'utf-8');
            contributions.push(JSON.parse(content));
          } catch (parseErr) {
            console.error('Skipping corrupt pending file:', file, parseErr.message);
          }
        }
      }

      res.writeHead(200);
      res.end(JSON.stringify({
        count: contributions.length,
        contributions: contributions.sort((a, b) =>
          new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
        )
      }));
    } catch (error) {
      console.error('Error listing contributions:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to list contributions' }));
    }
  }

  // Approve contribution
  else if (req.url.startsWith('/api/contributions/approve/') && req.method === 'POST') {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${ADMIN_TOKEN}`) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const contributionId = req.url.split('/').pop();

    try {
      // Run merge script
      const { stdout, stderr } = await execPromise(
        `node src/merge-contribution.js ${contributionId} approve`
      );

      console.log(stdout);
      FILE_CACHE.delete(path.join(process.cwd(), 'output', 'merged-mlbb.json'));

      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        message: 'Contribution approved and merged',
        contributionId
      }));
    } catch (error) {
      console.error('Merge error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to merge contribution', details: error.message }));
    }
  }


  // Bulk approve contributions (sequential — safe for merged-api.json writes)
  else if (req.url === '/api/contributions/approve-bulk' && req.method === 'POST') {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${ADMIN_TOKEN}`) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    try {
      const body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk.toString());
        req.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        req.on('error', reject);
      });

      const { ids } = body;
      if (!Array.isArray(ids) || ids.length === 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'ids array is required' }));
        return;
      }

      const results = [];
      // Sequential processing — MUST NOT use Promise.all (race condition on merged-api.json)
      for (const id of ids) {
        try {
          const { stdout } = await execPromise(
            `node src/merge-contribution.js ${id} approve`,
            { cwd: process.cwd() }
          );
          console.log(`Approved ${id}:`, stdout.trim());
          FILE_CACHE.delete(path.join(process.cwd(), 'output', 'merged-mlbb.json'));
          results.push({ id, success: true, action: 'approved' });
        } catch (err) {
          console.error(`Failed to approve ${id}:`, err.message);
          results.push({ id, success: false, error: err.message });
        }
      }

      const approved = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      res.writeHead(200);
      res.end(JSON.stringify({ results, summary: { approved, failed, total: ids.length } }));
    } catch (error) {
      console.error('Bulk approve error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Bulk approve failed', details: error.message }));
    }
  }

  // Bulk reject contributions
  else if (req.url === '/api/contributions/reject-bulk' && req.method === 'POST') {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${ADMIN_TOKEN}`) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    try {
      const body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk.toString());
        req.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        req.on('error', reject);
      });

      const { ids } = body;
      if (!Array.isArray(ids) || ids.length === 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'ids array is required' }));
        return;
      }

      const results = [];
      for (const id of ids) {
        try {
          const { stdout } = await execPromise(
            `node src/merge-contribution.js ${id} reject`,
            { cwd: process.cwd() }
          );
          results.push({ id, success: true, action: 'rejected' });
        } catch (err) {
          results.push({ id, success: false, error: err.message });
        }
      }

      const rejected = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      res.writeHead(200);
      res.end(JSON.stringify({ results, summary: { rejected, failed, total: ids.length } }));
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Bulk reject failed', details: error.message }));
    }
  }
  // Reject contribution
  else if (req.url.startsWith('/api/contributions/reject/') && req.method === 'POST') {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${ADMIN_TOKEN}`) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const contributionId = req.url.split('/').pop();

    try {
      // Run merge script with reject action
      const { stdout, stderr } = await execPromise(
        `node src/merge-contribution.js ${contributionId} reject`
      );

      console.log(stdout);

      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        message: 'Contribution rejected',
        contributionId
      }));
    } catch (error) {
      console.error('Reject error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to reject contribution', details: error.message }));
    }
  }

  // Get contribution history
  else if (req.url === '/api/contributions/history' && req.method === 'GET') {
    try {
      const historyFile = path.join(process.cwd(), 'contributions', 'history', 'history.json');

      try {
        const history = await fs.readFile(historyFile, 'utf-8');
        res.writeHead(200);
        res.end(history);
      } catch (error) {
        // No history yet
        res.writeHead(200);
        res.end(JSON.stringify([]));
      }
    } catch (error) {
      console.error('Error reading history:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to read history' }));
    }
  }

  // Login endpoint (simple token-based)
  else if (req.url === '/api/admin/login' && req.method === 'POST') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const { password } = JSON.parse(body);

        // Simple check (in production, use proper auth)
        if (password === 'mlbbhub2026') {
          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            token: ADMIN_TOKEN
          }));
        } else {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'Invalid password' }));
        }
      } catch (error) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
  }

  // Health check
  else if (req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  }

  // Try posts routes
  else if (await handlePostsRoutes(req, res)) {
    return;
  }

  // Try community routes
  else if (await handleCommunityRoutes(req, res)) {
    return;
  }

  // Try tournament routes
  else if (await handleTournamentRoutes(req, res)) {
    return;
  }

  // Not found
  else {
    res.writeHead(404);
    res.end(JSON.stringify({
      error: 'Not found',
      endpoints: [        'GET / - Main API',        'GET /api/hok - Main API',        'POST /api/contribute - Submit contribution',        'GET /api/contributions/pending - List pending',        'POST /api/contributions/approve/:id - Approve (requires auth)',        'POST /api/contributions/reject/:id - Reject (requires auth)',        'GET /api/contributions/history - View history',        'POST /api/admin/login - Admin login',        'POST /api/auth/register - Register contributor',        'POST /api/auth/login - Login contributor',        'GET /api/tier-lists - Get tier lists',        'POST /api/tier-lists - Create tier list',        'POST /api/tier-lists/:id/vote - Vote tier list',        'GET /api/contributors - Get contributors leaderboard',        'GET /health - Health check'      ]
    }));
  }
}

const server = http.createServer(handler);

initTournamentTables().catch(e => console.error('Tournament table init error:', e));

server.listen(PORT, () => {
  console.log('🚀 MLBB Hub API running on port ' + PORT);
  console.log('📡 Endpoints:');
  console.log('   - GET  /api/mlbb - Hero data');
  console.log('   - GET  /api/items - Item data');
  console.log('   - GET  /api/arcana - Emblem data');
  console.log('   - POST /api/contribute - Submit kontribusi');
  console.log('   - GET  /api/contributions/pending - List pending');
  console.log('   - POST /api/contributions/approve/:id - Approve');
  console.log('   - POST /api/contributions/reject/:id - Reject');
  console.log('   - GET  /api/contributions/history - Riwayat');
  console.log('   - POST /api/admin/login - Admin login');
  console.log('   - GET  /health - Health check');
  console.log('\n🔐 Admin password: mlbbhub2026');
  console.log('🔑 Admin token: ' + ADMIN_TOKEN);
});
