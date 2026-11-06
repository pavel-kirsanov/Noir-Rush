// Noir Rush leaderboard: Cloudflare Worker + D1.
//
//   POST /run/start   {player}                         -> {run}
//   POST /score       {run, player, name, score, level, dist, hats}
//                                                      -> {best, rank, total, improved}
//   GET  /top?player=ID                                -> {top:[...], me:{rank, score, ...}|null, total}
//
// The game runs in the browser, so a determined player can still forge a run.
// The checks below only make that tedious: a run ticket from the server clock,
// one submission per ticket, and limits derived from the game's own rules.

const MAX_LEVEL = 15;
const LEVEL_LEN = n => 350 + 50 * (n - 1);           // same as LV(n).len in index.html
const LEVEL_START = n => {                            // distance at which level n begins
  let s = 0; for (let i = 1; i < n; i++) s += LEVEL_LEN(i); return s;
};
const MAX_DIST = LEVEL_START(MAX_LEVEL + 1) + 200;    // the run ends after level 15
const MAX_SPEED = 120;                                // m/s, above any boost combination
const RUN_TTL = 6 * 3600 * 1000;                      // a ticket is valid for 6 hours
const TOP_N = 20;

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

function cors(env, req) {
  const allowed = env.ALLOWED_ORIGIN || '*';
  const origin = req.headers.get('Origin') || '';
  const allow = allowed === '*' ? '*' : allowed.split(',').map(s => s.trim()).includes(origin) ? origin : 'null';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status: status || 200, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });

function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').replace(/[\p{C}<>]/gu, '').replace(/\s+/g, ' ').trim();
  const len = [...name].length;
  return len >= 2 && len <= 16 ? name : null;
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// Why a claimed run is impossible, or null if it looks plausible.
function implausible({ score, level, dist, hats }, elapsedMs) {
  if (!isInt(level, 1, MAX_LEVEL)) return 'level';
  if (!isInt(dist, 0, MAX_DIST)) return 'dist';
  if (!isInt(hats, 0, dist + 100)) return 'hats';
  if (!isInt(score, 1, 1e7)) return 'score';
  if (dist + 5 < LEVEL_START(level)) return 'level/dist';
  if (dist > MAX_SPEED * elapsedMs / 1000 + 20) return 'speed';
  // distance (x2 with the double boost), smashed obstacles (<= 2 per 9 m, 20 each),
  // first aid (300 per boost, every >= 190 m), hats (50 each), level bonuses (100 per level)
  const cap = dist * (2 + 4.5 + 1.6) + hats * 50 + 100 * (level * (level + 1) / 2) + 500;
  if (score > cap) return 'score/cap';
  return null;
}

async function rankOf(db, score, updated) {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM scores WHERE score > ?1 OR (score = ?1 AND updated < ?2)')
    .bind(score, updated).first();
  return r.n + 1;
}

async function startRun(req, env, h) {
  const body = await req.json().catch(() => null);
  if (!body || !ID_RE.test(body.player || '')) return json({ error: 'bad player' }, 400, h);
  const id = crypto.randomUUID(), now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM runs WHERE started < ?1').bind(now - RUN_TTL),
    env.DB.prepare('INSERT INTO runs (id, player, started) VALUES (?1, ?2, ?3)').bind(id, body.player, now),
  ]);
  return json({ run: id }, 200, h);
}

async function submit(req, env, h) {
  const b = await req.json().catch(() => null);
  if (!b || !ID_RE.test(b.player || '') || !ID_RE.test(b.run || '')) return json({ error: 'bad request' }, 400, h);
  const name = cleanName(b.name);
  if (!name) return json({ error: 'bad name' }, 400, h);

  const now = Date.now();
  const run = await env.DB.prepare('SELECT player, started, used FROM runs WHERE id = ?1').bind(b.run).first();
  if (!run || run.player !== b.player || now - run.started > RUN_TTL) return json({ error: 'unknown run' }, 403, h);
  if (run.used) return json({ error: 'run already submitted' }, 409, h);

  const claim = { score: b.score, level: b.level, dist: b.dist, hats: b.hats };
  const why = implausible(claim, now - run.started);
  // spend the ticket either way, so a rejected run cannot be retried with tweaked numbers
  const spend = await env.DB.prepare('UPDATE runs SET used = 1 WHERE id = ?1 AND used = 0').bind(b.run).run();
  if (!spend.meta.changes) return json({ error: 'run already submitted' }, 409, h);
  if (why) return json({ error: 'rejected', reason: why }, 422, h);

  const prev = await env.DB.prepare('SELECT score, updated FROM scores WHERE player = ?1').bind(b.player).first();
  const improved = !prev || claim.score > prev.score;
  if (improved) {
    await env.DB.prepare(
      `INSERT INTO scores (player, name, score, level, dist, hats, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(player) DO UPDATE SET name = ?2, score = ?3, level = ?4, dist = ?5, hats = ?6, updated = ?7`)
      .bind(b.player, name, claim.score, claim.level, claim.dist, claim.hats, now).run();
  } else {
    await env.DB.prepare('UPDATE scores SET name = ?2 WHERE player = ?1').bind(b.player, name).run();
  }
  const best = improved ? claim.score : prev.score, at = improved ? now : prev.updated;
  const [rank, total] = await Promise.all([
    rankOf(env.DB, best, at),
    env.DB.prepare('SELECT COUNT(*) AS n FROM scores').first().then(r => r.n),
  ]);
  return json({ best, rank, total, improved }, 200, h);
}

async function top(req, env, h) {
  const player = new URL(req.url).searchParams.get('player') || '';
  const { results } = await env.DB.prepare(
    'SELECT player, name, score, level, dist, hats FROM scores ORDER BY score DESC, updated ASC LIMIT ?1').bind(TOP_N).all();
  const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM scores').first()).n;
  const rows = results.map((r, i) => ({ rank: i + 1, name: r.name, score: r.score, level: r.level, dist: r.dist, hats: r.hats, me: r.player === player }));
  let me = null;
  if (ID_RE.test(player)) {
    const mine = rows.find(r => r.me);
    if (mine) me = mine;
    else {
      const r = await env.DB.prepare('SELECT name, score, level, dist, hats, updated FROM scores WHERE player = ?1').bind(player).first();
      if (r) me = { rank: await rankOf(env.DB, r.score, r.updated), name: r.name, score: r.score, level: r.level, dist: r.dist, hats: r.hats, me: true };
    }
  }
  return json({ top: rows, me, total }, 200, { ...h, 'Cache-Control': 'no-store' });
}

export default {
  async fetch(req, env) {
    const h = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    try {
      if (req.method === 'POST' && path === '/run/start') return await startRun(req, env, h);
      if (req.method === 'POST' && path === '/score') return await submit(req, env, h);
      if (req.method === 'GET' && path === '/top') return await top(req, env, h);
      return json({ error: 'not found' }, 404, h);
    } catch (e) {
      return json({ error: 'server error' }, 500, h);
    }
  },
};
