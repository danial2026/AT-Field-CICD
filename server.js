#!/usr/bin/env node
'use strict';

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
const db = require('./lib/db');
const poller = require('./lib/poller');
const notify = require('./lib/notify');
const APP_VERSION = require('./package.json').version || '0.0.0';

console.log(`
   █████████   ███████████    ███████████  ███           ████      █████      █████████  █████
  ███▒▒▒▒▒███ ▒█▒▒▒███▒▒▒█   ▒▒███▒▒▒▒▒▒█ ▒▒▒           ▒▒███     ▒▒███      ███▒▒▒▒▒███▒▒███ 
 ▒███    ▒███ ▒   ▒███  ▒     ▒███   █ ▒  ████   ██████  ▒███   ███████     ███     ▒▒▒  ▒███ 
 ▒███████████     ▒███        ▒███████   ▒▒███  ███▒▒███ ▒███  ███▒▒███    ▒███          ▒███ 
 ▒███▒▒▒▒▒███     ▒███        ▒███▒▒▒█    ▒███ ▒███████  ▒███ ▒███ ▒███    ▒███          ▒███ 
 ▒███    ▒███     ▒███        ▒███  ▒     ▒███ ▒███▒▒▒   ▒███ ▒███ ▒███    ▒▒███     ███ ▒███ 
 █████   █████    █████       █████       █████▒▒██████  █████▒▒████████    ▒▒█████████  █████
▒▒▒▒▒   ▒▒▒▒▒    ▒▒▒▒▒       ▒▒▒▒▒       ▒▒▒▒▒  ▒▒▒▒▒▒  ▒▒▒▒▒  ▒▒▒▒▒▒▒▒      ▒▒▒▒▒▒▒▒▒  ▒▒▒▒▒ 
`);

// CONFIG

const PORT = process.env.PORT || 3000;
// Runtime settings (editable by staff in Global Settings); env only sets
// the boot default. POLL_INTERVAL_MS stays mutable via schedulePoll().
const SETTINGS_DEFAULTS = {
  app_url: '',
  poll_interval_ms: Math.max(15_000, parseInt(process.env.POLL_INTERVAL_MS || '60000', 10) || 60_000),
  max_active_jobs: 1,
  script_timeout_ms: 30 * 60 * 1000,
  rsync_timeout_ms: 60 * 60 * 1000,
  ssh_timeout_ms: 30 * 60 * 1000,
  log_retention_days: 0,
  maintenance_mode: false,
};
const SETTING_RULES = {
  app_url: 'url',
  poll_interval_ms: { int: true, min: 15_000, max: 3_600_000 },
  max_active_jobs: { int: true, min: 1, max: 10 },
  script_timeout_ms: { int: true, min: 60_000, max: 86_400_000 },
  rsync_timeout_ms: { int: true, min: 60_000, max: 86_400_000 },
  ssh_timeout_ms: { int: true, min: 60_000, max: 86_400_000 },
  log_retention_days: { int: true, min: 0, max: 3650 },
  maintenance_mode: 'bool',
};

function getSettings() {
  return { ...SETTINGS_DEFAULTS, ...db.getSettings() };
}

function getSetting(key) {
  const v = db.getSetting(key);
  return v === undefined ? SETTINGS_DEFAULTS[key] : v;
}

// Encryption-at-rest for SSH keys uploaded via the dashboard.
// Master key: MASTER_KEY env (64 hex chars) or auto-generated data/master.key.

const DATA_DIR = path.join(__dirname, 'data');
const MASTER_KEY_FILE = process.env.MASTER_KEY_FILE || path.join(DATA_DIR, 'master.key');

let cachedMasterKey = null;

function getMasterKey() {
  if (cachedMasterKey) return cachedMasterKey;
  if (process.env.MASTER_KEY) {
    const hex = String(process.env.MASTER_KEY).replace(/^0x/i, '').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('MASTER_KEY must be 64 hex chars (32 bytes)');
    }
    cachedMasterKey = Buffer.from(hex, 'hex');
  } else {
    if (!fs.existsSync(MASTER_KEY_FILE)) {
      fs.mkdirSync(path.dirname(MASTER_KEY_FILE), { recursive: true });
      fs.writeFileSync(MASTER_KEY_FILE, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    }
    cachedMasterKey = crypto.createHash('sha256').update(fs.readFileSync(MASTER_KEY_FILE, 'utf8').trim()).digest();
  }
  return cachedMasterKey;
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, ct]).toString('base64');
}

function decryptSecret(blob) {
  if (typeof blob !== 'string' || !blob.startsWith('enc:')) return null;
  try {
    const buf = Buffer.from(blob.slice(4), 'base64');
    if (buf.length < 12 + 16) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function maintenanceMode() {
  return getSetting('maintenance_mode') === true;
}

function sanitizeSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Invalid settings payload' };
  }
  const clean = {};
  for (const [key, rule] of Object.entries(SETTING_RULES)) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (rule === 'bool') {
      if (typeof raw !== 'boolean') return { error: `Invalid value for ${key}` };
      clean[key] = raw;
    } else if (rule === 'url') {
      if (typeof raw !== 'string') return { error: `Invalid value for ${key}` };
      const v = raw.trim().replace(/\/+$/, '');
      if (v) {
        try {
          const u = new URL(v);
          if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
        } catch {
          return { error: `${key} must be a valid http(s) URL` };
        }
      }
      clean[key] = v;
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < rule.min || n > rule.max) {
        return { error: `${key} must be an integer between ${rule.min} and ${rule.max}` };
      }
      clean[key] = n;
    }
  }
  return { clean };
}

const COOKIE_NAME = 'ci_session';
// Only set Secure cookies when explicitly enabled (requires HTTPS)
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const ADMIN_USER = process.env.ADMIN_USER || process.env.DASHBOARD_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.DASHBOARD_PASSWORD || '';

const LOGS_DIR = path.join(__dirname, 'logs');
const SCRIPTS_DIR = path.join(__dirname, 'scripts');

const MAX_LOG_FILES = 200;
const MAX_KEYWORD_LENGTH = 100;
const MAX_SCRIPT_NAME_LENGTH = 100;
const MAX_LOG_VIEW_SIZE = 1000000;
const AUTH_RATE_LIMIT = 5;
const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;

const PROVIDERS = ['github', 'gitea', 'forgejo', 'gitlab', 'generic'];

[LOGS_DIR, SCRIPTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// BOOTSTRAP DB

db.init();
db.purgeExpiredSessions();

const bootUser = db.bootstrapAdmin(ADMIN_USER, ADMIN_PASSWORD || 'admin');
if (bootUser) {
  console.log(`[DB] Created bootstrap admin user: ${bootUser.username}`);
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD === 'admin') {
    console.warn('[DB] WARNING: Using default admin password - set ADMIN_PASSWORD in .env');
  }
}

// STATE

let jobQueue = [];
const failedAuthAttempts = new Map();
const pollInFlight = new Set();
let lastPollCycleAt = null;
let lastPollCycleSummary = null;

// UTILS

function clientIp(req) {
  return (
    req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function normalizeScriptPath(script) {
  if (typeof script !== 'string') return null;
  let normalized = script.replace(/^\.\//, '');
  if (normalized.startsWith('scripts/')) normalized = normalized.slice('scripts/'.length);
  if (normalized.includes('..') || normalized.startsWith('/') || normalized.includes('\\')) return null;
  if (!normalized.endsWith('.sh')) normalized += '.sh';
  if (normalized.includes('/')) return null;
  return normalized;
}

function isValidKeyword(keyword) {
  if (typeof keyword !== 'string') return false;
  if (keyword.length === 0 || keyword.length > MAX_KEYWORD_LENGTH) return false;
  return /^[A-Z0-9_]+$/i.test(keyword);
}

function isValidScriptName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > MAX_SCRIPT_NAME_LENGTH) return false;
  if (name.includes('/') || name.includes('..') || name.includes('\\')) return false;
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

function isValidUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_.-]{2,64}$/.test(u);
}

function isValidFullName(n) {
  return typeof n === 'string' && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(n) && n.length <= 200;
}

function sanitizeLogFileName(str) {
  return String(str).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 80);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function setSessionCookie(res, token, expiresAt) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(db.SESSION_TTL_MS / 1000)}`,
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  if (expiresAt) parts.push(`Expires=${new Date(expiresAt).toUTCString()}`);
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hmacHex(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// NOTIFICATIONS

const NOTIFY_EVENT_LABELS = {
  job_start: 'Job started',
  job_success: 'Job succeeded',
  job_failure: 'Job failed',
  job_timeout: 'Job timed out',
  poll_error: 'Poll error',
};

/** Send a message to every enabled notification target of a user that subscribes to `event`. */
async function notifyUser(userId, event, payload) {
  const targets = db.listNotifications(userId).filter(t =>
    t.enabled && Array.isArray(t.events) && t.events.includes(event)
  );
  if (!targets.length) return { sent: 0 };

  const message = [
    payload.message,
    payload.repo ? `Repo: ${payload.repo}` : null,
    payload.keyword ? `Keyword: ${payload.keyword}` : null,
    payload.duration ? `Duration: ${payload.duration}` : null,
  ].filter(Boolean).join('\n');

  let sent = 0;
  const results = await Promise.allSettled(targets.map(async target => {
    await notify.send(target, {
      title: `${NOTIFY_EVENT_LABELS[event] || event} - ${payload.title || 'AT FIELD CICD'}`,
      message,
      ok: event !== 'job_failure' && event !== 'job_timeout' && event !== 'poll_error',
      event,
      ...payload,
    });
    sent += 1;
  }));

  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length) {
    console.warn('[NOTIFY]', event, 'failed targets:', failed.map(r => r.reason?.message || 'error').join('; '));
  }
  return { sent, failed: failed.length };
}

function notifyJobEvent(userId, event, job, extra = {}) {
  if (!userId) return;
  const status = event === 'job_success' ? 'success'
    : event === 'job_failure' ? 'fail'
    : event === 'job_timeout' ? 'timeout' : 'start';
  const repo = job.repo_id ? db.getRepoById(job.repo_id) : null;
  notifyUser(userId, event, {
    title: `${job.name} ${event.replace('job_', '')}`,
    repo: job.repo,
    repo_slug: repo ? repo.slug : null,
    keyword: job.name,
    type: job.type || null,
    commit: job.commit || null,
    trigger: job.trigger || null,
    status,
    ...extra,
  }).catch(err => console.warn('[NOTIFY]', event, err.message));
}

/** Broadcast a job event to every user's subscribed notification targets. */
function notifyAllUsers(event, job, extra = {}) {
  for (const u of db.listUsers()) {
    notifyJobEvent(u.id, event, job, extra);
  }
}

function notifyPollError(repo, error) {
  for (const u of db.listUsers()) {
    notifyUser(u.id, 'poll_error', {
      title: `Poll error - ${repo.full_name}`,
      message: `Commit polling failed for ${repo.full_name}: ${error}`,
      repo: repo.full_name,
      ok: false,
      event: 'poll_error',
    }).catch(err => console.warn('[NOTIFY] poll_error', err.message));
  }
}

// Send job notifications to the targets explicitly selected on an action.
// Independent of each target's "Notify on events" subscriptions - any target
// that is simply *enabled* receives the action-linked notification.
async function sendActionNotifications(job, extra = {}) {
  const action = job.action || {};
  const ids = Array.isArray(action.notification_target_ids) ? action.notification_target_ids : [];
  if (!ids.length) return { sent: 0 };
  const ownerId = action.user_id;
  if (!ownerId) return { sent: 0 };

  const targets = ids
    .map(id => db.getNotification(id, ownerId))
    .filter(Boolean)
    .filter(t => t.enabled);
  if (!targets.length) return { sent: 0 };

  const status = extra.status || 'success';
  const repo = job.repo_id ? db.getRepoById(job.repo_id) : null;
  const message = [
    `Job ${status}`,
    job.repo ? `Repo: ${job.repo}` : null,
    job.name ? `Keyword: ${job.name}` : null,
    extra.duration ? `Duration: ${extra.duration}` : null,
  ].filter(Boolean).join('\n');

  const payload = {
    title: `${job.name} ${status}`,
    message,
    ok: status === 'success',
    event: 'action_notify',
    repo: job.repo,
    repo_slug: repo ? repo.slug : null,
    keyword: job.name,
    type: job.type || null,
    commit: job.commit || null,
    trigger: job.trigger || null,
    status,
    ...extra,
  };

  let sent = 0;
  const results = await Promise.allSettled(targets.map(async target => {
    const t = { ...target, config: { ...(target.config || {}) } };
    if (action.notification_template) {
      delete t.message_template;
      t.config.message_template = action.notification_template;
    }
    await notify.send(t, payload);
    sent += 1;
  }));

  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length) {
    console.warn('[NOTIFY] action-linked failed targets:', failed.map(r => r.reason?.message || 'error').join('; '));
  }
  return { sent, failed: failed.length };
}

// JOB RUN TRACKING

function runDurationMs(runId, startedAt) {
  return Date.now() - new Date(startedAt).getTime();
}

function trackRunStart(job) {
  return db.recordJobStart({
    jobId: job.id,
    repoId: job.repo_id,
    repoName: job.repo,
    keyword: job.name,
    type: job.type,
    trigger: job.trigger,
    logFile: job.logPath ? path.basename(job.logPath) : null,
  });
}

// WEBHOOK SIGNATURES

// Verify webhook authenticity for a given provider + secret.
// bodyBuf: Buffer|string of raw body
function verifyProviderSignature(provider, secret, headers, bodyBuf) {
  const body = Buffer.isBuffer(bodyBuf) ? bodyBuf : Buffer.from(bodyBuf || '');

  switch (provider) {
    case 'github': {
      const sig = headers['x-hub-signature-256'];
      if (!sig || !sig.startsWith('sha256=')) return false;
      const expected = 'sha256=' + hmacHex(secret, body);
      return safeEqual(sig, expected);
    }
    case 'gitea':
    case 'forgejo': {
      // Gitea/Forgejo: X-Gitea-Signature / X-Forgejo-Signature = hex HMAC-SHA256
      // Also accept GitHub-compatible X-Hub-Signature-256
      const giteaSig =
        headers['x-gitea-signature'] ||
        headers['x-forgejo-signature'] ||
        '';
      if (giteaSig) {
        const expected = hmacHex(secret, body);
        return safeEqual(giteaSig.toLowerCase(), expected.toLowerCase());
      }
      const hub = headers['x-hub-signature-256'];
      if (hub && hub.startsWith('sha256=')) {
        const expected = 'sha256=' + hmacHex(secret, body);
        return safeEqual(hub, expected);
      }
      return false;
    }
    case 'gitlab': {
      // GitLab uses a shared token header, not HMAC
      const token = headers['x-gitlab-token'] || '';
      return safeEqual(token, secret);
    }
    case 'generic': {
      // Custom: X-Webhook-Secret plain, or X-Hub-Signature-256, or X-Signature-256 hex
      const plain = headers['x-webhook-secret'] || headers['x-ci-secret'] || '';
      if (plain && safeEqual(plain, secret)) return true;
      const hub = headers['x-hub-signature-256'];
      if (hub && hub.startsWith('sha256=')) {
        return safeEqual(hub, 'sha256=' + hmacHex(secret, body));
      }
      const sig = headers['x-signature-256'] || headers['x-signature'] || '';
      if (sig) {
        const expected = hmacHex(secret, body);
        const cleaned = sig.replace(/^sha256=/i, '');
        return safeEqual(cleaned.toLowerCase(), expected.toLowerCase());
      }
      return false;
    }
    default:
      return false;
  }
}

function detectEventType(provider, headers, data) {
  if (provider === 'gitlab') {
    const ev = (headers['x-gitlab-event'] || '').toLowerCase();
    if (ev.includes('push')) return 'push';
    return ev || data.object_kind || '';
  }
  // GitHub / Gitea / Forgejo
  return (
    headers['x-github-event'] ||
    headers['x-gitea-event'] ||
    headers['x-forgejo-event'] ||
    data.action ||
    ''
  ).toLowerCase();
}

function extractRepoFullName(data) {
  if (data.repository?.full_name) return data.repository.full_name;
  if (data.repository?.owner?.login && data.repository?.name) {
    return `${data.repository.owner.login}/${data.repository.name}`;
  }
  if (data.repository?.owner?.name && data.repository?.name) {
    return `${data.repository.owner.name}/${data.repository.name}`;
  }
  // GitLab
  if (data.project?.path_with_namespace) return data.project.path_with_namespace;
  if (data.repository?.path_with_namespace) return data.repository.path_with_namespace;
  return null;
}

function extractCommits(data, provider) {
  if (Array.isArray(data.commits) && data.commits.length) {
    return data.commits.map(c => ({
      message: c.message || c.title || '',
      id: c.id || c.sha || '',
      author: c.author?.name || c.author?.username || c.author_name || '',
    }));
  }
  // GitLab sometimes only has commits array; force-push may be empty
  if (provider === 'gitlab' && data.commits) {
    return (data.commits || []).map(c => ({
      message: c.message || '',
      id: c.id || '',
      author: c.author?.name || c.author_name || '',
    }));
  }
  // Fallback: head commit
  if (data.head_commit?.message) {
    return [{
      message: data.head_commit.message,
      id: data.head_commit.id || '',
      author: data.head_commit.author?.name || '',
    }];
  }
  return [];
}

// LOGS / SCRIPTS FS

function writeToLog(logPath, data) {
  try {
    fs.appendFileSync(logPath, data, 'utf8');
  } catch (err) {
    console.error('[LOG] write failed:', err.message);
  }
}

function getLogFilesList() {
  try {
    return fs.readdirSync(LOGS_DIR)
      .map(f => {
        try {
          const st = fs.statSync(path.join(LOGS_DIR, f));
          return { name: f, mtime: st.mtime.getTime(), size: st.size };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_LOG_FILES);
  } catch {
    return [];
  }
}

function readLogFile(filename) {
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return null;
  }
  const fullPath = path.join(LOGS_DIR, filename);
  try {
    const stat = fs.statSync(fullPath);
    if (stat.size > MAX_LOG_VIEW_SIZE) {
      const fd = fs.openSync(fullPath, 'r');
      const buffer = Buffer.alloc(MAX_LOG_VIEW_SIZE);
      const bytesRead = fs.readSync(fd, buffer, 0, MAX_LOG_VIEW_SIZE, Math.max(0, stat.size - MAX_LOG_VIEW_SIZE));
      fs.closeSync(fd);
      return buffer.toString('utf8', 0, bytesRead);
    }
    return fs.readFileSync(fullPath, 'utf8');
  } catch {
    return null;
  }
}

function getScriptsList() {
  try {
    return fs.readdirSync(SCRIPTS_DIR).filter(f => f.endsWith('.sh')).sort();
  } catch {
    return [];
  }
}

function readScript(name) {
  const normalized = normalizeScriptPath(name);
  if (!normalized) return null;
  try {
    return fs.readFileSync(path.join(SCRIPTS_DIR, normalized), 'utf8');
  } catch {
    return null;
  }
}

function writeScript(name, content) {
  if (!isValidScriptName(name)) return false;
  const filename = name.endsWith('.sh') ? name : name + '.sh';
  try {
    fs.writeFileSync(path.join(SCRIPTS_DIR, filename), content, 'utf8');
    fs.chmodSync(path.join(SCRIPTS_DIR, filename), 0o755);
    return true;
  } catch {
    return false;
  }
}

function deleteScript(name) {
  const normalized = normalizeScriptPath(name);
  if (!normalized) return false;
  try {
    fs.unlinkSync(path.join(SCRIPTS_DIR, normalized));
    return true;
  } catch {
    return false;
  }
}

// JOB QUEUE + KEYWORD MATCH

function enqueue(job) {
  if (maintenanceMode()) {
    console.warn('[QUEUE] Rejected job during maintenance mode:', job.name);
    return false;
  }
  jobQueue.push(job);
  processQueue();
  return true;
}

/** Match commits against enabled actions and enqueue jobs. Returns matched jobs. */
function matchAndEnqueue(repo, commits, trigger) {
  const actions = db.getEnabledActions(repo.id);
  if (!actions.length || !commits.length) return [];

  const matched = [];
  let counter = 0;
  for (const commit of commits) {
    const message = commit.message || '';
    for (const action of actions) {
      if (!message.includes(action.keyword)) continue;
      const ts = Date.now();
      const jobId = `${repo.slug}_${action.keyword}_${ts}_${counter++}`;
      const logPath = path.join(
        LOGS_DIR,
        `${sanitizeLogFileName(repo.slug)}_${sanitizeLogFileName(action.keyword)}_${ts}_${counter}.log`
      );
      matched.push({
        id: jobId,
        name: action.keyword,
        type: action.type,
        action,
        logPath,
        repo: repo.full_name,
        repo_id: repo.id,
        provider: repo.provider,
        commit: commit.id,
        trigger,
      });
    }
  }
  matched.forEach(j => enqueue(j));
  return matched;
}

function advanceCommitCursor(repo, commits) {
  if (!commits || !commits.length) return;
  // commits may be webhook order (oldest to newest) or mixed; pick last non-empty id
  let sha = null;
  for (const c of commits) {
    if (c && c.id) sha = c.id;
  }
  if (!sha) return;
  // Only advance if we don't already have a newer cursor from poll - always set on webhook tip
  db.setRepoPollCursor(repo.id, {
    last_commit_sha: sha,
    last_polled_at: new Date().toISOString(),
  });
}

// COMMIT POLLING

async function pollRepo(repo, { force = false } = {}) {
  if (!repo || !repo.enabled) {
    return { status: 'skipped', reason: 'disabled' };
  }
  if (!force && !repo.poll_enabled) {
    return { status: 'skipped', reason: 'poll_disabled' };
  }
  if (pollInFlight.has(repo.id)) {
    return { status: 'skipped', reason: 'in_flight' };
  }

  pollInFlight.add(repo.id);
  try {
    const commitsNewestFirst = await poller.fetchRecentCommits(repo);
    const { head, newCommits, baseline, gap } = poller.diffNewCommits(
      commitsNewestFirst,
      repo.last_commit_sha
    );

    const polledAt = new Date().toISOString();

    if (baseline) {
      db.setRepoPollCursor(repo.id, {
        last_commit_sha: head,
        last_polled_at: polledAt,
      });
      console.log('[POLL]', repo.full_name, 'baseline HEAD', head ? head.slice(0, 8) : '(empty)');
      return {
        status: 'baseline',
        head,
        new_commits: 0,
        queued: 0,
        message: 'Stored current HEAD; future commits will trigger actions',
      };
    }

    if (!head) {
      db.setRepoPollCursor(repo.id, { last_commit_sha: null, last_polled_at: polledAt });
      return { status: 'empty', head: null, new_commits: 0, queued: 0 };
    }

    if (!newCommits.length) {
      db.setRepoPollCursor(repo.id, {
        last_commit_sha: head,
        last_polled_at: polledAt,
      });
      return { status: 'up_to_date', head, new_commits: 0, queued: 0 };
    }

    if (gap) {
      console.warn(
        '[POLL]',
        repo.full_name,
        'last SHA not in recent window - processing',
        newCommits.length,
        'newest commit(s)'
      );
    }

    const matched = matchAndEnqueue(repo, newCommits, 'poll');
    db.setRepoPollCursor(repo.id, {
      last_commit_sha: head,
      last_polled_at: polledAt,
    });

    if (matched.length) {
      db.audit(null, 'poll_queued', {
        repo: repo.full_name,
        count: matched.length,
        keywords: matched.map(m => m.name),
        commits: newCommits.length,
        gap: !!gap,
      }, null);
      console.log('[POLL]', repo.full_name, 'queued', matched.length, 'job(s) from', newCommits.length, 'commit(s)');
    } else {
      console.log('[POLL]', repo.full_name, newCommits.length, 'new commit(s), no keyword matches');
      db.audit(null, 'poll_no_match', {
        repo: repo.full_name,
        commits: newCommits.length,
      }, null);
    }

    return {
      status: matched.length ? 'queued' : 'no_matches',
      head,
      new_commits: newCommits.length,
      queued: matched.length,
      keywords: matched.map(m => m.name),
      gap: !!gap,
    };
  } catch (err) {
    console.error('[POLL]', repo.full_name, err.message);
    notifyPollError(repo, err.message);
    db.setRepoPollCursor(repo.id, {
      last_commit_sha: repo.last_commit_sha,
      last_polled_at: new Date().toISOString(),
    });
    return { status: 'error', error: err.message, queued: 0 };
  } finally {
    pollInFlight.delete(repo.id);
  }
}

async function pollAllRepos() {
  if (maintenanceMode()) {
    lastPollCycleAt = new Date().toISOString();
    lastPollCycleSummary = { checked: 0, queued: 0, skipped: true, reason: 'maintenance_mode' };
    return;
  }
  const repos = db.listPollRepos();
  const results = [];
  for (const repo of repos) {
    // eslint-disable-next-line no-await-in-loop
    const r = await pollRepo(repo);
    results.push({ repo_id: repo.id, full_name: repo.full_name, ...r });
  }
  lastPollCycleAt = new Date().toISOString();
  lastPollCycleSummary = {
    checked: results.length,
    queued: results.reduce((n, r) => n + (r.queued || 0), 0),
    errors: results.filter(r => r.status === 'error').length,
  };
  return results;
}

let pollTimer = null;
function startPollLoop() {
  const run = () => {
    pollAllRepos().catch(err => console.error('[POLL] cycle failed:', err.message));
  };
  // Catch up shortly after boot (missed pushes while offline)
  setTimeout(run, 5_000).unref();
  schedulePoll();
  console.log(`[POLL] interval ${getSetting('poll_interval_ms')}ms`);
}

// Recreate the interval so a Global Settings change applies without restart
function schedulePoll() {
  if (pollTimer) clearInterval(pollTimer);
  const run = () => {
    if (maintenanceMode()) return;
    pollAllRepos().catch(err => console.error('[POLL] cycle failed:', err.message));
  };
  pollTimer = setInterval(run, getSetting('poll_interval_ms')).unref();
}

const activeJobs = [];
function processQueue() {
  const maxJobs = getSetting('max_active_jobs');
  while (activeJobs.length < maxJobs && jobQueue.length) {
    if (maintenanceMode()) return; // drain in place; no new starts
    const job = jobQueue.shift();
    activeJobs.push(job);
    try {
      runJob(job, (err) => {
        const i = activeJobs.indexOf(job);
        if (i >= 0) activeJobs.splice(i, 1);
        if (err) console.error('[QUEUE] Job failed:', err.message);
        processQueue();
      });
    } catch (err) {
      const i = activeJobs.indexOf(job);
      if (i >= 0) activeJobs.splice(i, 1);
      console.error('[QUEUE] Sync error:', err.message);
      processQueue();
    }
  }
}

function runJob(job, callback) {
  const { type, name, logPath } = job;
  const startedAt = Date.now();
  const runId = trackRunStart(job);

  writeToLog(logPath, `[${new Date().toISOString()}] Starting job: ${name} (type: ${type})\n`);
  if (job.repo) writeToLog(logPath, `Repo: ${job.repo}\n`);
  if (job.trigger) writeToLog(logPath, `Trigger: ${job.trigger}\n`);

  notifyAllUsers('job_start', job, { duration: null });

  const done = (err) => {
    const durationMs = Date.now() - startedAt;
    let status = 'success';
    if (err && err.signal) status = 'timeout';
    else if (err) status = 'fail';
    db.recordJobFinish(runId, { status, durationMs, exitCode: err?.code ?? null });
    const extra = { duration: `${(durationMs / 1000).toFixed(1)}s` };
    notifyAllUsers(status === 'success' ? 'job_success' : status === 'timeout' ? 'job_timeout' : 'job_failure', job, extra);
    sendActionNotifications(job, { ...extra, status })
      .catch(e => console.warn('[NOTIFY] action-linked error:', e.message));
    callback(err);
  };

  if (type === 'script') runScriptJob(job, logPath, done);
  else if (type === 'deploy') runDeployJob(job, logPath, done);
  else {
    writeToLog(logPath, `[ERROR] Unknown job type: ${type}\n`);
    db.recordJobFinish(runId, { status: 'fail', durationMs: Date.now() - startedAt, exitCode: null });
    callback(new Error('Unknown job type'));
  }
}

function buildJobEnv(job) {
  const env = {
    ...process.env,
    CI_KEYWORD: job.name || '',
    CI_REPO: job.repo || '',
    CI_COMMIT: job.commit || '',
    CI_PROVIDER: job.provider || '',
  };

  let repoRow = null;
  if (job.repo_id) repoRow = db.getRepoById(job.repo_id);

  if (repoRow) {
    if (repoRow.git_username) env.CI_GIT_USER = repoRow.git_username;
    if (repoRow.git_token) env.CI_GIT_TOKEN = repoRow.git_token;
    if (repoRow.clone_url) env.CI_CLONE_URL = repoRow.clone_url;

    // Authenticated HTTPS clone URL for private repos
    if (repoRow.git_token) {
      const user = encodeURIComponent(repoRow.git_username || 'git');
      const token = encodeURIComponent(repoRow.git_token);
      const host = defaultGitHost(repoRow.provider);
      env.CI_CLONE_AUTH_URL =
        repoRow.clone_url ||
        `https://${user}:${token}@${host}/${repoRow.full_name}.git`;
    } else if (repoRow.clone_url) {
      env.CI_CLONE_AUTH_URL = repoRow.clone_url;
    }
  }

  return env;
}

function defaultGitHost(provider) {
  switch (provider) {
    case 'gitlab': return 'gitlab.com';
    case 'gitea': return 'gitea.com';
    case 'forgejo': return 'codeberg.org';
    default: return 'github.com';
  }
}

function runScriptJob(job, logPath, callback) {
  const scriptName = normalizeScriptPath(job.action.script);
  if (!scriptName) {
    writeToLog(logPath, '[ERROR] Invalid script name\n');
    return callback(new Error('Invalid script name'));
  }

  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  if (!fs.existsSync(scriptPath)) {
    writeToLog(logPath, `[ERROR] Script not found: ${scriptName}\n`);
    return callback(new Error('Script not found'));
  }

  const resolved = path.resolve(scriptPath);
  if (!resolved.startsWith(path.resolve(SCRIPTS_DIR) + path.sep) && resolved !== path.resolve(SCRIPTS_DIR)) {
    writeToLog(logPath, '[ERROR] Path traversal blocked\n');
    return callback(new Error('Path traversal blocked'));
  }

  if (job.repo_id) {
    const r = db.getRepoById(job.repo_id);
    if (r?.git_token) writeToLog(logPath, '[auth] git token available for private clone\n');
  }

  const child = spawn('bash', [scriptPath], {
    cwd: __dirname,
    env: buildJobEnv(job),
    timeout: getSetting('script_timeout_ms'),
  });

  child.stdout.on('data', d => writeToLog(logPath, d.toString('utf8')));
  child.stderr.on('data', d => writeToLog(logPath, '[STDERR] ' + d.toString('utf8')));
  child.on('error', err => {
    writeToLog(logPath, `[ERROR] spawn: ${err.message}\n`);
    callback(err);
  });
  child.on('close', (code, signal) => {
    writeToLog(logPath, `[${new Date().toISOString()}] Exit code: ${code}${signal ? ` (signal: ${signal})` : ''}\n`);
    if (code === 0) return callback(null);
    const err = new Error(`Exit code: ${code}${signal ? ` (signal: ${signal})` : ''}`);
    err.code = code;
    err.signal = signal;
    callback(err);
  });
}

function runDeployJob(job, logPath, callback) {
  const action = job.action || {};
  const method = action.method || 'ssh';
  if (method !== 'rsync' && method !== 'ssh') {
    writeToLog(logPath, `[ERROR] Unknown deploy method: ${method}\n`);
    return callback(new Error('Unknown deploy method'));
  }

  const machineIds = Array.isArray(action.machine_ids) ? action.machine_ids : [];
  if (!machineIds.length) {
    writeToLog(logPath, '[ERROR] No deployment machine configured for this action\n');
    return callback(new Error('No deployment machine configured'));
  }

  const machines = db.getDeployMachinesByIds(machineIds);
  const missing = machineIds.filter(id => !machines.some(m => m.id === id));
  if (missing.length) {
    writeToLog(logPath, `[ERROR] Deployment machine(s) not found: ${missing.join(', ')}\n`);
    return callback(new Error(`Deployment machine(s) not found: ${missing.join(', ')}`));
  }

  if (!action.script) {
    writeToLog(logPath, '[ERROR] No script configured for this action\n');
    return callback(new Error('No script configured'));
  }

  const scriptName = normalizeScriptPath(action.script);
  if (!scriptName) {
    writeToLog(logPath, '[ERROR] Invalid script name\n');
    return callback(new Error('Invalid script name'));
  }
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  if (!fs.existsSync(scriptPath)) {
    writeToLog(logPath, `[ERROR] Script not found: ${scriptName}\n`);
    return callback(new Error('Script not found'));
  }

  let i = 0;
  const nextMachine = (err) => {
    if (err) return callback(err);
    if (i >= machines.length) return callback(null);
    const machine = machines[i++];

    const key = materializeSshKey(machine);
    if (key.error) {
      writeToLog(logPath, `[ERROR] ${key.error}\n`);
      return callback(new Error(key.error));
    }
    const portLabel = machine.port && Number(machine.port) !== 22 ? `:${machine.port}` : '';
    writeToLog(logPath, `[DEPLOY] Machine ${machine.name} (${machine.ssh_user}@${machine.host}${portLabel})\n`);

    const machineCtx = { action, machine: { ...machine, keyPath: key.path }, logPath };
    const done = (machineErr) => {
      if (key.cleanup) {
        try { key.cleanup(); } catch { /* best effort */ }
      }
      nextMachine(machineErr);
    };
    const afterDeploy = (deployErr) => {
      if (deployErr) return done(deployErr);
      runRemoteScript(machineCtx, scriptPath, scriptName, job, done);
    };
    if (method === 'rsync') runRsyncDeploy(machineCtx, afterDeploy);
    else runSshDeploy(machineCtx, afterDeploy);
  };
  nextMachine(null);
}

// Resolve a machine's stored ssh_key name to a decrypted temp key file.
// The temp file lives only for the duration of that machine's deploy+script.
function materializeSshKey(machine) {
  if (!machine.ssh_key) return { path: null };
  const row = db.getSshKeyByName(machine.ssh_key);
  if (!row || !row.key_data) {
    return { error: `SSH key not found: ${machine.ssh_key}` };
  }
  const content = decryptSecret(row.key_data);
  if (content === null) {
    return { error: `SSH key "${machine.ssh_key}" could not be decrypted (wrong master key?)` };
  }
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-field-key-'));
    const file = path.join(dir, 'key');
    fs.writeFileSync(file, content.endsWith('\n') ? content : content + '\n', { mode: 0o600 });
    return { path: file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  } catch (e) {
    return { error: `Cannot materialize SSH key: ${e.message}` };
  }
}

function buildSshArgs(machine, extra) {
  const args = [];
  if (machine.keyPath) args.push('-i', machine.keyPath);
  if (machine.port && Number(machine.port) !== 22) args.push('-p', String(machine.port));
  if (machine.ssh_options) args.push(...String(machine.ssh_options).split(/\s+/).filter(Boolean));
  args.push(...extra);
  return args;
}

function machineHostCheck(machine, logPath) {
  const { host, ssh_user } = machine;
  if (typeof host !== 'string' || !/^[a-zA-Z0-9._:-]+$/.test(host)) {
    writeToLog(logPath, `[ERROR] Invalid host: ${host}\n`);
    return 'Invalid host';
  }
  if (typeof ssh_user !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(ssh_user)) {
    writeToLog(logPath, `[ERROR] Invalid user: ${ssh_user}\n`);
    return 'Invalid user';
  }
  return null;
}

function runRsyncDeploy({ action, machine, logPath }, callback) {
  const { source, destination } = action;
  if (!source || !destination) {
    writeToLog(logPath, '[ERROR] Missing rsync params\n');
    return callback(new Error('Missing required parameters'));
  }
  const err = machineHostCheck(machine, logPath);
  if (err) return callback(new Error(err));

  const sourcePath = path.resolve(path.join(__dirname, source));
  if (!sourcePath.startsWith(path.resolve(__dirname) + path.sep) && sourcePath !== path.resolve(__dirname)) {
    writeToLog(logPath, '[ERROR] Source path traversal\n');
    return callback(new Error('Path traversal blocked'));
  }
  if (!fs.existsSync(sourcePath)) {
    writeToLog(logPath, `[ERROR] Source not found: ${sourcePath}\n`);
    return callback(new Error('Source not found'));
  }

  const args = ['-av'];
  if (machine.keyPath || machine.ssh_options || (machine.port && Number(machine.port) !== 22)) {
    const sshCmdParts = ['ssh'];
    if (machine.keyPath) sshCmdParts.push('-i', `'${String(machine.keyPath).replace(/'/g, "'\\''")}'`);
    if (machine.port && Number(machine.port) !== 22) sshCmdParts.push('-p', String(machine.port));
    if (machine.ssh_options) sshCmdParts.push(machine.ssh_options);
    args.push('-e', sshCmdParts.join(' '));
  }
  args.push(sourcePath, `${machine.ssh_user}@${machine.host}:${destination}`);

  writeToLog(logPath, `[RSYNC] ${sourcePath} -> ${machine.ssh_user}@${machine.host}:${destination}\n`);
  const child = spawn('rsync', args, { timeout: getSetting('rsync_timeout_ms') });
  child.stdout.on('data', d => writeToLog(logPath, d.toString('utf8')));
  child.stderr.on('data', d => writeToLog(logPath, '[STDERR] ' + d.toString('utf8')));
  child.on('error', err => {
    writeToLog(logPath, `[ERROR] rsync: ${err.message}\n`);
    callback(err);
  });
  child.on('close', (code, signal) => {
    writeToLog(logPath, `[${new Date().toISOString()}] rsync exit: ${code}${signal ? ` (signal: ${signal})` : ''}\n`);
    if (code === 0) return callback(null);
    const err = new Error(`rsync exit: ${code}${signal ? ` (signal: ${signal})` : ''}`);
    err.code = code;
    err.signal = signal;
    callback(err);
  });
}

function runSshDeploy({ action, machine, logPath }, callback) {
  const { command } = action;
  if (!command) {
    writeToLog(logPath, '[ERROR] Missing SSH command\n');
    return callback(new Error('Missing required parameters'));
  }
  const err = machineHostCheck(machine, logPath);
  if (err) return callback(new Error(err));

  const args = buildSshArgs(machine, [`${machine.ssh_user}@${machine.host}`, command]);
  writeToLog(logPath, `[SSH] ${machine.ssh_user}@${machine.host}: ${command}\n`);

  const child = spawn('ssh', args, { timeout: getSetting('ssh_timeout_ms') });
  child.stdout.on('data', d => writeToLog(logPath, d.toString('utf8')));
  child.stderr.on('data', d => writeToLog(logPath, '[STDERR] ' + d.toString('utf8')));
  child.on('error', err => {
    writeToLog(logPath, `[ERROR] ssh: ${err.message}\n`);
    callback(err);
  });
  child.on('close', (code, signal) => {
    writeToLog(logPath, `[${new Date().toISOString()}] SSH exit: ${code}${signal ? ` (signal: ${signal})` : ''}\n`);
    if (code === 0) return callback(null);
    const err = new Error(`SSH exit: ${code}${signal ? ` (signal: ${signal})` : ''}`);
    err.code = code;
    err.signal = signal;
    callback(err);
  });
}

// Run the action script ON the deployment machine by streaming it over SSH.
function runRemoteScript({ action, machine, logPath }, scriptPath, scriptName, job, callback) {
  const err = machineHostCheck(machine, logPath);
  if (err) return callback(new Error(err));

  let content;
  try {
    content = fs.readFileSync(scriptPath, 'utf8');
  } catch (e) {
    writeToLog(logPath, `[ERROR] Cannot read script: ${e.message}\n`);
    return callback(e);
  }

  const env = buildJobEnv(job);
  const exports = [];
  for (const key of ['CI_KEYWORD', 'CI_REPO', 'CI_COMMIT', 'CI_PROVIDER', 'CI_GIT_USER', 'CI_GIT_TOKEN', 'CI_CLONE_AUTH_URL']) {
    if (env[key] !== undefined && env[key] !== '') {
      exports.push(`export ${key}='${String(env[key]).replace(/'/g, "'\\''")}';`);
    }
  }
  const remoteCmd = `${exports.join('')} cd /tmp && bash -s`;
  writeToLog(logPath, `[SCRIPT] streaming ${scriptName} to ${machine.ssh_user}@${machine.host} and running it there\n`);

  const args = buildSshArgs(machine, [`${machine.ssh_user}@${machine.host}`, remoteCmd]);
  const child = spawn('ssh', args, {
    timeout: getSetting('script_timeout_ms'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.write(content);
  child.stdin.end();
  child.stdout.on('data', d => writeToLog(logPath, d.toString('utf8')));
  child.stderr.on('data', d => writeToLog(logPath, '[STDERR] ' + d.toString('utf8')));
  child.on('error', err => {
    writeToLog(logPath, `[ERROR] ssh (script): ${err.message}\n`);
    callback(err);
  });
  child.on('close', (code, signal) => {
    writeToLog(logPath, `[${new Date().toISOString()}] Script exit: ${code}${signal ? ` (signal: ${signal})` : ''}\n`);
    if (code === 0) return callback(null);
    const err = new Error(`Script exit: ${code}${signal ? ` (signal: ${signal})` : ''}`);
    err.code = code;
    err.signal = signal;
    callback(err);
  });
}

function validateActionBody(action) {
  if (!action || !action.type || !['script', 'deploy'].includes(action.type)) {
    return 'Invalid action type';
  }
  if (!action.script) return 'Missing script name';
  if (!normalizeScriptPath(action.script)) return 'Invalid script path';
  if (!Array.isArray(action.machine_ids) || !action.machine_ids.length) {
    return 'Select at least one deployment machine';
  }
  const ids = [...new Set(action.machine_ids.map(Number))];
  if (ids.some(id => !Number.isInteger(id) || id <= 0)) return 'Invalid deployment machine id';
  if (ids.length > 20) return 'Too many deployment machines';
  const found = new Set(db.getDeployMachinesByIds(ids).map(m => m.id));
  if (ids.some(id => !found.has(id))) return 'Deployment machine not found';
  if (!action.method || !['rsync', 'ssh'].includes(action.method)) return 'Invalid deploy method';
  if (action.method === 'rsync') {
    if (!action.source || !action.destination) return 'rsync requires source and destination';
    const normSource = String(action.source).replace(/^\.\//, '');
    if (normSource.includes('..') || normSource.startsWith('/')) return 'Invalid rsync source path';
  }
  if (action.method === 'ssh' && !action.command) return 'ssh requires command';

  if (action.notification_target_ids !== undefined) {
    if (!Array.isArray(action.notification_target_ids)) return 'Invalid notification targets';
    const nids = [...new Set(action.notification_target_ids.map(Number))];
    if (nids.some(id => !Number.isInteger(id) || id <= 0)) return 'Invalid notification target id';
    if (nids.length > 20) return 'Too many notification targets';
  }
  if (action.notification_template !== undefined) {
    if (typeof action.notification_template !== 'string') return 'Invalid notification template';
    if (action.notification_template.length > 2000) return 'Notification template too long';
  }
  return null;
}

function actionConfigFromBody(action) {
  const cfg = {
    script: normalizeScriptPath(action.script) || action.script,
    machine_ids: [...new Set(action.machine_ids.map(Number))],
    method: action.method,
  };
  if (action.method === 'rsync') {
    cfg.source = action.source;
    cfg.destination = action.destination;
  } else {
    cfg.command = action.command;
  }
  if (Array.isArray(action.notification_target_ids)) {
    cfg.notification_target_ids = [...new Set(action.notification_target_ids.map(Number))];
  }
  if (typeof action.notification_template === 'string' && action.notification_template.trim()) {
    cfg.notification_template = action.notification_template.trim().slice(0, 2000);
  }
  return cfg;
}

// EXPRESS

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Capture raw body for webhook HMAC
app.use('/webhook', express.raw({ type: '*/*', limit: '5mb' }));
app.use(express.json({ limit: '2mb' }));

function checkAuthRate(ip) {
  if (!failedAuthAttempts.has(ip)) return true;
  const { count, lastAttempt } = failedAuthAttempts.get(ip);
  if (Date.now() - lastAttempt >= AUTH_RATE_WINDOW_MS) {
    failedAuthAttempts.delete(ip);
    return true;
  }
  return count < AUTH_RATE_LIMIT;
}

function bumpAuthFail(ip) {
  const prev = failedAuthAttempts.get(ip) || { count: 0, lastAttempt: 0 };
  failedAuthAttempts.set(ip, { count: prev.count + 1, lastAttempt: Date.now() });
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  const user = db.getSessionUser(token);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = user;
  req.sessionToken = token;
  next();
}

// Staff = admin or devops
function requireStaff(req, res, next) {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'devops')) {
    return res.status(403).json({ error: 'Staff access required' });
  }
  next();
}

// Only admin can manage users
function requireAdminUser(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the admin user can manage users' });
  }
  next();
}

function publicRepoView(repo, viewerRole) {
  if (!repo) return null;
  const isStaff = viewerRole === 'admin' || viewerRole === 'devops';
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    provider: repo.provider,
    slug: repo.slug,
    enabled: !!repo.enabled,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    webhook_path: `/webhook/${repo.slug}`,
    webhook_secret_hint: isStaff && repo.webhook_secret
      ? '••••' + repo.webhook_secret.slice(-4)
      : null,
    git_username: repo.git_username || '',
    has_git_token: !!(repo.git_token && String(repo.git_token).length),
    git_token_hint: isStaff && repo.git_token
      ? '••••' + String(repo.git_token).slice(-4)
      : null,
    clone_url: repo.clone_url || '',
    poll_enabled: !!repo.poll_enabled,
    poll_branch: repo.poll_branch || '',
    last_commit_sha: repo.last_commit_sha || null,
    last_polled_at: repo.last_polled_at || null,
  };
}

// Auth routes

app.get('/api/auth/me', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = db.getSessionUser(cookies[COOKIE_NAME]);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ user, version: APP_VERSION });
});

app.post('/api/auth/login', (req, res) => {
  const ip = clientIp(req);
  if (!checkAuthRate(ip)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    bumpAuthFail(ip);
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = db.authenticateUser(String(username), String(password));
  if (!user) {
    bumpAuthFail(ip);
    db.audit(null, 'login_failed', { username: String(username) }, ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  failedAuthAttempts.delete(ip);
  const session = db.createSession(user.id);
  setSessionCookie(res, session.token, session.expires_at);
  db.audit(user, 'login', {}, ip);
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  const user = db.getSessionUser(token);
  if (token) db.deleteSession(token);
  clearSessionCookie(res);
  if (user) db.audit(user, 'logout', {}, clientIp(req));
  res.json({ status: 'ok' });
});

// Profile - registered before requireAuth so /me works
app.get('/api/profile', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionUser = db.getSessionUser(cookies[COOKIE_NAME]);
  if (!sessionUser) return res.status(401).json({ error: 'Unauthorized' });
  const full = db.getUserById(sessionUser.id);
  if (!full) return res.status(401).json({ error: 'Unauthorized' });
  res.json({
    id: full.id,
    username: full.username,
    role: full.role,
    created_at: full.created_at,
    updated_at: full.updated_at,
  });
});

app.patch('/api/profile', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionUser = db.getSessionUser(cookies[COOKIE_NAME]);
  if (!sessionUser) return res.status(401).json({ error: 'Unauthorized' });

  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password required' });
  }
  if (String(new_password).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const auth = db.authenticateUser(sessionUser.username, String(current_password));
  if (!auth) {
    db.audit(sessionUser, 'profile_password_fail', {}, clientIp(req));
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  db.updateUserPassword(sessionUser.id, String(new_password));
  db.deleteUserSessions(sessionUser.id);
  const session = db.createSession(sessionUser.id);
  setSessionCookie(res, session.token, session.expires_at);
  db.audit(sessionUser, 'profile_password_change', {}, clientIp(req));
  res.json({ status: 'ok', message: 'Password updated' });
});

// Notifications (per user)

const NOTIFICATION_CONFIG_FIELDS = {
  discord: ['url'],
  slack: ['url'],
  telegram: ['bot_token', 'chat_id'],
  pushover: ['api_token', 'user_key'],
  gotify: ['url', 'app_token'],
  ntfy: ['url', 'topic'],
  generic: ['url', 'token'],
};

function validateNotificationConfig(type, config) {
  const required = NOTIFICATION_CONFIG_FIELDS[type];
  if (!required) return 'Invalid notification type';
  if (!config || typeof config !== 'object') return 'Invalid config';
  for (const key of required) {
    if (key === 'token' && type === 'generic') continue; // token optional for generic
    const val = config[key];
    if (typeof val !== 'string' || !val.trim()) return `Missing config field: ${key}`;
    if (String(val).length > 2000) return `Config field too long: ${key}`;
  }
  const url = config.url || (type === 'telegram' ? '' : '');
  if (url) {
    try {
      const u = new URL(url);
      const allowed = type === 'generic'
        ? ['http:', 'https:', 'generic:', 'generic+https:']
        : ['http:', 'https:'];
      if (!allowed.includes(u.protocol)) return 'url must be http(s)';
    } catch {
      return 'Invalid url';
    }
  }
  return null;
}

function sanitizeNotificationBody(body) {
  const { name, type, enabled, events, config } = body || {};
  if (!name || typeof name !== 'string' || name.length > 100) {
    return { error: 'Invalid name' };
  }
  if (!db.NOTIFICATION_TYPES.includes(type)) {
    return { error: `type must be one of: ${db.NOTIFICATION_TYPES.join(', ')}` };
  }
  const cfgErr = validateNotificationConfig(type, config);
  if (cfgErr) return { error: cfgErr };
  const validEvents = db.NOTIFICATION_EVENTS;
  const evs = Array.isArray(events)
    ? events.filter(e => validEvents.includes(e))
    : [];
  return {
    body: {
      name: name.trim(),
      type,
      enabled: enabled !== false,
      events: evs,
      config,
    },
  };
}

app.get('/api/notifications', requireAuth, (req, res) => {
  res.json({
    targets: db.listNotifications(req.user.id),
    events: db.NOTIFICATION_EVENTS,
    types: db.NOTIFICATION_TYPES,
    status_webhook: `/webhook/status/${db.getStatusToken(req.user.id)}`,
  });
});

app.post('/api/notifications', requireAuth, (req, res) => {
  const { error, body } = sanitizeNotificationBody(req.body);
  if (error) return res.status(400).json({ error });
  const target = db.createNotification({ userId: req.user.id, ...body });
  db.audit(req.user, 'notification_create', { id: target.id, name: target.name, type: target.type }, clientIp(req));
  res.status(201).json(target);
});

app.patch('/api/notifications/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.getNotification(id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const fields = {};
  const body = req.body || {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) {
      return res.status(400).json({ error: 'Invalid name' });
    }
    fields.name = body.name.trim();
  }
  if (body.type !== undefined) {
    if (!db.NOTIFICATION_TYPES.includes(body.type)) {
      return res.status(400).json({ error: 'Invalid type' });
    }
    fields.type = body.type;
  }
  if (body.config !== undefined) {
    const cfgErr = validateNotificationConfig(fields.type || existing.type, body.config);
    if (cfgErr) return res.status(400).json({ error: cfgErr });
    // Merge so untouched secrets (blanked or censored in the UI) are preserved.
    const meta = ['id', 'user_id', 'name', 'type', 'enabled', 'events', 'created_at', 'updated_at'];
    const merged = {};
    for (const [k, v] of Object.entries(existing)) {
      if (!meta.includes(k)) merged[k] = v;
    }
    for (const [k, v] of Object.entries(body.config)) {
      if (typeof v === 'string' && v.includes('••••')) continue;
      merged[k] = v;
    }
    fields.config = merged;
  }
  if (body.events !== undefined) {
    fields.events = Array.isArray(body.events)
      ? body.events.filter(e => db.NOTIFICATION_EVENTS.includes(e))
      : [];
  }
  if (body.enabled !== undefined) fields.enabled = !!body.enabled;

  const target = db.updateNotification(id, req.user.id, fields);
  db.audit(req.user, 'notification_update', { id, name: target.name }, clientIp(req));
  res.json(target);
});

app.delete('/api/notifications/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.deleteNotification(id, req.user.id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  db.audit(req.user, 'notification_delete', { id }, clientIp(req));
  res.json({ status: 'deleted' });
});

app.post('/api/notifications/:id/test', requireAuth, (req, res) => {
  const target = db.getNotification(parseInt(req.params.id, 10), req.user.id);
  if (!target) return res.status(404).json({ error: 'Not found' });

  notify.send(target, {
    title: 'Test notification',
    message: `AT FIELD CICD test from ${req.user.username}`,
    ok: true,
    event: 'test',
  }).then(() => {
    db.audit(req.user, 'notification_test', { id: target.id, type: target.type }, clientIp(req));
    res.json({ status: 'sent' });
  }).catch(err => {
    db.audit(req.user, 'notification_test_fail', { id: target.id, error: err.message }, clientIp(req));
    res.status(502).json({ error: `Delivery failed: ${err.message}` });
  });
});

app.post('/api/notifications/status-token/rotate', requireAuth, (req, res) => {
  const token = db.rotateStatusToken(req.user.id);
  db.audit(req.user, 'status_token_rotate', {}, clientIp(req));
  res.json({ status_webhook: `/webhook/status/${token}` });
});

// Webhooks

function handleWebhook(req, res, forcedRepo) {
  const raw = req.body;
  const bodyBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || '');
  let data;
  try {
    data = JSON.parse(bodyBuf.toString('utf8') || '{}');
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  let repo = forcedRepo;
  if (!repo) {
    const fullName = extractRepoFullName(data);
    if (!fullName) {
      return res.status(400).json({ error: 'Cannot determine repository from payload' });
    }
    // Try match by full_name; verify signature per candidate
    const candidates = db.findRepos(fullName);
    if (!candidates.length) {
      console.warn('[WEBHOOK] No configured repo for', fullName);
      return res.status(404).json({ error: 'Unknown repository', full_name: fullName });
    }
    repo = candidates.find(r =>
      verifyProviderSignature(r.provider, r.webhook_secret, req.headers, bodyBuf)
    );
    if (!repo) {
      console.warn('[WEBHOOK] Signature failed for', fullName);
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } else {
    if (!repo.enabled) {
      return res.status(403).json({ error: 'Repository disabled' });
    }
    if (!verifyProviderSignature(repo.provider, repo.webhook_secret, req.headers, bodyBuf)) {
      console.warn('[WEBHOOK] Invalid signature for slug', repo.slug);
      return res.status(401).json({ error: 'Invalid signature' });
    }
    // Optional: ensure payload repo matches configured full_name
    const fullName = extractRepoFullName(data);
    if (fullName && fullName.toLowerCase() !== repo.full_name.toLowerCase()) {
      console.warn('[WEBHOOK] Payload repo mismatch', fullName, '!=', repo.full_name);
      return res.status(400).json({ error: 'Repository mismatch' });
    }
  }

  const event = detectEventType(repo.provider, req.headers, data);
  if (event && event !== 'push' && !event.includes('push')) {
    console.log('[WEBHOOK] Ignoring event:', event, 'repo:', repo.full_name);
    db.audit(null, 'webhook_ignored', { repo: repo.full_name, event }, clientIp(req));
    return res.status(200).json({ status: 'ignored', event });
  }

  const commits = extractCommits(data, repo.provider);
  // Keep poll cursor in sync so restart/poll doesn't re-fire webhook commits
  if (commits.length) advanceCommitCursor(repo, commits);

  const actions = db.getEnabledActions(repo.id);
  if (!actions.length) {
    return res.status(200).json({ status: 'no_actions', queued: 0 });
  }

  const matched = matchAndEnqueue(repo, commits, 'webhook');

  if (!matched.length) {
    console.log('[WEBHOOK] No keyword matches for', repo.full_name);
    db.audit(null, 'webhook_no_match', { repo: repo.full_name, commits: commits.length }, clientIp(req));
    return res.status(200).json({ status: 'no_matches', queued: 0 });
  }

  db.audit(null, 'webhook_queued', {
    repo: repo.full_name,
    provider: repo.provider,
    count: matched.length,
    keywords: matched.map(m => m.name),
  }, clientIp(req));

  console.log('[WEBHOOK]', repo.full_name, 'queued', matched.length, 'job(s)');
  res.status(200).json({ status: 'queued', count: matched.length, repo: repo.full_name });
}

function webhookMaintenanceGuard(req, res, next) {
  if (maintenanceMode()) {
    return res.status(503).json({ error: 'Maintenance mode: webhook processing is paused' });
  }
  next();
}

app.post('/webhook', webhookMaintenanceGuard, (req, res) => handleWebhook(req, res, null));

app.post('/webhook/:slug', webhookMaintenanceGuard, (req, res) => {
  const repo = db.getRepoBySlug(req.params.slug);
  if (!repo) return res.status(404).json({ error: 'Unknown webhook endpoint' });
  handleWebhook(req, res, repo);
});

// External status reports: POST /webhook/status/<user status token>
// Used by templates (check-status.sh) and external scripts to push status
// updates (docker container health, service checks, ...) to the user's
// notification targets (SMS, email, Discord, ...).

const statusReportLimits = new Map();
const STATUS_RATE_LIMIT = 20;
const STATUS_RATE_WINDOW_MS = 60 * 1000;

function allowStatusReport(token) {
  const now = Date.now();
  const entry = statusReportLimits.get(token) || { count: 0, windowStart: now };
  if (now - entry.windowStart >= STATUS_RATE_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  statusReportLimits.set(token, entry);
  return entry.count <= STATUS_RATE_LIMIT;
}

function sendStatusReport(user, payload) {
  const targets = db.listNotifications(user.id).filter(t => t.enabled);
  if (!targets.length) return Promise.resolve({ sent: 0, failed: 0 });
  const message = [payload.message || '', payload.details || ''].filter(Boolean).join('\n');
  const base = {
    title: payload.title || `Status report - ${user.username}`,
    message,
    ok: payload.ok !== false,
    event: 'status_report',
  };
  return Promise.allSettled(targets.map(t => {
    const clean = {};
    for (const [k, v] of Object.entries(payload)) {
      if (v !== '' && v !== null && v !== undefined) clean[k] = v;
    }
    return notify.send(t, { ...base, ...clean });
  })).then(results => ({
    sent: results.filter(r => r.status === 'fulfilled').length,
    failed: results.filter(r => r.status === 'rejected').length,
  }));
}

app.post('/webhook/status/:token', (req, res) => {
  const { token } = req.params;
  if (!token || !/^[a-f0-9]{32,128}$/i.test(token)) {
    return res.status(400).json({ error: 'Invalid status token' });
  }
  if (!allowStatusReport(token)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  const user = db.getUserByStatusToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid status token' });

  let payload;
  try {
    payload = JSON.parse((Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '')).toString('utf8') || '{}');
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  if (typeof payload !== 'object' || payload === null) {
    return res.status(400).json({ error: 'Body must be a JSON object' });
  }
  const title = String(payload.title || '').slice(0, 200);
  const message = String(payload.message || '').slice(0, 4000);
  if (!message && !title) {
    return res.status(400).json({ error: 'message or title required' });
  }

  const report = { title, message, ok: payload.ok !== false, details: payload.details ? String(payload.details).slice(0, 4000) : null };
  const extra = {};
  for (const k of ['status', 'service', 'duration', 'commit', 'branch', 'url']) {
    const v = payload[k];
    if (v === undefined || v === null || v === '') continue;
    extra[k] = typeof v === 'string' ? v.slice(0, 4000) : JSON.stringify(v);
  }
  sendStatusReport(user, { ...report, ...extra }).then(({ sent, failed }) => {
    db.audit(null, 'status_report', {
      username: user.username,
      sent,
      failed,
      ok: report.ok,
      title: report.title,
    }, clientIp(req));
    res.json({ status: 'received', sent, failed });
  }).catch(err => {
    console.warn('[STATUS] delivery failed:', err.message);
    res.status(502).json({ error: 'Delivery failed' });
  });
});

// Static + protected API
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', requireAuth);

// Status

app.get('/api/status', (req, res) => {
  res.json({
    current: activeJobs[0]
      ? { id: activeJobs[0].id, name: activeJobs[0].name, type: activeJobs[0].type, repo: activeJobs[0].repo }
      : null,
    active_jobs: activeJobs.map(j => ({ id: j.id, name: j.name, type: j.type, repo: j.repo })),
    queue_length: jobQueue.length,
    is_processing: activeJobs.length > 0,
    maintenance_mode: maintenanceMode(),
    user: req.user,
    poll: {
      interval_ms: getSetting('poll_interval_ms'),
      last_cycle_at: lastPollCycleAt,
      last_cycle: lastPollCycleSummary,
    },
  });
});

// Stats (dashboard charts)

app.get('/api/stats', (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 14, 90);
  res.json({
    ...db.getStats({ days }),
    recent: db.listRecentRuns({ limit: 10 }),
  });
});

// Users (admin)

app.get('/api/users', requireAdminUser, (req, res) => {
  res.json(db.listUsers());
});

app.post('/api/users', requireAdminUser, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: 'Invalid username (2-64 chars, alnum._-)' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const validRoles = ['admin', 'devops', 'developer'];
  const r = validRoles.includes(role) ? role : 'developer';
  try {
    const user = db.createUser(username, password, r);
    db.audit(req.user, 'user_create', { id: user.id, username: user.username, role: user.role }, clientIp(req));
    res.status(201).json(user);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    throw err;
  }
});

app.patch('/api/users/:id', requireAdminUser, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const { password, role } = req.body || {};
  if (password !== undefined) {
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    db.updateUserPassword(id, password);
    db.deleteUserSessions(id);
    db.audit(req.user, 'user_password_reset', { id, username: target.username }, clientIp(req));
  }
  if (role !== undefined) {
    if (!['admin', 'devops', 'developer'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    if (target.id === req.user.id && role !== 'admin') {
      return res.status(400).json({ error: 'Cannot demote yourself' });
    }
    if (target.username === 'admin' && role !== 'admin') {
      return res.status(400).json({ error: 'Cannot demote the admin user' });
    }
    db.updateUserRole(id, role);
    db.audit(req.user, 'user_role_change', { id, username: target.username, role }, clientIp(req));
  }
  res.json(db.getUserById(id));
});

app.delete('/api/users/:id', requireAdminUser, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  if (target.username === 'admin') {
    return res.status(400).json({ error: 'Cannot delete the admin user' });
  }
  db.deleteUser(id);
  db.audit(req.user, 'user_delete', { id, username: target.username }, clientIp(req));
  res.json({ status: 'deleted' });
});

// Audit

app.get('/api/audit', requireStaff, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  res.json(db.listAudit({ limit, offset }));
});

// Repos

app.get('/api/repos', (req, res) => {
  res.json(db.listRepos().map(r => publicRepoView(r, req.user.role)));
});

app.post('/api/repos', requireStaff, (req, res) => {
  const {
    name, full_name, provider, webhook_secret, enabled,
    git_username, git_token, clone_url,
    poll_enabled, poll_branch,
  } = req.body || {};
  if (!name || typeof name !== 'string' || name.length > 120) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  if (!isValidFullName(full_name)) {
    return res.status(400).json({ error: 'full_name must be owner/repo' });
  }
  const prov = PROVIDERS.includes(provider) ? provider : null;
  if (!prov) return res.status(400).json({ error: `provider must be one of: ${PROVIDERS.join(', ')}` });

  const secret = (webhook_secret && String(webhook_secret).length >= 8)
    ? String(webhook_secret)
    : db.randomToken(24);

  if (git_username && !/^[a-zA-Z0-9._@+-]{1,100}$/.test(String(git_username))) {
    return res.status(400).json({ error: 'Invalid git_username' });
  }
  if (git_token && String(git_token).length > 500) {
    return res.status(400).json({ error: 'git_token too long' });
  }
  if (clone_url && (typeof clone_url !== 'string' || clone_url.length > 500 || !/^https?:\/\//i.test(clone_url))) {
    return res.status(400).json({ error: 'clone_url must be http(s) URL' });
  }
  if (poll_branch && (typeof poll_branch !== 'string' || poll_branch.length > 200 || /[\s]/.test(poll_branch))) {
    return res.status(400).json({ error: 'Invalid poll_branch' });
  }
  if (poll_enabled && (prov === 'gitea' || prov === 'forgejo' || prov === 'generic') && !clone_url) {
    return res.status(400).json({ error: 'clone_url required when polling Gitea/Forgejo/generic' });
  }

  try {
    const repo = db.createRepo({
      name: name.trim(),
      full_name: full_name.trim(),
      provider: prov,
      webhook_secret: secret,
      enabled: enabled !== false,
      git_username: git_username ? String(git_username).trim() : null,
      git_token: git_token ? String(git_token) : null,
      clone_url: clone_url ? String(clone_url).trim() : null,
      poll_enabled: !!poll_enabled,
      poll_branch: poll_branch ? String(poll_branch).trim() : null,
    });
    db.audit(req.user, 'repo_create', {
      id: repo.id,
      full_name: repo.full_name,
      provider: repo.provider,
      has_git_token: !!git_token,
      poll_enabled: !!poll_enabled,
    }, clientIp(req));
    res.status(201).json({ ...publicRepoView(repo, req.user.role), webhook_secret: secret });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Repository already exists for this provider' });
    }
    throw err;
  }
});

app.get('/api/repos/:id', (req, res) => {
  const repo = db.getRepoById(parseInt(req.params.id, 10));
  if (!repo) return res.status(404).json({ error: 'Not found' });
  res.json(publicRepoView(repo, req.user.role));
});

app.patch('/api/repos/:id', requireStaff, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.getRepoById(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const fields = {};
  const body = req.body || {};
  if (body.name !== undefined) fields.name = String(body.name).slice(0, 120);
  if (body.full_name !== undefined) {
    if (!isValidFullName(body.full_name)) return res.status(400).json({ error: 'Invalid full_name' });
    fields.full_name = body.full_name.trim();
  }
  if (body.provider !== undefined) {
    if (!PROVIDERS.includes(body.provider)) return res.status(400).json({ error: 'Invalid provider' });
    fields.provider = body.provider;
  }
  if (body.webhook_secret !== undefined) {
    if (String(body.webhook_secret).length < 8) {
      return res.status(400).json({ error: 'webhook_secret min 8 chars' });
    }
    fields.webhook_secret = String(body.webhook_secret);
  }
  if (body.enabled !== undefined) fields.enabled = !!body.enabled;
  if (body.git_username !== undefined) {
    const u = String(body.git_username).trim();
    if (u && !/^[a-zA-Z0-9._@+-]{1,100}$/.test(u)) {
      return res.status(400).json({ error: 'Invalid git_username' });
    }
    fields.git_username = u || null;
  }
  if (body.git_token !== undefined) {
    // empty string clears; omit field to keep
    if (body.git_token === '' || body.git_token === null) {
      fields.git_token = null;
    } else {
      if (String(body.git_token).length > 500) {
        return res.status(400).json({ error: 'git_token too long' });
      }
      fields.git_token = String(body.git_token);
    }
  }
  if (body.clone_url !== undefined) {
    const cu = String(body.clone_url).trim();
    if (cu && !/^https?:\/\//i.test(cu)) {
      return res.status(400).json({ error: 'clone_url must be http(s) URL' });
    }
    fields.clone_url = cu || null;
  }
  if (body.poll_enabled !== undefined) fields.poll_enabled = !!body.poll_enabled;
  if (body.poll_branch !== undefined) {
    const b = String(body.poll_branch).trim();
    if (b && (b.length > 200 || /\s/.test(b))) {
      return res.status(400).json({ error: 'Invalid poll_branch' });
    }
    fields.poll_branch = b || null;
  }

  const nextPoll = fields.poll_enabled !== undefined ? fields.poll_enabled : !!existing.poll_enabled;
  const nextProv = fields.provider || existing.provider;
  const nextClone = fields.clone_url !== undefined ? fields.clone_url : existing.clone_url;
  if (nextPoll && (nextProv === 'gitea' || nextProv === 'forgejo' || nextProv === 'generic') && !nextClone) {
    return res.status(400).json({ error: 'clone_url required when polling Gitea/Forgejo/generic' });
  }

  try {
    const repo = db.updateRepo(id, fields);
    db.audit(req.user, 'repo_update', { id, fields: Object.keys(fields) }, clientIp(req));
    const view = publicRepoView(repo, req.user.role);
    if (fields.webhook_secret) view.webhook_secret = fields.webhook_secret;
    res.json(view);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Conflict with existing repo' });
    }
    throw err;
  }
});

app.delete('/api/repos/:id', requireStaff, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.getRepoById(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.deleteRepo(id);
  db.audit(req.user, 'repo_delete', { id, full_name: existing.full_name }, clientIp(req));
  res.json({ status: 'deleted' });
});

// Reveal secret (logged)
app.post('/api/repos/:id/reveal-secret', requireStaff, (req, res) => {
  const repo = db.getRepoById(parseInt(req.params.id, 10));
  if (!repo) return res.status(404).json({ error: 'Not found' });
  db.audit(req.user, 'repo_reveal_secret', { id: repo.id, full_name: repo.full_name }, clientIp(req));
  res.json({ webhook_secret: repo.webhook_secret });
});

// Manual poll / catch-up check
app.post('/api/repos/:id/poll', requireStaff, async (req, res) => {
  const repo = db.getRepoById(parseInt(req.params.id, 10));
  if (!repo) return res.status(404).json({ error: 'Not found' });
  const result = await pollRepo(repo, { force: true });
  db.audit(req.user, 'repo_poll', {
    id: repo.id,
    full_name: repo.full_name,
    status: result.status,
    queued: result.queued || 0,
  }, clientIp(req));
  res.json({ ...result, repo: publicRepoView(db.getRepoById(repo.id), req.user.role) });
});

// Repo actions

app.get('/api/repos/:id/actions', (req, res) => {
  const repo = db.getRepoById(parseInt(req.params.id, 10));
  if (!repo) return res.status(404).json({ error: 'Not found' });
  res.json(db.listRepoActions(repo.id));
});

app.put('/api/repos/:id/actions/:keyword', requireAuth, (req, res) => {
  const repo = db.getRepoById(parseInt(req.params.id, 10));
  if (!repo) return res.status(404).json({ error: 'Not found' });

  const keyword = req.params.keyword;
  if (!isValidKeyword(keyword)) return res.status(400).json({ error: 'Invalid keyword' });

  const body = req.body || {};
  const err = validateActionBody(body);
  if (err) return res.status(400).json({ error: err });

  const targetIds = [...new Set((body.notification_target_ids || []).map(Number))];
  for (const id of targetIds) {
    if (!db.getNotification(id, req.user.id)) {
      return res.status(400).json({ error: 'Notification target not found' });
    }
  }

  const config = actionConfigFromBody(body);
  const action = db.upsertRepoAction(repo.id, keyword, body.type, config, body.enabled !== false, req.user.id);
  db.audit(req.user, 'action_upsert', {
    repo_id: repo.id,
    keyword,
    type: body.type,
  }, clientIp(req));
  res.json(action);
});

app.delete('/api/repos/:id/actions/:keyword', requireStaff, (req, res) => {
  const repo = db.getRepoById(parseInt(req.params.id, 10));
  if (!repo) return res.status(404).json({ error: 'Not found' });
  const keyword = req.params.keyword;
  if (!isValidKeyword(keyword)) return res.status(400).json({ error: 'Invalid keyword' });
  if (!db.deleteRepoAction(repo.id, keyword)) {
    return res.status(404).json({ error: 'Action not found' });
  }
  db.audit(req.user, 'action_delete', { repo_id: repo.id, keyword }, clientIp(req));
  res.json({ status: 'deleted' });
});

app.post('/api/repos/:id/actions/:keyword/run', (req, res) => {
  const repo = db.getRepoById(parseInt(req.params.id, 10));
  if (!repo) return res.status(404).json({ error: 'Not found' });
  const keyword = req.params.keyword;
  if (!isValidKeyword(keyword)) return res.status(400).json({ error: 'Invalid keyword' });

  if (maintenanceMode()) {
    return res.status(409).json({ error: 'Maintenance mode: manual runs are paused' });
  }

  const action = db.getRepoAction(repo.id, keyword);
  if (!action) return res.status(404).json({ error: 'Action not found' });

  const ts = Date.now();
  const jobId = `manual_${repo.slug}_${keyword}_${ts}`;
  const logPath = path.join(
    LOGS_DIR,
    `manual_${sanitizeLogFileName(repo.slug)}_${sanitizeLogFileName(keyword)}_${ts}.log`
  );

  enqueue({
    id: jobId,
    name: keyword,
    type: action.type,
    action,
    logPath,
    repo: repo.full_name,
    repo_id: repo.id,
    provider: repo.provider,
    trigger: `manual:${req.user.username}`,
  });

  db.audit(req.user, 'action_run', { repo_id: repo.id, keyword, job_id: jobId }, clientIp(req));
  res.json({ status: 'enqueued', job_id: jobId });
});

// Deployment machines (staff manage; all users may list them for action selection)

const MACHINE_HOST_RE = /^[a-zA-Z0-9._:-]+$/;
const MACHINE_USER_RE = /^[a-zA-Z0-9._-]+$/;

function sanitizeMachineBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Invalid payload' };
  }
  const name = String(body.name ?? '').trim();
  const ssh_user = String(body.ssh_user ?? '').trim();
  const host = String(body.host ?? '').trim();
  if (!name) return { error: 'Name required' };
  if (name.length > 100) return { error: 'Name too long' };
  if (!ssh_user) return { error: 'SSH user required' };
  if (!MACHINE_USER_RE.test(ssh_user)) return { error: 'Invalid SSH user' };
  if (!host) return { error: 'Host required' };
  if (!MACHINE_HOST_RE.test(host)) return { error: 'Invalid host' };
  const port = body.port === undefined || body.port === '' || body.port === null
    ? 22
    : Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'Invalid port (1-65535)' };
  const ssh_key = String(body.ssh_key ?? '').trim().slice(0, 100);
  if (ssh_key && !db.getSshKeyByName(ssh_key)) return { error: 'SSH key not found' };
  const ssh_options = String(body.ssh_options ?? '').trim().slice(0, 2000);
  return { clean: { name, ssh_user, host, port, ssh_key, ssh_options } };
}

app.get('/api/machines', requireAuth, (req, res) => {
  const isStaff = req.user.role === 'admin' || req.user.role === 'devops';
  res.json(db.listDeployMachines().map(m => {
    if (isStaff) return m;
    return { id: m.id, name: m.name, ssh_user: m.ssh_user, host: m.host, port: m.port };
  }));
});

app.post('/api/machines', requireStaff, (req, res) => {
  const { error, clean } = sanitizeMachineBody(req.body);
  if (error) return res.status(400).json({ error });
  let machine;
  try {
    machine = db.createDeployMachine(clean);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'A machine with that name already exists' });
    }
    throw e;
  }
  db.audit(req.user, 'machine_create', { id: machine.id, name: machine.name }, clientIp(req));
  res.status(201).json(machine);
});

app.patch('/api/machines/:id', requireStaff, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.getDeployMachineById(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { error, clean } = sanitizeMachineBody(req.body);
  if (error) return res.status(400).json({ error });
  let machine;
  try {
    machine = db.updateDeployMachine(id, clean);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'A machine with that name already exists' });
    }
    throw e;
  }
  db.audit(req.user, 'machine_update', { id, name: machine.name }, clientIp(req));
  res.json(machine);
});

app.delete('/api/machines/:id', requireStaff, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const machine = db.getDeployMachineById(id);
  if (!machine) return res.status(404).json({ error: 'Not found' });
  const uses = db.countActionUsesForMachine(id);
  if (uses > 0) {
    return res.status(409).json({
      error: `In use by ${uses} action(s). Remove it from those actions first.`,
    });
  }
  db.deleteDeployMachine(id);
  db.audit(req.user, 'machine_delete', { id, name: machine.name }, clientIp(req));
  res.json({ status: 'deleted' });
});

// SSH keys (uploaded private keys, stored encrypted at rest)

const SSH_KEY_NAME_RE = /^[a-zA-Z0-9 _.-]{1,100}$/;
const SSH_KEY_MAX_BYTES = 16384;

app.get('/api/sshkeys', requireStaff, (req, res) => {
  res.json(db.listSshKeys());
});

app.post('/api/sshkeys', requireStaff, (req, res) => {
  const body = req.body || {};
  const name = String(body.name ?? '').trim();
  const content = typeof body.content === 'string' ? body.content : '';
  if (!SSH_KEY_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid key name' });
  if (!content.trim()) return res.status(400).json({ error: 'Key file content required' });
  if (Buffer.byteLength(content, 'utf8') > SSH_KEY_MAX_BYTES) return res.status(400).json({ error: 'Key file too large (max 16 KB)' });
  if (!content.includes('PRIVATE KEY') && !content.includes('OPENSSH PRIVATE KEY')) {
    return res.status(400).json({ error: 'Not a private key file' });
  }
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 24);
  let key;
  try {
    key = db.createSshKey({ name, key_data: encryptSecret(content), fingerprint });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'A key with that name already exists' });
    }
    throw e;
  }
  db.audit(req.user, 'ssh_key_create', { id: key.id, name: key.name }, clientIp(req));
  res.status(201).json(key);
});

app.delete('/api/sshkeys/:id', requireStaff, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const key = db.getSshKeyById(id);
  if (!key) return res.status(404).json({ error: 'Not found' });
  const uses = db.countMachineUsesForKey(key.name);
  if (uses > 0) {
    return res.status(409).json({
      error: `In use by ${uses} machine(s). Remove it from those machines first.`,
    });
  }
  db.deleteSshKey(id);
  db.audit(req.user, 'ssh_key_delete', { id, name: key.name }, clientIp(req));
  res.json({ status: 'deleted' });
});

// Scripts

app.get('/api/scripts', (req, res) => {
  res.json(getScriptsList());
});

app.get('/api/scripts/:name', (req, res) => {
  const content = readScript(req.params.name);
  if (content === null) return res.status(404).json({ error: 'Script not found' });
  res.json({ name: req.params.name, content });
});

app.post('/api/scripts/:name', requireStaff, (req, res) => {
  const name = req.params.name;
  const { content } = req.body || {};
  if (!isValidScriptName(name)) return res.status(400).json({ error: 'Invalid script name' });
  if (typeof content !== 'string') return res.status(400).json({ error: 'Missing content' });
  if (!writeScript(name, content)) return res.status(500).json({ error: 'Failed to save' });
  db.audit(req.user, 'script_save', { name }, clientIp(req));
  res.json({ status: 'saved', name });
});

app.delete('/api/scripts/:name', requireStaff, (req, res) => {
  const name = req.params.name;
  if (!isValidScriptName(name)) return res.status(400).json({ error: 'Invalid script name' });
  if (!deleteScript(name)) return res.status(500).json({ error: 'Failed to delete' });
  db.audit(req.user, 'script_delete', { name }, clientIp(req));
  res.json({ status: 'deleted' });
});

// Global settings (staff only)

app.get('/api/settings', requireStaff, (req, res) => {
  res.json({ settings: getSettings(), version: APP_VERSION });
});

app.put('/api/settings', requireStaff, (req, res) => {
  const { error, clean } = sanitizeSettings(req.body);
  if (error) return res.status(400).json({ error });
  db.setSettings(clean);
  if ('poll_interval_ms' in clean) schedulePoll();
  db.audit(req.user, 'settings_update', clean, clientIp(req));
  res.json({ settings: getSettings() });
});

// Download a consistent SQLite snapshot (WAL-safe via better-sqlite3 backup)
app.post('/api/settings/backup', requireStaff, (req, res) => {
  const tmp = path.join(os.tmpdir(), `at-field-ci-backup-${Date.now()}.db`);
  db.getDb().backup(tmp).then(() => {
    res.download(tmp, `at-field-ci-backup-${new Date().toISOString().slice(0, 10)}.db`, () => {
      fs.unlink(tmp, () => {});
    });
  }).catch(err => {
    console.error('[BACKUP]', err.message);
    res.status(500).json({ error: 'Backup failed' });
  });
});

// Logs

app.get('/api/logs', (req, res) => {
  res.json(getLogFilesList());
});

// Run details: single job run row + its log content

app.get('/api/runs/:id', requireAuth, (req, res) => {
  const run = db.getRunById(parseInt(req.params.id, 10));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  let log = null;
  if (run.log_file) {
    const content = readLogFile(run.log_file);
    if (content !== null) log = content;
  }
  res.json({ run, log });
});

app.get('/api/logs/:filename', (req, res) => {
  const content = readLogFile(req.params.filename);
  if (content === null) return res.status(404).json({ error: 'Log not found' });
  res.json({ filename: req.params.filename, content });
});

// Health

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Session cleanup hourly
setInterval(() => {
  try { db.purgeExpiredSessions(); } catch (e) { /* ignore */ }
}, 60 * 60 * 1000).unref();

// Log retention: delete log files older than the configured number of days
setInterval(() => {
  try { cleanOldLogs(); } catch (e) { /* ignore */ }
}, 60 * 60 * 1000).unref();

function cleanOldLogs() {
  const days = parseInt(getSetting('log_retention_days'), 10) || 0;
  if (days <= 0) return;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(LOGS_DIR)) {
    const file = path.join(LOGS_DIR, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch { /* ignore */ }
  }
  if (removed) console.log(`[CLEANUP] Removed ${removed} old log file(s)`);
}

startPollLoop();

app.listen(PORT, () => {
  console.log(`[SERVER] AT FIELD CICD on :${PORT}`);
  console.log(`[SERVER] DB: ${db.DB_PATH}`);
  console.log(`[SERVER] Dashboard: http://localhost:${PORT}`);
  console.log(`[SERVER] Webhook: POST /webhook or /webhook/:slug`);
  console.log(`[SERVER] Poll: enabled repos checked every ${getSetting('poll_interval_ms')}ms`);
});
