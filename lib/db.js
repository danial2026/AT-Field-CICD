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
      status_token TEXT,
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
      poll_enabled INTEGER NOT NULL DEFAULT 0,
      poll_branch TEXT,
      last_commit_sha TEXT,
      last_polled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(full_name, provider)
    );

    CREATE TABLE IF NOT EXISTS repo_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      keyword TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('script', 'deploy')),
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(repo_id, keyword)
    );

    CREATE TABLE IF NOT EXISTS job_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      repo_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
      repo_name TEXT,
      keyword TEXT NOT NULL,
      type TEXT NOT NULL,
      trigger TEXT,
      status TEXT NOT NULL
        CHECK(status IN ('running', 'success', 'fail', 'timeout')),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER,
      exit_code INTEGER,
      log_file TEXT
    );

    CREATE TABLE IF NOT EXISTS deploy_machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      ssh_user TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22,
      ssh_key TEXT,
      ssh_options TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ssh_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      key_data TEXT NOT NULL,
      fingerprint TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL
        CHECK(type IN ('discord', 'slack', 'telegram', 'pushover', 'gotify', 'ntfy', 'generic')),
      config TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_repos_full_name ON repos(full_name);
    CREATE INDEX IF NOT EXISTS idx_repo_actions_repo ON repo_actions(repo_id);
    CREATE INDEX IF NOT EXISTS idx_job_runs_started ON job_runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_job_runs_repo ON job_runs(repo_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
  `);
  return db;
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
    INSERT INTO users (username, password_hash, role, status_token, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(username, hashPassword(password), role, randomToken(24), t, t);
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

// Global settings (key/value)

function getSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setSettings(obj) {
  const upsert = getDb().prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const ts = now();
  for (const [key, value] of Object.entries(obj)) {
    upsert.run(key, JSON.stringify(value), ts);
  }
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
    user_id: row.user_id,
    keyword: row.keyword,
    type: row.type,
    enabled: !!row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...safeJson(row.config),
  };
}

function upsertRepoAction(repoId, keyword, type, config, enabled = 1, ownerId = null) {
  const t = now();
  const existing = getDb().prepare(
    'SELECT id FROM repo_actions WHERE repo_id = ? AND keyword = ? COLLATE NOCASE'
  ).get(repoId, keyword);

  const cfg = JSON.stringify(config);
  if (existing) {
    getDb().prepare(`
      UPDATE repo_actions SET type = ?, config = ?, enabled = ?, user_id = ?, updated_at = ?
      WHERE id = ?
    `).run(type, cfg, enabled ? 1 : 0, ownerId, t, existing.id);
    return getRepoAction(repoId, keyword);
  }

  getDb().prepare(`
    INSERT INTO repo_actions (repo_id, user_id, keyword, type, config, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(repoId, ownerId, keyword, type, cfg, enabled ? 1 : 0, t, t);
  return getRepoAction(repoId, keyword);
}

function deleteRepoAction(repoId, keyword) {
  const info = getDb().prepare(
    'DELETE FROM repo_actions WHERE repo_id = ? AND keyword = ? COLLATE NOCASE'
  ).run(repoId, keyword);
  return info.changes > 0;
}

// Job runs (run history for charts)

function recordJobStart({ jobId, repoId, repoName, keyword, type, trigger, logFile }) {
  const info = getDb().prepare(`
    INSERT INTO job_runs (job_id, repo_id, repo_name, keyword, type, trigger, status, started_at, log_file)
    VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(jobId, repoId || null, repoName || null, keyword, type, trigger || null, now(), logFile || null);
  return info.lastInsertRowid;
}

function recordJobFinish(runId, { status, durationMs, exitCode }) {
  getDb().prepare(`
    UPDATE job_runs
    SET status = ?, finished_at = ?, duration_ms = ?, exit_code = ?
    WHERE id = ?
  `).run(status, now(), durationMs != null ? Math.round(durationMs) : null, exitCode != null ? exitCode : null, runId);
}

function listRecentRuns({ limit = 10 } = {}) {
  return getDb().prepare(`
    SELECT id, job_id, repo_name, keyword, type, trigger, status, started_at, finished_at, duration_ms, exit_code, log_file
    FROM job_runs ORDER BY id DESC LIMIT ?
  `).all(Math.min(limit, 100));
}

function getRunById(id) {
  return getDb().prepare(`
    SELECT id, job_id, repo_id, repo_name, keyword, type, trigger, status, started_at, finished_at, duration_ms, exit_code, log_file
    FROM job_runs WHERE id = ?
  `).get(id);
}

function getStats({ days = 14 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const daysN = Math.max(1, Math.min(parseInt(days, 10) || 14, 90));

  const perDay = getDb().prepare(`
    SELECT substr(started_at, 1, 10) AS day,
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
           SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) AS timeouts,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
    FROM job_runs WHERE started_at >= ?
    GROUP BY day ORDER BY day ASC
  `).all(since);

  const byKeyword = getDb().prepare(`
    SELECT keyword,
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
           SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) AS failed,
           ROUND(AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms ELSE 0 END)) AS avg_duration_ms
    FROM job_runs WHERE started_at >= ?
    GROUP BY keyword ORDER BY total DESC LIMIT 12
  `).all(since);

  const byType = getDb().prepare(`
    SELECT type,
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
           SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) AS timeouts
    FROM job_runs WHERE started_at >= ?
    GROUP BY type
  `).all(since);

  const byTrigger = getDb().prepare(`
    SELECT COALESCE(trigger, 'unknown') AS trigger, COUNT(*) AS total
    FROM job_runs WHERE started_at >= ?
    GROUP BY trigger
  `).all(since);

  const overview = getDb().prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success,
           COALESCE(SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END), 0) AS failed,
           COALESCE(SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END), 0) AS timeouts,
           COALESCE(ROUND(AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms ELSE 0 END)), 0) AS avg_duration_ms,
           COALESCE(SUM(CASE WHEN type = 'deploy' THEN 1 ELSE 0 END), 0) AS deploys
    FROM job_runs WHERE started_at >= ?
  `).get(since);

  const webhookCalls = getDb().prepare(`
    SELECT COUNT(*) AS calls FROM audit_log
    WHERE action IN ('webhook_queued', 'webhook_no_match', 'webhook_ignored') AND created_at >= ?
  `).get(since);

  // Fill missing days with zeros
  const filled = [];
  const map = new Map(perDay.map(r => [r.day, r]));
  for (let i = daysN - 1; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    filled.push(map.get(d) || { day: d, total: 0, success: 0, failed: 0, timeouts: 0, running: 0 });
  }

  return {
    days: daysN,
    overview: {
      ...(overview || { total: 0, success: 0, failed: 0, timeouts: 0, avg_duration_ms: 0, deploys: 0 }),
      webhook_calls: webhookCalls?.calls || 0,
    },
    per_day: filled,
    by_keyword: byKeyword,
    by_type: byType,
    by_trigger: byTrigger,
  };
}

// Deployment machines

function parseMachineRow(row) {
  return {
    id: row.id,
    name: row.name,
    ssh_user: row.ssh_user,
    host: row.host,
    port: row.port ?? 22,
    ssh_key: row.ssh_key || '',
    ssh_options: row.ssh_options || '',
    has_ssh_key: !!(row.ssh_key && String(row.ssh_key).length),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createDeployMachine({ name, ssh_user, host, port = 22, ssh_key, ssh_options }) {
  const t = now();
  const info = getDb().prepare(`
    INSERT INTO deploy_machines (name, ssh_user, host, port, ssh_key, ssh_options, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(name).trim().slice(0, 100),
    String(ssh_user).trim().slice(0, 100),
    String(host).trim().slice(0, 255),
    Number.isInteger(port) && port > 0 ? port : 22,
    ssh_key ? String(ssh_key).trim().slice(0, 100) : null,
    ssh_options ? String(ssh_options).trim().slice(0, 2000) : null,
    t,
    t
  );
  return getDeployMachineById(info.lastInsertRowid);
}

function getDeployMachineById(id) {
  const row = getDb().prepare('SELECT * FROM deploy_machines WHERE id = ?').get(id);
  return row ? parseMachineRow(row) : null;
}

function getDeployMachinesByIds(ids) {
  const list = (ids || []).map(Number).filter(Number.isInteger);
  if (!list.length) return [];
  const placeholders = list.map(() => '?').join(',');
  return getDb().prepare(
    `SELECT * FROM deploy_machines WHERE id IN (${placeholders}) ORDER BY name`
  ).all(...list).map(parseMachineRow);
}

function listDeployMachines() {
  return getDb().prepare(
    'SELECT * FROM deploy_machines ORDER BY name COLLATE NOCASE'
  ).all().map(parseMachineRow);
}

function updateDeployMachine(id, fields) {
  const allowed = ['name', 'ssh_user', 'host', 'ssh_key', 'ssh_options'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] === undefined) continue;
    sets.push(`${k} = ?`);
    const v = String(fields[k]).trim().slice(0, k === 'ssh_key' ? 100 : k === 'ssh_options' ? 2000 : k === 'host' ? 255 : 100);
    vals.push(v === '' ? null : v);
  }
  if (fields.port !== undefined) {
    const port = Number(fields.port);
    sets.push('port = ?');
    vals.push(Number.isInteger(port) && port > 0 ? port : 22);
  }
  if (!sets.length) return getDeployMachineById(id);
  sets.push('updated_at = ?');
  vals.push(now(), id);
  getDb().prepare(`UPDATE deploy_machines SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getDeployMachineById(id);
}

function deleteDeployMachine(id) {
  const info = getDb().prepare('DELETE FROM deploy_machines WHERE id = ?').run(id);
  return info.changes > 0;
}

// Count actions that reference a machine id inside their config JSON
function countActionUsesForMachine(machineId) {
  const rows = getDb().prepare(
    'SELECT config FROM repo_actions'
  ).all();
  let count = 0;
  for (const r of rows) {
    try {
      const cfg = safeJson(r.config);
      if (Array.isArray(cfg?.machine_ids) && cfg.machine_ids.includes(machineId)) count += 1;
    } catch { /* ignore */ }
  }
  return count;
}

// SSH keys (stored encrypted at rest; only name/fingerprint leave the DB)

function parseSshKeyRow(row) {
  return {
    id: row.id,
    name: row.name,
    fingerprint: row.fingerprint || '',
    machine_uses: row.machine_uses ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createSshKey({ name, key_data, fingerprint }) {
  const t = now();
  const info = getDb().prepare(`
    INSERT INTO ssh_keys (name, key_data, fingerprint, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    String(name).trim().slice(0, 100),
    key_data,
    fingerprint || null,
    t,
    t
  );
  return getSshKeyById(info.lastInsertRowid);
}

function getSshKeyById(id) {
  const row = getDb().prepare('SELECT * FROM ssh_keys WHERE id = ?').get(id);
  return row ? parseSshKeyRow(row) : null;
}

function getSshKeyByName(name) {
  return getDb().prepare('SELECT * FROM ssh_keys WHERE name = ? COLLATE NOCASE').get(name) || null;
}

function listSshKeys() {
  return getDb().prepare(`
    SELECT k.*, (SELECT COUNT(*) FROM deploy_machines m WHERE m.ssh_key = k.name) AS machine_uses
    FROM ssh_keys k ORDER BY name COLLATE NOCASE
  `).all().map(parseSshKeyRow);
}

function countMachineUsesForKey(name) {
  return getDb().prepare(
    'SELECT COUNT(*) AS c FROM deploy_machines WHERE ssh_key = ? COLLATE NOCASE'
  ).get(name).c;
}

function deleteSshKey(id) {
  const info = getDb().prepare('DELETE FROM ssh_keys WHERE id = ?').run(id);
  return info.changes > 0;
}

// Notifications (per user)

const NOTIFICATION_TYPES = ['discord', 'slack', 'telegram', 'pushover', 'gotify', 'ntfy', 'generic'];
const NOTIFICATION_EVENTS = ['job_start', 'job_success', 'job_failure', 'job_timeout', 'poll_error'];

function parseNotificationRow(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    type: row.type,
    enabled: !!row.enabled,
    events: safeJson(row.events),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...safeJson(row.config),
  };
}

function listNotifications(userId) {
  return getDb().prepare(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY name'
  ).all(userId).map(parseNotificationRow);
}

function getNotification(id, userId) {
  const row = getDb().prepare(
    'SELECT * FROM notifications WHERE id = ? AND user_id = ?'
  ).get(id, userId);
  return row ? parseNotificationRow(row) : null;
}

function createNotification({ userId, name, type, config, events = [], enabled = 1 }) {
  const t = now();
  const info = getDb().prepare(`
    INSERT INTO notifications (user_id, name, type, config, events, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    String(name).slice(0, 100),
    type,
    JSON.stringify(config || {}),
    JSON.stringify(events),
    enabled ? 1 : 0,
    t,
    t
  );
  return getNotification(info.lastInsertRowid, userId);
}

function updateNotification(id, userId, fields) {
  const allowed = ['name', 'type', 'config', 'events', 'enabled'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] === undefined) continue;
    sets.push(`${k} = ?`);
    if (k === 'config') vals.push(JSON.stringify(fields[k] || {}));
    else if (k === 'events') vals.push(JSON.stringify(fields[k] || []));
    else if (k === 'enabled') vals.push(fields[k] ? 1 : 0);
    else vals.push(String(fields[k]).slice(0, 100));
  }
  if (!sets.length) return getNotification(id, userId);
  sets.push('updated_at = ?');
  vals.push(now(), id, userId);
  getDb().prepare(`UPDATE notifications SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals);
  return getNotification(id, userId);
}

function deleteNotification(id, userId) {
  const info = getDb().prepare(
    'DELETE FROM notifications WHERE id = ? AND user_id = ?'
  ).run(id, userId);
  return info.changes > 0;
}

// Users: status token for external status webhook

function getUserByStatusToken(token) {
  return getDb().prepare(
    'SELECT id, username, role, status_token FROM users WHERE status_token = ?'
  ).get(token) || null;
}

function getStatusToken(userId) {
  const row = getDb().prepare('SELECT status_token FROM users WHERE id = ?').get(userId);
  return row?.status_token || null;
}

function rotateStatusToken(userId) {
  const token = randomToken(24);
  getDb().prepare('UPDATE users SET status_token = ?, updated_at = ? WHERE id = ?')
    .run(token, now(), userId);
  return token;
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
  // deploy machines
  createDeployMachine,
  getDeployMachineById,
  getDeployMachinesByIds,
  listDeployMachines,
  updateDeployMachine,
  deleteDeployMachine,
  countActionUsesForMachine,
  // ssh keys
  createSshKey,
  getSshKeyById,
  getSshKeyByName,
  listSshKeys,
  countMachineUsesForKey,
  deleteSshKey,
  // job runs
  recordJobStart,
  getRunById,
  recordJobFinish,
  listRecentRuns,
  getStats,
  // notifications
  NOTIFICATION_TYPES,
  NOTIFICATION_EVENTS,
  listNotifications,
  getNotification,
  createNotification,
  updateNotification,
  deleteNotification,
  // status token
  getUserByStatusToken,
  getStatusToken,
  rotateStatusToken,
  // settings
  getSettings,
  getSetting,
  setSettings,
  // bootstrap
  bootstrapAdmin,
};
