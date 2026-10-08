'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const Ably = require('ably');
const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
const express = require('express');
const helmet = require('helmet');

for (const name of ['DATABASE_URL', 'SESSION_SECRET', 'ABLY_API_KEY']) {
  if (!process.env[name]) throw new Error(`Set ${name} in the Vercel project environment before deploying.`);
}
if (process.env.SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must contain at least 32 characters.');
}

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const ably = new Ably.Rest({ key: process.env.ABLY_API_KEY });
const app = express();
const sessionCookie = 'orbit.sid';
const sessionMaxAge = 30 * 24 * 60 * 60 * 1000;

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.ably.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://*.ably.io', 'wss://*.ably.io', 'https://*.ably-realtime.com', 'wss://*.ably-realtime.com']
    }
  }
}));
app.use(express.json({ limit: '12kb', type: 'application/json' }));

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci ON users (lower(username))',
  `CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS servers_name_ci ON servers (lower(name))',
  `CREATE TABLE IF NOT EXISTS channels (
    id TEXT NOT NULL,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    PRIMARY KEY (server_id, id),
    UNIQUE (server_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS voice_rooms (
    id BIGSERIAL PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    UNIQUE (server_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    server_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (server_id, channel_id) REFERENCES channels(server_id, id) ON DELETE CASCADE
  )`,
  'CREATE INDEX IF NOT EXISTS messages_by_channel ON messages(server_id, channel_id, id DESC)',
  `CREATE TABLE IF NOT EXISTS server_memberships (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, user_id)
  )`,
  'CREATE INDEX IF NOT EXISTS memberships_by_user ON server_memberships(user_id, server_id)',
  `CREATE TABLE IF NOT EXISTS server_invites (
    token_hash TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER NOT NULL,
    expires BIGINT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS invites_by_expiry ON server_invites(expires)',
  `CREATE TABLE IF NOT EXISTS sessions (
    id_hash TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires_at)',
  `CREATE TABLE IF NOT EXISTS rate_limits (
    id TEXT PRIMARY KEY,
    hits INTEGER NOT NULL,
    reset_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`
];

let schemaReady;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [731923151]);
        for (const statement of schemaStatements) await client.query(statement);
        const migration = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', ['remove-starter-servers']);
        if (!migration.rowCount) {
          await client.query("DELETE FROM servers WHERE id IN ('the-hideout', 'side-quest', 'study-buddies')");
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', ['remove-starter-servers']);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    })().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  return schemaReady;
}

let lastCleanupAt = 0;
let cleanupInProgress;
async function cleanupExpiredRecords() {
  const now = Date.now();
  if (now - lastCleanupAt < 60 * 60 * 1000) return;
  if (cleanupInProgress) return cleanupInProgress;
  cleanupInProgress = Promise.all([
    pool.query('DELETE FROM sessions WHERE expires_at <= now()'),
    pool.query('DELETE FROM server_invites WHERE expires <= $1', [now]),
    pool.query('DELETE FROM rate_limits WHERE reset_at <= $1', [now])
  ]).then(() => {
    lastCleanupAt = now;
  }).finally(() => {
    cleanupInProgress = null;
  });
  return cleanupInProgress;
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function signSessionId(id) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(id).digest('base64url');
}

function hashSessionId(id) {
  return crypto.createHash('sha256').update(id).digest('hex');
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return '';
}

function validSignature(id, supplied) {
  const expected = Buffer.from(signSessionId(id));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function loadSession(req, res, next) {
  try {
    req.session = { userId: null, idHash: null };
    const cookie = readCookie(req, sessionCookie);
    const separator = cookie.lastIndexOf('.');
    if (separator > 0) {
      const id = cookie.slice(0, separator);
      const signature = cookie.slice(separator + 1);
      if (/^[A-Za-z0-9_-]{40,64}$/.test(id) && validSignature(id, signature)) {
        const idHash = hashSessionId(id);
        const result = await pool.query(
          'SELECT user_id FROM sessions WHERE id_hash = $1 AND expires_at > now()',
          [idHash]
        );
        if (result.rowCount) req.session = { userId: Number(result.rows[0].user_id), idHash };
      }
    }
    next();
  } catch (error) {
    next(error);
  }
}

app.use('/api', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    await ensureSchema();
    await cleanupExpiredRecords();
    await loadSession(req, res, next);
  } catch (error) {
    next(error);
  }
});

app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return sendError(res, 403, 'This request needs a same-origin browser session.');
  let requestOrigin;
  try {
    requestOrigin = new URL(origin);
  } catch {
    return sendError(res, 403, 'Invalid request origin.');
  }
  if (requestOrigin.host !== req.get('host') || requestOrigin.protocol !== `${req.protocol}:`) {
    return sendError(res, 403, 'Cross-origin requests are not allowed.');
  }
  next();
});

function rateLimit(scope, max, windowMs, message) {
  return async (req, res, next) => {
    try {
      const key = `${scope}:${req.ip}`;
      const now = Date.now();
      const resetAt = now + windowMs;
      const result = await pool.query(`
        INSERT INTO rate_limits (id, hits, reset_at) VALUES ($1, 1, $3)
        ON CONFLICT (id) DO UPDATE SET
          hits = CASE WHEN rate_limits.reset_at <= $2 THEN 1 ELSE rate_limits.hits + 1 END,
          reset_at = CASE WHEN rate_limits.reset_at <= $2 THEN $3 ELSE rate_limits.reset_at END
        RETURNING hits, reset_at
      `, [key, now, resetAt]);
      const { hits, reset_at: limitResetAt } = result.rows[0];
      res.set('RateLimit-Limit', String(max));
      res.set('RateLimit-Remaining', String(Math.max(0, max - hits)));
      res.set('RateLimit-Reset', String(Math.ceil((limitResetAt - now) / 1000)));
      if (hits > max) return sendError(res, 429, message);
      next();
    } catch (error) {
      next(error);
    }
  };
}

const authRateLimit = rateLimit('auth', 10, 15 * 60 * 1000, 'Too many attempts. Please try again in a few minutes.');
const inviteRateLimit = rateLimit('invite', 10, 60 * 60 * 1000, 'You have created several invite links recently. Try again in an hour.');
const searchRateLimit = rateLimit('search', 30, 60 * 1000, 'Slow down a little before searching again.');
const messageRateLimit = rateLimit('message', 30, 60 * 1000, 'You are sending messages a little too quickly. Try again in a moment.');
const realtimeRateLimit = rateLimit('realtime', 60, 60 * 1000, 'Realtime reconnects are happening too quickly. Try again in a moment.');

function requireAccount(req, res, next) {
  if (!Number.isInteger(req.session?.userId)) return sendError(res, 401, 'Sign in to continue.');
  next();
}

function publicUser(user) {
  return { id: Number(user.id), username: user.username };
}

function invitationHash(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

async function isServerMember(serverId, userId, client = pool) {
  const result = await client.query(
    'SELECT 1 FROM server_memberships WHERE server_id = $1 AND user_id = $2',
    [serverId, userId]
  );
  return result.rowCount > 0;
}

async function acceptInvitation(client, userId, code) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(code)) {
    throw new ApiError(400, 'Open the complete invitation link you received.');
  }
  const invitation = await client.query(`
    SELECT token_hash, server_id, uses, max_uses, expires
    FROM server_invites WHERE token_hash = $1 FOR UPDATE
  `, [invitationHash(code)]);
  if (!invitation.rowCount) {
    throw new ApiError(410, 'This invitation has expired or reached its use limit. Ask a server member for a new link.');
  }
  const invite = invitation.rows[0];
  if (await isServerMember(invite.server_id, userId, client)) {
    return { serverId: invite.server_id, alreadyMember: true };
  }
  if (Number(invite.expires) <= Date.now() || invite.uses >= invite.max_uses) {
    throw new ApiError(410, 'This invitation has expired or reached its use limit. Ask a server member for a new link.');
  }
  const update = await client.query(`
    UPDATE server_invites SET uses = uses + 1
    WHERE token_hash = $1 AND expires > $2 AND uses < max_uses
  `, [invite.token_hash, Date.now()]);
  if (!update.rowCount) {
    throw new ApiError(410, 'This invitation has expired or reached its use limit. Ask a server member for a new link.');
  }
  await client.query(
    "INSERT INTO server_memberships (server_id, user_id, role) VALUES ($1, $2, 'member')",
    [invite.server_id, userId]
  );
  return { serverId: invite.server_id, alreadyMember: false };
}

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function sessionCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: sessionMaxAge,
    path: '/'
  };
}

async function loginSession(req, res, user) {
  const id = crypto.randomBytes(32).toString('base64url');
  const idHash = hashSessionId(id);
  await pool.query(
    'INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() + interval \'30 days\')',
    [idHash, user.id]
  );
  res.cookie(sessionCookie, `${id}.${signSessionId(id)}`, sessionCookieOptions(req));
  res.json({ user: publicUser(user) });
}

async function publishServerEvent(serverId, event, payload) {
  try {
    await ably.channels.get(`orbit:server:${serverId}`).publish(event, payload);
    return true;
  } catch (error) {
    console.error(`Could not publish ${event} to Ably for server ${serverId}:`, error);
    return false;
  }
}

app.get('/api/auth/me', async (req, res) => {
  if (!Number.isInteger(req.session.userId)) {
    const result = await pool.query('SELECT 1 FROM users LIMIT 1');
    return res.json({ user: null, firstAccountAvailable: result.rowCount === 0 });
  }
  const result = await pool.query('SELECT id, username FROM users WHERE id = $1', [req.session.userId]);
  if (!result.rowCount) {
    if (req.session.idHash) await pool.query('DELETE FROM sessions WHERE id_hash = $1', [req.session.idHash]);
    res.clearCookie(sessionCookie, sessionCookieOptions(req));
    return sendError(res, 401, 'Your account is no longer available. Sign in again.');
  }
  res.json({ user: publicUser(result.rows[0]) });
});

app.post('/api/auth/register', authRateLimit, async (req, res, next) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!/^[A-Za-z0-9_]{2,24}$/.test(username)) {
    return sendError(res, 400, 'Choose a username with 2–24 letters, numbers, or underscores.');
  }
  if (Array.from(password).length < 10 || Buffer.byteLength(password, 'utf8') > 72) {
    return sendError(res, 400, 'Choose a password with at least 10 characters (maximum 72 UTF-8 bytes).');
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await withTransaction(async (client) => {
      await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      const users = await client.query('SELECT 1 FROM users LIMIT 1');
      const isFirstAccount = users.rowCount === 0;
      if (!isFirstAccount && typeof req.body?.invite !== 'string') {
        throw new ApiError(403, 'Ask a member of your friends’ server for an invitation link before creating an account.');
      }
      const inserted = await client.query(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
        [username, passwordHash]
      );
      if (!isFirstAccount) await acceptInvitation(client, inserted.rows[0].id, req.body.invite);
      return inserted.rows[0];
    });
    await loginSession(req, res, user);
  } catch (error) {
    if (error instanceof ApiError) return sendError(res, error.status, error.message);
    if (error.code === '23505') return sendError(res, 409, 'That username is already taken.');
    next(error);
  }
});

app.post('/api/auth/login', authRateLimit, async (req, res, next) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || Buffer.byteLength(password, 'utf8') > 72) return sendError(res, 401, 'Invalid username or password.');
  try {
    const result = await pool.query('SELECT id, username, password_hash FROM users WHERE lower(username) = lower($1)', [username]);
    const user = result.rows[0];
    const passwordHash = user ? user.password_hash : await bcrypt.hash('nonexistent-account-timing-check', 12);
    const passwordMatches = await bcrypt.compare(password, passwordHash);
    if (!user || !passwordMatches) return sendError(res, 401, 'Invalid username or password.');
    await loginSession(req, res, user);
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', requireAccount, async (req, res) => {
  if (req.session.idHash) await pool.query('DELETE FROM sessions WHERE id_hash = $1', [req.session.idHash]);
  res.clearCookie(sessionCookie, sessionCookieOptions(req));
  res.status(204).end();
});

app.post('/api/invites/accept', requireAccount, async (req, res) => {
  const result = await withTransaction((client) => acceptInvitation(client, req.session.userId, req.body?.code));
  const realtimeUnavailable = !result.alreadyMember
    && !await publishServerEvent(result.serverId, 'server:updated', { serverId: result.serverId });
  res.json({ ...result, ...(realtimeUnavailable ? { realtimeUnavailable: true } : {}) });
});

app.post('/api/realtime/token', requireAccount, realtimeRateLimit, async (req, res) => {
  const memberships = await pool.query(
    'SELECT server_id FROM server_memberships WHERE user_id = $1',
    [req.session.userId]
  );
  const capability = {};
  for (const membership of memberships.rows) {
    capability[`orbit:server:${membership.server_id}`] = ['subscribe'];
    capability[`orbit:server:${membership.server_id}:presence`] = ['subscribe', 'presence'];
  }
  const tokenRequest = await ably.auth.createTokenRequest({
    clientId: String(req.session.userId),
    capability: JSON.stringify(capability)
  });
  res.json({ tokenRequest });
});

app.get('/api/servers', requireAccount, async (req, res) => {
  const result = await pool.query(`
    SELECT servers.id, servers.name, servers.icon
    FROM servers
    JOIN server_memberships ON server_memberships.server_id = servers.id
    WHERE server_memberships.user_id = $1
    ORDER BY servers.position, servers.name
  `, [req.session.userId]);
  const servers = await Promise.all(result.rows.map(async (server) => {
    const [channels, voice] = await Promise.all([
      pool.query('SELECT id, name, description, position FROM channels WHERE server_id = $1 ORDER BY position, name', [server.id]),
      pool.query('SELECT id, name FROM voice_rooms WHERE server_id = $1 ORDER BY position, id', [server.id])
    ]);
    return { ...server, channels: channels.rows, voice: voice.rows };
  }));
  res.json({ servers });
});

app.post('/api/servers/:serverId/invites', requireAccount, inviteRateLimit, async (req, res) => {
  const { serverId } = req.params;
  if (!await isServerMember(serverId, req.session.userId)) return sendError(res, 404, 'That server does not exist or you are not a member.');
  const code = crypto.randomBytes(24).toString('base64url');
  const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
  await pool.query(`
    INSERT INTO server_invites (token_hash, server_id, created_by, max_uses, expires)
    VALUES ($1, $2, $3, 20, $4)
  `, [invitationHash(code), serverId, req.session.userId, expires]);
  res.status(201).json({ code, expires, maxUses: 20 });
});

app.post('/api/servers', requireAccount, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 32) : '';
  if (!name) return sendError(res, 400, 'Choose a name for your space.');
  const id = `server-${crypto.randomBytes(6).toString('hex')}`;
  try {
    await withTransaction(async (client) => {
      const position = await client.query('SELECT coalesce(max(position), -1) + 1 AS value FROM servers');
      await client.query(
        'INSERT INTO servers (id, name, icon, position, created_by) VALUES ($1, $2, $3, $4, $5)',
        [id, name, '✦', position.rows[0].value, req.session.userId]
      );
      await client.query(
        "INSERT INTO server_memberships (server_id, user_id, role) VALUES ($1, $2, 'owner')",
        [id, req.session.userId]
      );
      await client.query(`
        INSERT INTO channels (id, server_id, name, description, position)
        VALUES ('general', $1, 'general', 'the place for everything and nothing', 0)
      `, [id]);
      await client.query(
        "INSERT INTO voice_rooms (server_id, name, position) VALUES ($1, 'The lounge', 0)",
        [id]
      );
    });
  } catch (error) {
    if (error.code === '23505') return sendError(res, 409, 'A shared server with that name already exists.');
    throw error;
  }
  const realtimeUnavailable = !await publishServerEvent(id, 'server:updated', { serverId: id });
  res.status(201).json({
    ...(realtimeUnavailable ? { realtimeUnavailable: true } : {}),
    server: {
      id, name, icon: '✦',
      channels: [{ id: 'general', name: 'general', description: 'the place for everything and nothing' }],
      voice: [{ name: 'The lounge' }]
    }
  });
});

app.get('/api/members', requireAccount, async (req, res) => {
  const serverId = typeof req.query.server === 'string' ? req.query.server : '';
  if (!await isServerMember(serverId, req.session.userId)) return sendError(res, 404, 'That server does not exist or you are not a member.');
  const [members, presence] = await Promise.all([
    pool.query(`
      SELECT users.id, users.username FROM users
      JOIN server_memberships ON server_memberships.user_id = users.id
      WHERE server_memberships.server_id = $1
      ORDER BY lower(users.username)
    `, [serverId]),
    ably.channels.get(`orbit:server:${serverId}:presence`).presence.get()
  ]);
  const onlineIds = new Set(presence.map((member) => Number(member.clientId)));
  res.json({ members: members.rows.map((member) => ({ ...publicUser(member), online: onlineIds.has(Number(member.id)) })) });
});

app.get('/api/messages', requireAccount, async (req, res) => {
  const serverId = typeof req.query.server === 'string' ? req.query.server : '';
  const channelId = typeof req.query.channel === 'string' ? req.query.channel : '';
  if (!await isServerMember(serverId, req.session.userId)) return sendError(res, 404, 'That server does not exist or you are not a member.');
  const channel = await pool.query('SELECT 1 FROM channels WHERE server_id = $1 AND id = $2', [serverId, channelId]);
  if (!channel.rowCount) return sendError(res, 404, 'That channel does not exist.');
  const result = await pool.query(`
    SELECT id, user_id AS "userId", username AS author, text,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS "createdAt"
    FROM messages WHERE server_id = $1 AND channel_id = $2
    ORDER BY id DESC LIMIT 100
  `, [serverId, channelId]);
  res.json({ messages: result.rows.reverse().map((message) => ({ ...message, id: Number(message.id), userId: message.userId === null ? null : Number(message.userId) })) });
});

app.get('/api/search', requireAccount, searchRateLimit, async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!query || query.length > 80) return sendError(res, 400, 'Enter a search between 1 and 80 characters.');
  const result = await pool.query(`
    SELECT messages.id, messages.server_id AS "serverId", servers.name AS "serverName",
      messages.channel_id AS "channelId", channels.name AS "channelName",
      messages.username AS author, messages.text,
      to_char(messages.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS "createdAt"
    FROM messages
    JOIN servers ON servers.id = messages.server_id
    JOIN channels ON channels.id = messages.channel_id AND channels.server_id = messages.server_id
    JOIN server_memberships ON server_memberships.server_id = messages.server_id
    WHERE position(lower($1) IN lower(messages.text)) > 0
      AND server_memberships.user_id = $2
    ORDER BY messages.id DESC LIMIT 50
  `, [query, req.session.userId]);
  res.json({ results: result.rows.map((row) => ({ ...row, id: Number(row.id) })) });
});

app.post('/api/servers/:serverId/channels', requireAccount, async (req, res) => {
  const rawName = typeof req.body?.name === 'string' ? req.body.name : '';
  const name = rawName.trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  if (!name) return sendError(res, 400, 'Choose a channel name using letters or numbers.');
  const { serverId } = req.params;
  if (!await isServerMember(serverId, req.session.userId)) return sendError(res, 404, 'That server does not exist or you are not a member.');
  try {
    const position = await pool.query('SELECT coalesce(max(position), -1) + 1 AS value FROM channels WHERE server_id = $1', [serverId]);
    await pool.query(`
      INSERT INTO channels (id, server_id, name, description, position)
      VALUES ($1, $2, $1, 'a fresh little corner for your friends', $3)
    `, [name, serverId, position.rows[0].value]);
  } catch (error) {
    if (error.code === '23505') return sendError(res, 409, `#${name} already exists.`);
    throw error;
  }
  const realtimeUnavailable = !await publishServerEvent(serverId, 'server:updated', { serverId });
  res.status(201).json({
    ...(realtimeUnavailable ? { realtimeUnavailable: true } : {}),
    channel: { id: name, name, description: 'a fresh little corner for your friends' }
  });
});

app.post('/api/servers/:serverId/voice', requireAccount, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 32) : '';
  if (!name) return sendError(res, 400, 'Choose a name for the voice room.');
  const { serverId } = req.params;
  if (!await isServerMember(serverId, req.session.userId)) return sendError(res, 404, 'That server does not exist or you are not a member.');
  try {
    const position = await pool.query('SELECT coalesce(max(position), -1) + 1 AS value FROM voice_rooms WHERE server_id = $1', [serverId]);
    await pool.query('INSERT INTO voice_rooms (server_id, name, position) VALUES ($1, $2, $3)', [serverId, name, position.rows[0].value]);
  } catch (error) {
    if (error.code === '23505') return sendError(res, 409, 'That voice room already exists.');
    throw error;
  }
  const realtimeUnavailable = !await publishServerEvent(serverId, 'server:updated', { serverId });
  res.status(201).json({ name, ...(realtimeUnavailable ? { realtimeUnavailable: true } : {}) });
});

app.post('/api/messages', requireAccount, messageRateLimit, async (req, res) => {
  const { serverId, channelId } = req.body || {};
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (typeof serverId !== 'string' || typeof channelId !== 'string') return sendError(res, 400, 'Choose a channel first.');
  if (!await isServerMember(serverId, req.session.userId)) return sendError(res, 404, 'That server does not exist or you are not a member.');
  if (!text || Array.from(text).length > 500) return sendError(res, 400, 'Messages must be between 1 and 500 characters.');
  const result = await pool.query(`
    INSERT INTO messages (server_id, channel_id, user_id, username, text)
    SELECT $1, $2, users.id, users.username, $3 FROM users
    WHERE users.id = $4
      AND EXISTS (SELECT 1 FROM channels WHERE server_id = $1 AND id = $2)
    RETURNING id, user_id AS "userId", username AS author, text,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS "createdAt"
  `, [serverId, channelId, text, req.session.userId]);
  if (!result.rowCount) {
    const user = await pool.query('SELECT 1 FROM users WHERE id = $1', [req.session.userId]);
    if (!user.rowCount) return sendError(res, 401, 'Sign in to continue.');
    return sendError(res, 404, 'That channel does not exist.');
  }
  const message = { ...result.rows[0], id: Number(result.rows[0].id), userId: Number(result.rows[0].userId), serverId, channelId };
  const realtimeUnavailable = !await publishServerEvent(serverId, 'chat:message', message);
  res.status(201).json({ message, ...(realtimeUnavailable ? { realtimeUnavailable: true } : {}) });
});

app.use('/api', (req, res) => sendError(res, 404, 'That API route does not exist.'));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof ApiError) return sendError(res, error.status, error.message);
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return sendError(res, 400, 'The request body must be valid JSON.');
  }
  console.error('Vercel API request failed:', error);
  sendError(res, 500, 'Something went wrong. Please try again.');
});

module.exports = app;
