'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { Server: SocketServer } = require('socket.io');

const root = __dirname;
const dataDirectory = path.join(root, 'data');
fs.mkdirSync(dataDirectory, { recursive: true });

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('Set SESSION_SECRET to a long, random value before starting in production.');
}

function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const secretPath = path.join(dataDirectory, 'session-secret');
  try {
    return fs.readFileSync(secretPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const secret = crypto.randomBytes(48).toString('hex');
    try {
      fs.writeFileSync(secretPath, secret, { flag: 'wx', mode: 0o600 });
      return secret;
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
      return fs.readFileSync(secretPath, 'utf8');
    }
  }
}

const sessionSecret = getSessionSecret();
const database = new Database(path.join(dataDirectory, 'orbit.sqlite'));
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.pragma('busy_timeout = 5000');
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT NOT NULL,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    PRIMARY KEY (server_id, id),
    UNIQUE (server_id, name)
  );
  CREATE TABLE IF NOT EXISTS voice_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    UNIQUE (server_id, name)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (server_id, channel_id) REFERENCES channels(server_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS messages_by_channel ON messages(server_id, channel_id, id DESC);
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires);
  CREATE TABLE IF NOT EXISTS server_memberships (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (server_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS memberships_by_user ON server_memberships(user_id, server_id);
  CREATE TABLE IF NOT EXISTS server_invites (
    token_hash TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS invites_by_expiry ON server_invites(expires);
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const removeStarterServers = database.transaction(() => {
  const migrationName = 'remove-starter-servers';
  if (database.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(migrationName)) return;
  database.prepare(`
    DELETE FROM servers
    WHERE id IN ('the-hideout', 'side-quest', 'study-buddies')
  `).run();
  database.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(migrationName);
});
removeStarterServers();
database.exec('CREATE UNIQUE INDEX IF NOT EXISTS servers_by_name ON servers(name COLLATE NOCASE);');
const migrateExistingMemberships = database.transaction(() => {
  if (database.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get('server-memberships')) return;
  database.prepare(`
    INSERT OR IGNORE INTO server_memberships (server_id, user_id, role)
    SELECT servers.id, users.id,
      CASE WHEN servers.created_by = users.id THEN 'owner' ELSE 'member' END
    FROM servers CROSS JOIN users
  `).run();
  database.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run('server-memberships');
});
migrateExistingMemberships();

const app = express();
const httpServer = require('node:http').createServer(app);
const io = new SocketServer(httpServer, {
  serveClient: true,
  maxHttpBufferSize: 12_000,
  cors: { origin: false }
});

const isProduction = process.env.NODE_ENV === 'production';
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  strictTransportSecurity: isProduction ? undefined : false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.ably.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:', 'https://*.ably.io', 'wss://*.ably.io', 'https://*.ably-realtime.com', 'wss://*.ably-realtime.com']
    }
  }
}));
app.use(express.json({ limit: '12kb', type: 'application/json' }));

class SQLiteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.getStatement = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?');
    this.setStatement = db.prepare(`
      INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
    `);
    this.touchStatement = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.deleteStatement = db.prepare('DELETE FROM sessions WHERE sid = ?');
  }

  get(sid, callback) {
    try {
      const row = this.getStatement.get(sid, Date.now());
      callback(null, row ? JSON.parse(row.sess) : null);
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sessionData, callback = () => {}) {
    try {
      const expires = sessionData.cookie?.expires ? new Date(sessionData.cookie.expires).getTime() : Date.now() + 30 * 24 * 60 * 60 * 1000;
      this.setStatement.run(sid, JSON.stringify(sessionData), expires);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sessionData, callback = () => {}) {
    try {
      const expires = sessionData.cookie?.expires ? new Date(sessionData.cookie.expires).getTime() : Date.now() + 30 * 24 * 60 * 60 * 1000;
      this.touchStatement.run(expires, sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.deleteStatement.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }
}

const sessionMiddleware = session({
  name: 'orbit.sid',
  secret: sessionSecret,
  store: new SQLiteSessionStore(database),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 30 * 24 * 60 * 60 * 1000
  }
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

function requireAccount(req, res, next) {
  if (!Number.isInteger(req.session.userId)) return sendError(res, 401, 'Sign in to continue.');
  next();
}

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

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' }
});

const findUserById = database.prepare('SELECT id, username, created_at FROM users WHERE id = ?');
const findUserByName = database.prepare('SELECT id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE');
const findInvitation = database.prepare('SELECT token_hash, server_id, uses, max_uses, expires FROM server_invites WHERE token_hash = ?');
const connectedUsers = new Set();

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function publicUser(user) {
  return { id: user.id, username: user.username };
}

function invitationHash(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function acceptInvitationInTransaction(userId, code) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(code)) {
    throw new ApiError(400, 'Open the complete invitation link you received.');
  }
  const invitation = findInvitation.get(invitationHash(code));
  if (!invitation) {
    throw new ApiError(410, 'This invitation has expired or reached its use limit. Ask a server member for a new link.');
  }
  if (isServerMember.get(invitation.server_id, userId)) {
    return { serverId: invitation.server_id, alreadyMember: true };
  }
  if (invitation.expires <= Date.now() || invitation.uses >= invitation.max_uses) {
    throw new ApiError(410, 'This invitation has expired or reached its use limit. Ask a server member for a new link.');
  }
  const update = database.prepare(`
    UPDATE server_invites SET uses = uses + 1
    WHERE token_hash = ? AND expires > ? AND uses < max_uses
  `).run(invitation.token_hash, Date.now());
  if (!update.changes) {
    throw new ApiError(410, 'This invitation has expired or reached its use limit. Ask a server member for a new link.');
  }
  database.prepare('INSERT INTO server_memberships (server_id, user_id, role) VALUES (?, ?, ?)').run(invitation.server_id, userId, 'member');
  return { serverId: invitation.server_id, alreadyMember: false };
}

function loginSession(req, res, user) {
  req.session.regenerate((error) => {
    if (error) return sendError(res, 500, 'Could not start your session.');
    req.session.userId = user.id;
    req.session.save((saveError) => {
      if (saveError) return sendError(res, 500, 'Could not save your session.');
      res.json({ user: publicUser(user) });
    });
  });
}

const userRoom = (userId) => `user:${userId}`;
const serverRoom = (serverId) => `server:${serverId}`;
const channelRoom = (serverId, channelId) => `channel:${serverId}:${channelId}`;
const userServers = database.prepare('SELECT server_id AS id FROM server_memberships WHERE user_id = ?');
const serverMemberIds = database.prepare('SELECT user_id AS id FROM server_memberships WHERE server_id = ?');
const isServerMember = database.prepare('SELECT 1 FROM server_memberships WHERE server_id = ? AND user_id = ?');

function broadcastPresence(serverId) {
  const onlineIds = serverMemberIds.all(serverId)
    .map((member) => member.id)
    .filter((id) => connectedUsers.has(id));
  io.to(serverRoom(serverId)).emit('presence:update', onlineIds);
}

function joinUserToServer(userId, serverId) {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.user?.id === userId) socket.join(serverRoom(serverId));
  }
}

io.use((socket, next) => {
  const userId = socket.request.session?.userId;
  if (!Number.isInteger(userId)) return next(new Error('Sign in to join chat.'));
  const user = findUserById.get(userId);
  if (!user) return next(new Error('Your account is no longer available. Sign in again.'));
  socket.user = publicUser(user);
  next();
});

io.on('connection', (socket) => {
  const userId = socket.user.id;
  connectedUsers.add(userId);
  socket.join(userRoom(userId));
  const memberships = userServers.all(userId);
  memberships.forEach((membership) => socket.join(serverRoom(membership.id)));
  memberships.forEach((membership) => broadcastPresence(membership.id));

  socket.on('channel:join', ({ serverId, channelId } = {}, acknowledge = () => {}) => {
    if (typeof serverId !== 'string' || typeof channelId !== 'string') {
      return acknowledge({ error: 'Choose a valid channel.' });
    }
    const channelExists = database.prepare(`
      SELECT 1 FROM channels
      JOIN server_memberships ON server_memberships.server_id = channels.server_id
      WHERE channels.server_id = ? AND channels.id = ? AND server_memberships.user_id = ?
    `).get(serverId, channelId, userId);
    if (!channelExists) return acknowledge({ error: 'That channel does not exist.' });
    if (socket.currentChannel) socket.leave(socket.currentChannel);
    socket.currentChannel = channelRoom(serverId, channelId);
    socket.join(socket.currentChannel);
    acknowledge({ ok: true });
  });

  socket.on('disconnect', () => {
    const memberships = userServers.all(userId);
    if (!io.sockets.sockets.size || ![...io.sockets.sockets.values()].some((connected) => connected.user?.id === userId)) {
      connectedUsers.delete(userId);
    }
    memberships.forEach((membership) => broadcastPresence(membership.id));
  });
});

app.get('/api/auth/me', (req, res) => {
  if (!Number.isInteger(req.session.userId)) {
    const firstAccountAvailable = database.prepare('SELECT 1 FROM users LIMIT 1').get() === undefined;
    return res.json({ user: null, firstAccountAvailable });
  }
  const user = findUserById.get(req.session.userId);
  if (!user) {
    return req.session.destroy(() => sendError(res, 401, 'Your account is no longer available. Sign in again.'));
  }
  res.json({ user: publicUser(user) });
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
    const user = database.transaction(() => {
      const isFirstAccount = database.prepare('SELECT 1 FROM users LIMIT 1').get() === undefined;
      if (!isFirstAccount && typeof req.body?.invite !== 'string') {
        throw new ApiError(403, 'Ask a member of your friends’ server for an invitation link before creating an account.');
      }
      const result = database.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
      const createdUser = { id: Number(result.lastInsertRowid), username };
      if (isFirstAccount) {
        database.prepare(`
          INSERT INTO server_memberships (server_id, user_id, role)
          SELECT id, ?, 'owner' FROM servers
        `).run(createdUser.id);
      } else {
        acceptInvitationInTransaction(createdUser.id, req.body.invite);
      }
      return createdUser;
    })();
    loginSession(req, res, user);
  } catch (error) {
    if (error instanceof ApiError) return sendError(res, error.status, error.message);
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendError(res, 409, 'That username is already taken.');
    next(error);
  }
});

app.post('/api/auth/login', authRateLimit, async (req, res, next) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || Buffer.byteLength(password, 'utf8') > 72) return sendError(res, 401, 'Invalid username or password.');
  try {
    const user = findUserByName.get(username);
    const passwordHash = user ? user.password_hash : await bcrypt.hash('nonexistent-account-timing-check', 12);
    const passwordMatches = await bcrypt.compare(password, passwordHash);
    if (!user || !passwordMatches) return sendError(res, 401, 'Invalid username or password.');
    loginSession(req, res, user);
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', requireAccount, (req, res) => {
  req.session.destroy((error) => {
    if (error) return sendError(res, 500, 'Could not sign out. Please try again.');
    res.clearCookie('orbit.sid', { httpOnly: true, sameSite: 'lax', secure: isProduction });
    res.status(204).end();
  });
});

app.post('/api/invites/accept', requireAccount, (req, res) => {
  try {
    const result = database.transaction(() => acceptInvitationInTransaction(req.session.userId, req.body?.code))();
    joinUserToServer(req.session.userId, result.serverId);
    io.to(serverRoom(result.serverId)).emit('server:updated', result.serverId);
    broadcastPresence(result.serverId);
    res.json(result);
  } catch (error) {
    if (error instanceof ApiError) return sendError(res, error.status, error.message);
    throw error;
  }
});

const createInviteRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'You have created several invite links recently. Try again in an hour.' }
});
const listServers = database.prepare('SELECT id, name, icon, position FROM servers ORDER BY position, name');
const listChannels = database.prepare('SELECT id, name, description, position FROM channels WHERE server_id = ? ORDER BY position, name');
const listVoiceRooms = database.prepare('SELECT id, name FROM voice_rooms WHERE server_id = ? ORDER BY position, id');

app.get('/api/servers', requireAccount, (req, res) => {
  const servers = listServers.all().filter((server) => isServerMember.get(server.id, req.session.userId)).map((server) => ({
    id: server.id,
    name: server.name,
    icon: server.icon,
    channels: listChannels.all(server.id),
    voice: listVoiceRooms.all(server.id)
  }));
  res.json({ servers });
});

app.post('/api/servers/:serverId/invites', requireAccount, createInviteRateLimit, (req, res) => {
  const serverId = req.params.serverId;
  if (!isServerMember.get(serverId, req.session.userId)) return sendError(res, 404, 'That server does not exist or you are not a member.');
  const code = crypto.randomBytes(24).toString('base64url');
  const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
  database.prepare(`
    INSERT INTO server_invites (token_hash, server_id, created_by, max_uses, expires)
    VALUES (?, ?, ?, 20, ?)
  `).run(invitationHash(code), serverId, req.session.userId, expires);
  res.status(201).json({ code, expires, maxUses: 20 });
});

app.post('/api/servers', requireAccount, (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 32) : '';
  if (!name) return sendError(res, 400, 'Choose a name for your space.');
  if (database.prepare('SELECT 1 FROM servers WHERE name = ? COLLATE NOCASE').get(name)) {
    return sendError(res, 409, 'A shared server with that name already exists.');
  }
  const id = `server-${crypto.randomBytes(6).toString('hex')}`;
  const position = database.prepare('SELECT coalesce(max(position), -1) + 1 AS value FROM servers').get().value;
  const createServer = database.transaction(() => {
    database.prepare('INSERT INTO servers (id, name, icon, position, created_by) VALUES (?, ?, ?, ?, ?)').run(id, name, '✦', position, req.session.userId);
    database.prepare('INSERT INTO server_memberships (server_id, user_id, role) VALUES (?, ?, ?)').run(id, req.session.userId, 'owner');
    database.prepare('INSERT INTO channels (id, server_id, name, description, position) VALUES (?, ?, ?, ?, ?)').run('general', id, 'general', 'the place for everything and nothing', 0);
    database.prepare('INSERT INTO voice_rooms (server_id, name, position) VALUES (?, ?, ?)').run(id, 'The lounge', 0);
  });
  try {
    createServer();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return sendError(res, 409, 'A shared server with that name already exists.');
    }
    throw error;
  }
  joinUserToServer(req.session.userId, id);
  io.to(serverRoom(id)).emit('server:updated', id);
  res.status(201).json({ server: { id, name, icon: '✦', channels: [{ id: 'general', name: 'general', description: 'the place for everything and nothing' }], voice: [{ name: 'The lounge' }] } });
});

app.get('/api/members', requireAccount, (req, res) => {
  const serverId = typeof req.query.server === 'string' ? req.query.server : '';
  if (!isServerMember.get(serverId, req.session.userId)) return sendError(res, 404, 'That server does not exist or you are not a member.');
  const members = database.prepare(`
    SELECT users.id, users.username FROM users
    JOIN server_memberships ON server_memberships.user_id = users.id
    WHERE server_memberships.server_id = ?
    ORDER BY users.username COLLATE NOCASE
  `).all(serverId);
  res.json({
    members: members.map((member) => ({
      ...publicUser(member),
      online: connectedUsers.has(member.id)
    }))
  });
});

app.get('/api/messages', requireAccount, (req, res) => {
  const serverId = typeof req.query.server === 'string' ? req.query.server : '';
  const channelId = typeof req.query.channel === 'string' ? req.query.channel : '';
  if (!isServerMember.get(serverId, req.session.userId)) return sendError(res, 404, 'That server does not exist or you are not a member.');
  if (!database.prepare('SELECT 1 FROM channels WHERE server_id = ? AND id = ?').get(serverId, channelId)) {
    return sendError(res, 404, 'That channel does not exist.');
  }
  const messages = database.prepare(`
    SELECT id, user_id AS userId, username AS author, text, created_at AS createdAt
    FROM messages WHERE server_id = ? AND channel_id = ?
    ORDER BY id DESC LIMIT 100
  `).all(serverId, channelId).reverse();
  res.json({ messages });
});

const searchRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Slow down a little before searching again.' }
});
app.get('/api/search', requireAccount, searchRateLimit, (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!query || query.length > 80) return sendError(res, 400, 'Enter a search between 1 and 80 characters.');
  const results = database.prepare(`
    SELECT messages.id, messages.server_id AS serverId, servers.name AS serverName,
      messages.channel_id AS channelId, channels.name AS channelName,
      messages.username AS author, messages.text, messages.created_at AS createdAt
    FROM messages
    JOIN servers ON servers.id = messages.server_id
    JOIN channels ON channels.id = messages.channel_id AND channels.server_id = messages.server_id
    JOIN server_memberships ON server_memberships.server_id = messages.server_id
    WHERE instr(lower(messages.text), lower(?)) > 0
      AND server_memberships.user_id = ?
    ORDER BY messages.id DESC LIMIT 50
  `).all(query, req.session.userId);
  res.json({ results });
});

app.post('/api/servers/:serverId/channels', requireAccount, (req, res) => {
  const rawName = typeof req.body?.name === 'string' ? req.body.name : '';
  const name = rawName.trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  if (!name) return sendError(res, 400, 'Choose a channel name using letters or numbers.');
  if (!isServerMember.get(req.params.serverId, req.session.userId)) return sendError(res, 404, 'That server does not exist or you are not a member.');
  const server = database.prepare('SELECT id FROM servers WHERE id = ?').get(req.params.serverId);
  if (!server) return sendError(res, 404, 'That server does not exist.');
  try {
    const position = database.prepare('SELECT coalesce(max(position), -1) + 1 AS value FROM channels WHERE server_id = ?').get(server.id).value;
    database.prepare('INSERT INTO channels (id, server_id, name, description, position) VALUES (?, ?, ?, ?, ?)').run(name, server.id, name, 'a fresh little corner for your friends', position);
    io.to(serverRoom(server.id)).emit('server:updated', server.id);
    res.status(201).json({ channel: { id: name, name, description: 'a fresh little corner for your friends' } });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendError(res, 409, `#${name} already exists.`);
    throw error;
  }
});

app.post('/api/servers/:serverId/voice', requireAccount, (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 32) : '';
  if (!name) return sendError(res, 400, 'Choose a name for the voice room.');
  if (!isServerMember.get(req.params.serverId, req.session.userId)) return sendError(res, 404, 'That server does not exist or you are not a member.');
  const server = database.prepare('SELECT id FROM servers WHERE id = ?').get(req.params.serverId);
  if (!server) return sendError(res, 404, 'That server does not exist.');
  try {
    const position = database.prepare('SELECT coalesce(max(position), -1) + 1 AS value FROM voice_rooms WHERE server_id = ?').get(server.id).value;
    database.prepare('INSERT INTO voice_rooms (server_id, name, position) VALUES (?, ?, ?)').run(server.id, name, position);
    io.to(serverRoom(server.id)).emit('server:updated', server.id);
    res.status(201).json({ name });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendError(res, 409, 'That voice room already exists.');
    throw error;
  }
});

const messageRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'You are sending messages a little too quickly. Try again in a moment.' }
});
app.post('/api/messages', requireAccount, messageRateLimit, (req, res) => {
  const { serverId, channelId } = req.body || {};
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (typeof serverId !== 'string' || typeof channelId !== 'string') return sendError(res, 400, 'Choose a channel first.');
  if (!isServerMember.get(serverId, req.session.userId)) return sendError(res, 404, 'That server does not exist or you are not a member.');
  if (!text || Array.from(text).length > 500) return sendError(res, 400, 'Messages must be between 1 and 500 characters.');
  if (!database.prepare('SELECT 1 FROM channels WHERE server_id = ? AND id = ?').get(serverId, channelId)) {
    return sendError(res, 404, 'That channel does not exist.');
  }
  const user = findUserById.get(req.session.userId);
  if (!user) return sendError(res, 401, 'Sign in to continue.');
  const result = database.prepare('INSERT INTO messages (server_id, channel_id, user_id, username, text) VALUES (?, ?, ?, ?, ?)').run(serverId, channelId, user.id, user.username, text);
  const message = database.prepare(`
    SELECT id, user_id AS userId, username AS author, text, created_at AS createdAt
    FROM messages WHERE id = ?
  `).get(result.lastInsertRowid);
  io.to(channelRoom(serverId, channelId)).emit('chat:message', {
      ...message,
      id: Number(message.id),
      serverId,
      channelId
    });
  res.status(201).json({ message: { ...message, id: Number(message.id) } });
});

app.use('/api', (req, res) => sendError(res, 404, 'That API route does not exist.'));
app.use(['/server.js', '/package.json', '/package-lock.json', '/README.md'], (req, res) => res.sendStatus(404));
app.use('/data', (req, res) => res.sendStatus(404));
app.use('/node_modules', (req, res) => res.sendStatus(404));
app.use(express.static(path.join(root, 'public'), {
  index: 'index.html',
  dotfiles: 'deny',
  setHeaders(res, filename) {
    if (filename.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof ApiError) return sendError(res, error.status, error.message);
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return sendError(res, 400, 'The request body must be valid JSON.');
  }
  console.error('Request failed:', error);
  sendError(res, 500, 'Something went wrong. Please try again.');
});

const cleanupInterval = setInterval(() => {
  try {
    database.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    database.prepare('DELETE FROM server_invites WHERE expires <= ?').run(Date.now());
  } catch (error) {
    console.error('Could not clean up expired sessions and invitations:', error);
  }
}, 60 * 60 * 1000);
cleanupInterval.unref();

const port = Number.parseInt(process.env.PORT || '3000', 10);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
httpServer.listen(port, host, () => {
  console.log(`Orbit is running at http://${host}:${port}`);
  console.log(`SQLite chat data: ${path.join(dataDirectory, 'orbit.sqlite')}`);
  if (host === '127.0.0.1' || host === 'localhost') {
    console.log('This local-only address is private. Configure hosting and HTTPS before sharing Orbit outside this computer.');
  }
});

function shutdown() {
  httpServer.close((error) => {
    database.close();
    if (error) {
      console.error('Error while shutting down Orbit:', error);
      process.exitCode = 1;
    }
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
