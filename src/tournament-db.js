import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'mlbbhub',
  password: 'password',
  port: 5432,
});

export async function initTournamentTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT DEFAULT '',
      team_count INTEGER NOT NULL DEFAULT 8,
      bracket_type VARCHAR(20) NOT NULL DEFAULT 'single',
      status VARCHAR(20) NOT NULL DEFAULT 'registration',
      created_by_name VARCHAR(100) NOT NULL DEFAULT 'Anonymous',
      creator_id INTEGER,
      admin_code VARCHAR(10) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_teams (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      seed INTEGER,
      member_id INTEGER,
      joined_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_matches (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
      bracket VARCHAR(20) DEFAULT 'winners',
      round INTEGER NOT NULL,
      match_number INTEGER NOT NULL,
      team1_id INTEGER REFERENCES tournament_teams(id),
      team2_id INTEGER REFERENCES tournament_teams(id),
      winner_id INTEGER REFERENCES tournament_teams(id),
      score1 INTEGER DEFAULT 0,
      score2 INTEGER DEFAULT 0,
      status VARCHAR(20) DEFAULT 'pending',
      next_match_id INTEGER,
      next_match_slot INTEGER,
      loser_next_match_id INTEGER,
      loser_next_match_slot INTEGER
    )
  `);

  // Migrate existing tables
  const cols = [
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS bracket_type VARCHAR(20) NOT NULL DEFAULT 'single'`,
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS creator_id INTEGER`,
    `ALTER TABLE tournament_teams ADD COLUMN IF NOT EXISTS member_id INTEGER`,
    `ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS bracket VARCHAR(20) DEFAULT 'winners'`,
    `ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS loser_next_match_id INTEGER`,
    `ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS loser_next_match_slot INTEGER`,
  ];
  for (const q of cols) {
    try { await pool.query(q); } catch {}
  }

  console.log('Tournament tables initialized');
}

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Standard seeding: 1 vs N, 2 vs N-1, etc.
function buildBracketPositions(size) {
  if (size === 2) return [1, 2];
  const half = buildBracketPositions(size / 2);
  const result = [];
  for (const seed of half) {
    result.push(seed, size + 1 - seed);
  }
  return result;
}

// ─── Single elimination bracket ───────────────────────────────────────────────
async function buildSingleElimBracket(tournamentId, teams) {
  const n = teams.length;
  const bracketSize = Math.pow(2, Math.ceil(Math.log2(Math.max(n, 2))));
  const k = Math.log2(bracketSize);
  const positions = buildBracketPositions(bracketSize);
  const seeded = positions.map(p => (p <= n ? teams[p - 1] : null));

  // Create all match rows
  const matchIds = {}; // matchIds[round][matchIdx 0-based] = id
  for (let r = 1; r <= k; r++) {
    matchIds[r] = {};
    const count = bracketSize >> r;
    for (let m = 0; m < count; m++) {
      let team1 = null, team2 = null;
      if (r === 1) {
        team1 = seeded[m * 2]?.id ?? null;
        team2 = seeded[m * 2 + 1]?.id ?? null;
      }
      const isBye = team1 && !team2;
      const res = await pool.query(
        `INSERT INTO tournament_matches (tournament_id, bracket, round, match_number, team1_id, team2_id, status)
         VALUES ($1, 'winners', $2, $3, $4, $5, $6) RETURNING id`,
        [tournamentId, r, m, team1, team2, isBye ? 'bye' : 'pending']
      );
      matchIds[r][m] = res.rows[0].id;
    }
  }

  // Link winner advancement
  for (let r = 1; r < k; r++) {
    const count = bracketSize >> r;
    for (let m = 0; m < count; m++) {
      const nextM = Math.floor(m / 2);
      const slot = (m % 2) + 1;
      await pool.query(
        `UPDATE tournament_matches SET next_match_id=$1, next_match_slot=$2 WHERE id=$3`,
        [matchIds[r + 1][nextM], slot, matchIds[r][m]]
      );
    }
  }

  // Auto-advance byes
  for (let r = 1; r <= k; r++) {
    const count = bracketSize >> r;
    for (let m = 0; m < count; m++) {
      const id = matchIds[r][m];
      const res = await pool.query(`SELECT * FROM tournament_matches WHERE id=$1`, [id]);
      const match = res.rows[0];
      if (match.status === 'bye') {
        const winnerId = match.team1_id || match.team2_id;
        await pool.query(`UPDATE tournament_matches SET winner_id=$1 WHERE id=$2`, [winnerId, id]);
        if (match.next_match_id) {
          const col = match.next_match_slot === 1 ? 'team1_id' : 'team2_id';
          await pool.query(`UPDATE tournament_matches SET ${col}=$1 WHERE id=$2`, [winnerId, match.next_match_id]);
        }
      }
    }
  }
}

// ─── Double elimination bracket ────────────────────────────────────────────────
async function buildDoubleElimBracket(tournamentId, teams) {
  const n = teams.length;
  const bracketSize = Math.pow(2, Math.ceil(Math.log2(Math.max(n, 2))));
  const k = Math.log2(bracketSize);
  const positions = buildBracketPositions(bracketSize);
  const seeded = positions.map(p => (p <= n ? teams[p - 1] : null));

  const ids = {}; // key -> db id

  // ── Winners bracket ──
  for (let r = 1; r <= k; r++) {
    const count = bracketSize >> r;
    for (let m = 0; m < count; m++) {
      const key = `W-${r}-${m}`;
      let team1 = null, team2 = null;
      if (r === 1) {
        team1 = seeded[m * 2]?.id ?? null;
        team2 = seeded[m * 2 + 1]?.id ?? null;
      }
      const isBye = team1 && !team2;
      const bracket = r === k ? 'winners_final' : 'winners';
      const res = await pool.query(
        `INSERT INTO tournament_matches (tournament_id, bracket, round, match_number, team1_id, team2_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [tournamentId, bracket, r, m, team1, team2, isBye ? 'bye' : 'pending']
      );
      ids[key] = res.rows[0].id;
    }
  }

  // ── Losers bracket: 2*(k-1) rounds ──
  const lRounds = 2 * (k - 1);
  for (let lr = 1; lr <= lRounds; lr++) {
    const count = bracketSize >> (Math.floor((lr + 1) / 2) + 1);
    for (let m = 0; m < count; m++) {
      const key = `L-${lr}-${m}`;
      const bracket = lr === lRounds ? 'losers_final' : 'losers';
      const res = await pool.query(
        `INSERT INTO tournament_matches (tournament_id, bracket, round, match_number, status)
         VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
        [tournamentId, bracket, k + lr, m]
      );
      ids[key] = res.rows[0].id;
    }
  }

  // ── Grand Final ──
  const gfRes = await pool.query(
    `INSERT INTO tournament_matches (tournament_id, bracket, round, match_number, status)
     VALUES ($1,'grand_final',$2,0,'pending') RETURNING id`,
    [tournamentId, k + lRounds + 1]
  );
  ids['GF'] = gfRes.rows[0].id;

  // ── Link winners bracket ──
  for (let r = 1; r < k; r++) {
    const count = bracketSize >> r;
    for (let m = 0; m < count; m++) {
      await pool.query(
        `UPDATE tournament_matches SET next_match_id=$1, next_match_slot=$2 WHERE id=$3`,
        [ids[`W-${r + 1}-${Math.floor(m / 2)}`], (m % 2) + 1, ids[`W-${r}-${m}`]]
      );
    }
  }
  // Winners final → GF slot 1
  await pool.query(
    `UPDATE tournament_matches SET next_match_id=$1, next_match_slot=1 WHERE id=$2`,
    [ids['GF'], ids[`W-${k}-0`]]
  );

  // ── Link losers bracket winner advancement ──
  for (let lr = 1; lr < lRounds; lr++) {
    const count = bracketSize >> (Math.floor((lr + 1) / 2) + 1);
    if (lr % 2 === 1) {
      // Odd: each winner goes to same-index slot 1 in next round
      for (let m = 0; m < count; m++) {
        await pool.query(
          `UPDATE tournament_matches SET next_match_id=$1, next_match_slot=1 WHERE id=$2`,
          [ids[`L-${lr + 1}-${m}`], ids[`L-${lr}-${m}`]]
        );
      }
    } else {
      // Even: pairs consolidate
      for (let m = 0; m < count; m++) {
        await pool.query(
          `UPDATE tournament_matches SET next_match_id=$1, next_match_slot=$2 WHERE id=$3`,
          [ids[`L-${lr + 1}-${Math.floor(m / 2)}`], (m % 2) + 1, ids[`L-${lr}-${m}`]]
        );
      }
    }
  }
  // Losers final → GF slot 2
  await pool.query(
    `UPDATE tournament_matches SET next_match_id=$1, next_match_slot=2 WHERE id=$2`,
    [ids['GF'], ids[`L-${lRounds}-0`]]
  );

  // ── Link winners bracket losers → losers bracket ──
  // W-R1 losers → L-R1
  const wr1Count = bracketSize >> 1;
  for (let m = 0; m < wr1Count; m++) {
    await pool.query(
      `UPDATE tournament_matches SET loser_next_match_id=$1, loser_next_match_slot=$2 WHERE id=$3`,
      [ids[`L-1-${Math.floor(m / 2)}`], (m % 2) + 1, ids[`W-1-${m}`]]
    );
  }
  // W-R2..W-R(k-1) losers → corresponding even losers rounds
  for (let wr = 2; wr < k; wr++) {
    const count = bracketSize >> wr;
    const lr = (wr - 1) * 2;
    for (let m = 0; m < count; m++) {
      const lKey = `L-${lr}-${m}`;
      if (ids[lKey]) {
        await pool.query(
          `UPDATE tournament_matches SET loser_next_match_id=$1, loser_next_match_slot=2 WHERE id=$2`,
          [ids[lKey], ids[`W-${wr}-${m}`]]
        );
      }
    }
  }
  // Winners final loser → Losers final slot 2
  await pool.query(
    `UPDATE tournament_matches SET loser_next_match_id=$1, loser_next_match_slot=2 WHERE id=$2`,
    [ids[`L-${lRounds}-0`], ids[`W-${k}-0`]]
  );

  // ── Auto-advance byes in winners bracket ──
  for (let r = 1; r <= k; r++) {
    const count = bracketSize >> r;
    for (let m = 0; m < count; m++) {
      const id = ids[`W-${r}-${m}`];
      const res = await pool.query(`SELECT * FROM tournament_matches WHERE id=$1`, [id]);
      const match = res.rows[0];
      if (match.status === 'bye') {
        const winnerId = match.team1_id || match.team2_id;
        await pool.query(`UPDATE tournament_matches SET winner_id=$1 WHERE id=$2`, [winnerId, id]);
        if (match.next_match_id) {
          const col = match.next_match_slot === 1 ? 'team1_id' : 'team2_id';
          await pool.query(`UPDATE tournament_matches SET ${col}=$1 WHERE id=$2`, [winnerId, match.next_match_id]);
        }
        // Bye loser goes to losers bracket if applicable
        // (not possible in round 1 since byes don't have a real opponent)
      }
    }
  }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function createTournament({ name, description, team_count, bracket_type = 'single', created_by_name, creator_id }) {
  const admin_code = generateCode();
  const result = await pool.query(
    `INSERT INTO tournaments (name, description, team_count, bracket_type, created_by_name, creator_id, admin_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [name, description || '', team_count, bracket_type, created_by_name || 'Anonymous', creator_id || null, admin_code]
  );
  return result.rows[0];
}

export async function getTournaments() {
  const result = await pool.query(`
    SELECT t.id, t.name, t.description, t.team_count, t.bracket_type, t.status,
           t.created_by_name, t.created_at,
           COUNT(tt.id)::int AS joined_teams
    FROM tournaments t
    LEFT JOIN tournament_teams tt ON tt.tournament_id = t.id
    GROUP BY t.id
    ORDER BY t.created_at DESC
    LIMIT 50
  `);
  return result.rows;
}

export async function getTournamentById(id) {
  const t = await pool.query('SELECT * FROM tournaments WHERE id = $1', [id]);
  if (!t.rows[0]) return null;
  const teams = await pool.query(
    'SELECT * FROM tournament_teams WHERE tournament_id = $1 ORDER BY seed NULLS LAST, joined_at',
    [id]
  );
  const matches = await pool.query(
    'SELECT * FROM tournament_matches WHERE tournament_id = $1 ORDER BY round, match_number',
    [id]
  );
  return { ...t.rows[0], teams: teams.rows, matches: matches.rows };
}

export async function joinTournament(tournament_id, team_name, member_id) {
  const t = await pool.query('SELECT * FROM tournaments WHERE id = $1', [tournament_id]);
  if (!t.rows[0]) throw new Error('Tournament not found');
  if (t.rows[0].status !== 'registration') throw new Error('Tournament is not accepting registrations');

  const count = await pool.query('SELECT COUNT(*) FROM tournament_teams WHERE tournament_id = $1', [tournament_id]);
  if (parseInt(count.rows[0].count) >= t.rows[0].team_count) throw new Error('Tournament is full');

  const dup = await pool.query(
    'SELECT id FROM tournament_teams WHERE tournament_id = $1 AND LOWER(name) = LOWER($2)',
    [tournament_id, team_name]
  );
  if (dup.rows[0]) throw new Error('Team name already taken');

  const result = await pool.query(
    'INSERT INTO tournament_teams (tournament_id, name, member_id) VALUES ($1, $2, $3) RETURNING *',
    [tournament_id, team_name, member_id || null]
  );
  return result.rows[0];
}

export async function startTournament(tournament_id, userId) {
  const t = await pool.query('SELECT * FROM tournaments WHERE id = $1', [tournament_id]);
  if (!t.rows[0]) throw new Error('Tournament not found');
  if (t.rows[0].creator_id !== userId) throw new Error('Hanya pembuat turnamen yang bisa memulai');
  if (t.rows[0].status !== 'registration') throw new Error('Tournament already started');

  const teamsRes = await pool.query(
    'SELECT * FROM tournament_teams WHERE tournament_id = $1 ORDER BY joined_at',
    [tournament_id]
  );
  const teamList = teamsRes.rows;
  if (teamList.length < 2) throw new Error('Need at least 2 teams to start');

  // Shuffle and assign seeds
  const shuffled = [...teamList].sort(() => Math.random() - 0.5);
  for (let i = 0; i < shuffled.length; i++) {
    await pool.query('UPDATE tournament_teams SET seed = $1 WHERE id = $2', [i + 1, shuffled[i].id]);
    shuffled[i].seed = i + 1;
  }

  const bracketType = t.rows[0].bracket_type || 'single';
  if (bracketType === 'double') {
    await buildDoubleElimBracket(tournament_id, shuffled);
  } else {
    await buildSingleElimBracket(tournament_id, shuffled);
  }

  await pool.query(`UPDATE tournaments SET status = 'ongoing' WHERE id = $1`, [tournament_id]);
  return getTournamentById(tournament_id);
}

export async function setMatchWinner(tournament_id, match_id, winner_id, userId, score1, score2) {
  const t = await pool.query('SELECT * FROM tournaments WHERE id = $1', [tournament_id]);
  if (!t.rows[0]) throw new Error('Tournament not found');
  if (t.rows[0].creator_id !== userId) throw new Error('Hanya pembuat turnamen yang bisa update hasil');

  const matchRes = await pool.query(
    'SELECT * FROM tournament_matches WHERE id = $1 AND tournament_id = $2',
    [match_id, tournament_id]
  );
  if (!matchRes.rows[0]) throw new Error('Match not found');
  const m = matchRes.rows[0];
  if (winner_id !== m.team1_id && winner_id !== m.team2_id) throw new Error('Winner must be one of the teams');

  const loserId = winner_id === m.team1_id ? m.team2_id : m.team1_id;

  await pool.query(
    `UPDATE tournament_matches SET winner_id=$1, score1=$2, score2=$3, status='completed' WHERE id=$4`,
    [winner_id, score1 ?? 0, score2 ?? 0, match_id]
  );

  // Advance winner
  if (m.next_match_id) {
    const col = m.next_match_slot === 1 ? 'team1_id' : 'team2_id';
    await pool.query(`UPDATE tournament_matches SET ${col}=$1 WHERE id=$2`, [winner_id, m.next_match_id]);
  }

  // Advance loser to losers bracket (double elimination)
  if (m.loser_next_match_id && loserId) {
    const col = m.loser_next_match_slot === 1 ? 'team1_id' : 'team2_id';
    await pool.query(`UPDATE tournament_matches SET ${col}=$1 WHERE id=$2`, [loserId, m.loser_next_match_id]);
  }

  // Check if this is the final match
  const isLastMatch = !m.next_match_id && !m.loser_next_match_id;
  if (isLastMatch) {
    await pool.query(`UPDATE tournaments SET status='completed' WHERE id=$1`, [tournament_id]);
  }

  return getTournamentById(tournament_id);
}

export async function getUserTournaments(userId) {
  const created = await pool.query(`
    SELECT t.id, t.name, t.description, t.team_count, t.bracket_type, t.status,
           t.created_by_name, t.created_at,
           COUNT(tt.id)::int AS joined_teams
    FROM tournaments t
    LEFT JOIN tournament_teams tt ON tt.tournament_id = t.id
    WHERE t.creator_id = $1
    GROUP BY t.id ORDER BY t.created_at DESC
  `, [userId]);

  const joined = await pool.query(`
    SELECT DISTINCT t.id, t.name, t.description, t.team_count, t.bracket_type, t.status,
           t.created_by_name, t.created_at,
           (SELECT COUNT(*) FROM tournament_teams WHERE tournament_id=t.id)::int AS joined_teams,
           tt.name AS my_team_name
    FROM tournaments t
    JOIN tournament_teams tt ON tt.tournament_id = t.id AND tt.member_id = $1
    WHERE (t.creator_id IS NULL OR t.creator_id != $1)
    ORDER BY t.created_at DESC
  `, [userId]);

  return { created: created.rows, joined: joined.rows };
}
