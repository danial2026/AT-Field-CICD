'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'at-field-ci.db');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

let db;

function now() {
  return new Date().toISOString();
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, s, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }).toString('hex');
  return `${s}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function init() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'developer' CHECK(role IN ('admin', 'devops', 'developer')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      action TEXT NOT NULL,
      details TEXT,
      ip TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'github'
        CHECK(provider IN ('github', 'gitea', 'forgejo', 'gitlab', 'generic')),
      webhook_secret TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      git_username TEXT,
      git_token TEXT,
      clone_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(full_name, provider)
    );

    CREATE TABLE IF NOT EXISTS repo_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      keyword TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('script', 'deploy')),
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(repo_id, keyword)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_repos_full_name ON repos(full_name);
    CREATE INDEX IF NOT EXISTS idx_repo_actions_repo ON repo_actions(repo_id);
  `);

  // Lightweight migrations for existing DBs
  const cols = db.prepare('PRAGMA table_info(repos)').all().map(c => c.name);
  const addCol = (name, type) => {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE repos ADD COLUMN ${name} ${type}`);
    }
  };
  addCol('git_username', 'TEXT');
  addCol('git_token', 'TEXT');
  addCol('clone_url', 'TEXT');
  addCol('poll_enabled', 'INTEGER NOT NULL DEFAULT 0');
  addCol('poll_branch', 'TEXT');
  addCol('last_commit_sha', 'TEXT');
  addCol('last_polled_at', 'TEXT');

  migrateUserRoles();

  return db;
}

function migrateUserRoles() {
  const row = getDb().prepare(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='users'"
  ).get();
  if (!row || !row.sql) return;
  // Already on the new role set?
  if (row.sql.includes("'devops'") && row.sql.includes("'developer'")) return;

  console.log('[DB] Migrating users table roles -> admin/devops/developer');
  getDb().pragma('foreign_keys = OFF');
  try {
    getDb().exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'developer' CHECK(role IN ('admin', 'devops', 'developer')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO users_new (id, username, password_hash, role, created_at, updated_at)
        SELECT id, username, password_hash,
          CASE role
            WHEN 'admin' THEN 'admin'
            WHEN 'user' THEN 'developer'
            ELSE 'developer'
          END,
          created_at, updated_at
        FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
  } finally {
    getDb().pragma('foreign_keys = ON');
  }
  console.log('[DB] users table roles migrated');
}

function getDb() {
  if (!db) init();
  return db;
}

// Users

function countUsers() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

function createUser(username, password, role = 'developer') {
  const t = now();
  const info = getDb().prepare(`
    INSERT INTO users (username, password_hash, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(username, hashPassword(password), role, t, t);
  return getUserById(info.lastInsertRowid);
}

function getUserById(id) {
  return getDb().prepare(
    'SELECT id, username, role, created_at, updated_at FROM users WHERE id = ?'
  ).get(id) || null;
}

function getUserByUsername(username) {
  return getDb().prepare(
    'SELECT * FROM users WHERE username = ? COLLATE NOCASE'
  ).get(username) || null;
}

function listUsers() {
  return getDb().prepare(
    'SELECT id, username, role, created_at, updated_at FROM users ORDER BY username'
  ).all();
}

function updateUserPassword(id, password) {
  getDb().prepare(
    'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?'
  ).run(hashPassword(password), now(), id);
}

function updateUserRole(id, role) {
  getDb().prepare(
    'UPDATE users SET role = ?, updated_at = ? WHERE id = ?'
  ).run(role, now(), id);
}

function deleteUser(id) {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
}

function authenticateUser(username, password) {
  const user = getUserByUsername(username);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return { id: user.id, username: user.username, role: user.role };
}

// Sessions

function createSession(userId) {
  const token = randomToken(32);
  const t = now();
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  getDb().prepare(`
    INSERT INTO sessions (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(token, userId, expires, t);
  return { token, expires_at: expires };
}

function getSessionUser(token) {
  if (!token) return null;
  const row = getDb().prepare(`
    SELECT u.id, u.username, u.role, s.expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    deleteSession(token);
    return null;
  }
  return { id: row.id, username: row.username, role: row.role };
}

function deleteSession(token) {
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function deleteUserSessions(userId) {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function purgeExpiredSessions() {
  getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
}

// Audit

function audit(user, action, details, ip) {
  getDb().prepare(`
    INSERT INTO audit_log (user_id, username, action, details, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    user?.id ?? null,
    user?.username ?? null,
    action,
    details != null ? JSON.stringify(details) : null,
    ip || null,
    now()
  );
}

function listAudit({ limit = 100, offset = 0 } = {}) {
  const rows = getDb().prepare(`
    SELECT id, user_id, username, action, details, ip, created_at
    FROM audit_log
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(Math.min(limit, 500), offset);
  return rows.map(r => ({
    ...r,
    details: r.details ? safeJson(r.details) : null,
  }));
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}

// Repos

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || randomToken(4);
}

function uniqueSlug(base) {
  let slug = slugify(base);
  let n = 0;
  while (getDb().prepare('SELECT 1 FROM repos WHERE slug = ?').get(slug)) {
    n += 1;
    slug = `${slugify(base)}-${n}`;
  }
  return slug;
}

function createRepo({
  name,
  full_name,
  provider,
  webhook_secret,
  enabled = 1,
  git_username = null,
  git_token = null,
  clone_url = null,
  poll_enabled = 0,
  poll_branch = null,
}) {
  const t = now();
  const slug = uniqueSlug(full_name || name);
  const info = getDb().prepare(`
    INSERT INTO repos (
      name, full_name, provider, webhook_secret, slug, enabled,
      git_username, git_token, clone_url,
      poll_enabled, poll_branch,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    full_name,
    provider,
    webhook_secret,
    slug,
    enabled ? 1 : 0,
    git_username || null,
    git_token || null,
    clone_url || null,
    poll_enabled ? 1 : 0,
    poll_branch || null,
    t,
    t
  );
  return getRepoById(info.lastInsertRowid);
}

function getRepoById(id) {
  return getDb().prepare('SELECT * FROM repos WHERE id = ?').get(id) || null;
}

function getRepoBySlug(slug) {
  return getDb().prepare('SELECT * FROM repos WHERE slug = ?').get(slug) || null;
}

function findRepos(fullName, provider) {
  if (provider) {
    return getDb().prepare(
      'SELECT * FROM repos WHERE full_name = ? COLLATE NOCASE AND provider = ? AND enabled = 1'
    ).all(fullName, provider);
  }
  return getDb().prepare(
    'SELECT * FROM repos WHERE full_name = ? COLLATE NOCASE AND enabled = 1'
  ).all(fullName);
}

function listRepos() {
  return getDb().prepare('SELECT * FROM repos ORDER BY name').all();
}

function updateRepo(id, fields) {
  const allowed = [
    'name', 'full_name', 'provider', 'webhook_secret', 'enabled',
    'git_username', 'git_token', 'clone_url',
    'poll_enabled', 'poll_branch', 'last_commit_sha', 'last_polled_at',
  ];
  const boolCols = new Set(['enabled', 'poll_enabled']);
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      if (boolCols.has(k)) vals.push(fields[k] ? 1 : 0);
      else if (fields[k] === '') vals.push(null);
      else vals.push(fields[k]);
    }
  }
  if (!sets.length) return getRepoById(id);
  sets.push('updated_at = ?');
  vals.push(now(), id);
  getDb().prepare(`UPDATE repos SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getRepoById(id);
}

function listPollRepos() {
  return getDb().prepare(
    'SELECT * FROM repos WHERE enabled = 1 AND poll_enabled = 1 ORDER BY id'
  ).all();
}

function setRepoPollCursor(id, { last_commit_sha, last_polled_at }) {
  const t = last_polled_at || now();
  getDb().prepare(`
    UPDATE repos
    SET last_commit_sha = COALESCE(?, last_commit_sha),
        last_polled_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(last_commit_sha || null, t, now(), id);
  return getRepoById(id);
}

function deleteRepo(id) {
  getDb().prepare('DELETE FROM repos WHERE id = ?').run(id);
}

// Repo actions

function listRepoActions(repoId) {
  const rows = getDb().prepare(
    'SELECT * FROM repo_actions WHERE repo_id = ? ORDER BY keyword'
  ).all(repoId);
  return rows.map(parseActionRow);
}

function getRepoAction(repoId, keyword) {
  const row = getDb().prepare(
    'SELECT * FROM repo_actions WHERE repo_id = ? AND keyword = ? COLLATE NOCASE'
  ).get(repoId, keyword);
  return row ? parseActionRow(row) : null;
}

function getEnabledActions(repoId) {
  const rows = getDb().prepare(
    'SELECT * FROM repo_actions WHERE repo_id = ? AND enabled = 1'
  ).all(repoId);
  return rows.map(parseActionRow);
}

function parseActionRow(row) {
  return {
    id: row.id,
    repo_id: row.repo_id,
    keyword: row.keyword,
    type: row.type,
    enabled: !!row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...safeJson(row.config),
  };
}

function upsertRepoAction(repoId, keyword, type, config, enabled = 1) {
  const t = now();
  const existing = getDb().prepare(
    'SELECT id FROM repo_actions WHERE repo_id = ? AND keyword = ? COLLATE NOCASE'
  ).get(repoId, keyword);

  const cfg = JSON.stringify(config);
  if (existing) {
    getDb().prepare(`
      UPDATE repo_actions SET type = ?, config = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(type, cfg, enabled ? 1 : 0, t, existing.id);
    return getRepoAction(repoId, keyword);
  }

  getDb().prepare(`
    INSERT INTO repo_actions (repo_id, keyword, type, config, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(repoId, keyword, type, cfg, enabled ? 1 : 0, t, t);
  return getRepoAction(repoId, keyword);
}

function deleteRepoAction(repoId, keyword) {
  const info = getDb().prepare(
    'DELETE FROM repo_actions WHERE repo_id = ? AND keyword = ? COLLATE NOCASE'
  ).run(repoId, keyword);
  return info.changes > 0;
}

function migrateFromYaml(actions) {
  if (!actions || typeof actions !== 'object') return null;
  const keys = Object.keys(actions);
  if (!keys.length) return null;
  if (listRepos().length > 0) return null;

  const secret = process.env.WEBHOOK_SECRET || randomToken(24);
  const repo = createRepo({
    name: 'Migrated (legacy config.yaml)',
    full_name: 'legacy/migrated',
    provider: 'github',
    webhook_secret: secret,
    enabled: 1,
  });

  for (const [keyword, action] of Object.entries(actions)) {
    if (!action || !action.type) continue;
    const { type, ...rest } = action;
    upsertRepoAction(repo.id, keyword, type, rest, 1);
  }
  return repo;
}

function bootstrapAdmin(username, password) {
  if (countUsers() > 0) return null;
  if (!username || !password) {
    console.warn('[DB] No users and no ADMIN_USER/ADMIN_PASSWORD - create one via env on first boot');
    return null;
  }
  return createUser(username, password, 'admin');
}

module.exports = {
  init,
  getDb,
  DB_PATH,
  hashPassword,
  verifyPassword,
  randomToken,
  // users
  countUsers,
  createUser,
  getUserById,
  getUserByUsername,
  listUsers,
  updateUserPassword,
  updateUserRole,
  deleteUser,
  authenticateUser,
  // sessions
  createSession,
  getSessionUser,
  deleteSession,
  deleteUserSessions,
  purgeExpiredSessions,
  SESSION_TTL_MS,
  // audit
  audit,
  listAudit,
  // repos
  createRepo,
  getRepoById,
  getRepoBySlug,
  findRepos,
  listRepos,
  listPollRepos,
  updateRepo,
  setRepoPollCursor,
  deleteRepo,
  // actions
  listRepoActions,
  getRepoAction,
  getEnabledActions,
  upsertRepoAction,
  deleteRepoAction,
  // bootstrap
  migrateFromYaml,
  bootstrapAdmin,
};
