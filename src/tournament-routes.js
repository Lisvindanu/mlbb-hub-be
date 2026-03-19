import * as db from './tournament-db.js';
export { initTournamentTables } from './tournament-db.js';

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function getAuthedUser(req) {
  const { verifyToken } = await import('./auth-middleware.js');
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try { return verifyToken(authHeader.slice(7)); } catch { return null; }
}

export async function handleTournamentRoutes(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // GET /api/tournaments
  if (pathname === '/api/tournaments' && req.method === 'GET') {
    const list = await db.getTournaments();
    json(res, 200, list);
    return true;
  }

  // POST /api/tournaments — create (requires auth)
  if (pathname === '/api/tournaments' && req.method === 'POST') {
    const user = await getAuthedUser(req);
    if (!user) { json(res, 401, { error: 'Login diperlukan untuk membuat turnamen' }); return true; }
    try {
      const { name, description, team_count, bracket_type } = await parseBody(req);
      if (!name?.trim()) { json(res, 400, { error: 'Tournament name is required' }); return true; }
      if (![4, 8, 16, 32].includes(Number(team_count))) {
        json(res, 400, { error: 'team_count must be 4, 8, 16, or 32' }); return true;
      }
      const tournament = await db.createTournament({
        name: name.trim(),
        description,
        team_count: Number(team_count),
        bracket_type: bracket_type || 'single',
        created_by_name: user.name || user.username || 'Anonymous',
        creator_id: user.userId,
      });
      json(res, 201, tournament);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /api/user/tournaments
  if (pathname === '/api/user/tournaments' && req.method === 'GET') {
    const user = await getAuthedUser(req);
    if (!user) { json(res, 401, { error: 'Unauthorized' }); return true; }
    const data = await db.getUserTournaments(user.userId);
    json(res, 200, data);
    return true;
  }

  // GET /api/tournaments/:id
  const detailMatch = pathname.match(/^\/api\/tournaments\/(\d+)$/);
  if (detailMatch && req.method === 'GET') {
    const tournament = await db.getTournamentById(Number(detailMatch[1]));
    if (!tournament) { json(res, 404, { error: 'Not found' }); return true; }
    const { admin_code, ...safe } = tournament;
    json(res, 200, safe);
    return true;
  }

  // POST /api/tournaments/:id/join (requires auth)
  const joinMatch = pathname.match(/^\/api\/tournaments\/(\d+)\/join$/);
  if (joinMatch && req.method === 'POST') {
    const user = await getAuthedUser(req);
    if (!user) { json(res, 401, { error: 'Login diperlukan untuk mendaftar tim' }); return true; }
    try {
      const { team_name } = await parseBody(req);
      if (!team_name?.trim()) { json(res, 400, { error: 'team_name is required' }); return true; }
      const team = await db.joinTournament(Number(joinMatch[1]), team_name.trim(), user.userId);
      json(res, 201, team);
    } catch (e) {
      json(res, 400, { error: e.message });
    }
    return true;
  }

  // POST /api/tournaments/:id/start (requires auth as creator)
  const startMatch = pathname.match(/^\/api\/tournaments\/(\d+)\/start$/);
  if (startMatch && req.method === 'POST') {
    const user = await getAuthedUser(req);
    if (!user) { json(res, 401, { error: 'Login diperlukan' }); return true; }
    try {
      const result = await db.startTournament(Number(startMatch[1]), user.userId);
      json(res, 200, result);
    } catch (e) {
      json(res, 400, { error: e.message });
    }
    return true;
  }

  // PATCH /api/tournaments/:id/matches/:matchId (requires auth as creator)
  const matchWinnerMatch = pathname.match(/^\/api\/tournaments\/(\d+)\/matches\/(\d+)$/);
  if (matchWinnerMatch && req.method === 'PATCH') {
    const user = await getAuthedUser(req);
    if (!user) { json(res, 401, { error: 'Login diperlukan' }); return true; }
    try {
      const { winner_id, score1, score2 } = await parseBody(req);
      if (!winner_id) { json(res, 400, { error: 'winner_id is required' }); return true; }
      const result = await db.setMatchWinner(
        Number(matchWinnerMatch[1]),
        Number(matchWinnerMatch[2]),
        Number(winner_id),
        user.userId,
        score1,
        score2,
      );
      json(res, 200, result);
    } catch (e) {
      json(res, 400, { error: e.message });
    }
    return true;
  }

  return false;
}
