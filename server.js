#!/usr/bin/env node
'use strict';

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const yaml = require('js-yaml');
const db = require('./lib/db');
const poller = require('./lib/poller');

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
const POLL_INTERVAL_MS = Math.max(
  15_000,
  parseInt(process.env.POLL_INTERVAL_MS || '60000', 10) || 60_000
);
const COOKIE_NAME = 'ci_session';
// Only set Secure cookies when explicitly enabled (requires HTTPS)
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const ADMIN_USER = process.env.ADMIN_USER || process.env.DASHBOARD_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.DASHBOARD_PASSWORD || '';

const CONFIG_FILE = path.join(__dirname, 'config.yaml');
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

try {
  if (fs.existsSync(CONFIG_FILE)) {
    const cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
    const migrated = db.migrateFromYaml(cfg.actions);
    if (migrated) {
      console.log(`[DB] Migrated ${Object.keys(cfg.actions || {}).length} actions from config.yaml to repo #${migrated.id} (${migrated.slug})`);
    }
  }
} catch (err) {
  console.error('[DB] YAML migrate skipped:', err.message);
}

// STATE

let jobQueue = [];
let currentJob = null;
let isProcessing = false;
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
  jobQueue.push(job);
  processQueue();
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

function startPollLoop() {
  const run = () => {
    pollAllRepos().catch(err => console.error('[POLL] cycle failed:', err.message));
  };
  // Catch up shortly after boot (missed pushes while offline)
  setTimeout(run, 5_000).unref();
  setInterval(run, POLL_INTERVAL_MS).unref();
  console.log(`[POLL] interval ${POLL_INTERVAL_MS}ms (set POLL_INTERVAL_MS to change)`);
}

function processQueue() {
  if (isProcessing || !jobQueue.length) return;
  isProcessing = true;
  currentJob = jobQueue.shift();

  try {
    runJob(currentJob, (err) => {
      isProcessing = false;
      currentJob = null;
      if (err) console.error('[QUEUE] Job failed:', err.message);
      processQueue();
    });
  } catch (err) {
    console.error('[QUEUE] Sync error:', err.message);
    isProcessing = false;
    currentJob = null;
    processQueue();
  }
}

function runJob(job, callback) {
  const { type, name, logPath } = job;
  writeToLog(logPath, `[${new Date().toISOString()}] Starting job: ${name} (type: ${type})\n`);
  if (job.repo) writeToLog(logPath, `Repo: ${job.repo}\n`);
  if (job.trigger) writeToLog(logPath, `Trigger: ${job.trigger}\n`);

  if (type === 'script') runScriptJob(job, logPath, callback);
  else if (type === 'deploy') runDeployJob(job, logPath, callback);
  else {
    writeToLog(logPath, `[ERROR] Unknown job type: ${type}\n`);
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
    timeout: 30 * 60 * 1000,
  });

  child.stdout.on('data', d => writeToLog(logPath, d.toString('utf8')));
  child.stderr.on('data', d => writeToLog(logPath, '[STDERR] ' + d.toString('utf8')));
  child.on('error', err => {
    writeToLog(logPath, `[ERROR] spawn: ${err.message}\n`);
    callback(err);
  });
  child.on('close', code => {
    writeToLog(logPath, `[${new Date().toISOString()}] Exit code: ${code}\n`);
    callback(code === 0 ? null : new Error(`Exit code: ${code}`));
  });
}

function runDeployJob(job, logPath, callback) {
  const method = job.action.method || 'ssh';
  if (method === 'rsync') runRsyncDeploy(job.action, logPath, callback);
  else if (method === 'ssh') runSshDeploy(job.action, logPath, callback);
  else {
    writeToLog(logPath, `[ERROR] Unknown deploy method: ${method}\n`);
    callback(new Error('Unknown deploy method'));
  }
}

function runRsyncDeploy(action, logPath, callback) {
  const { source, destination, user, host, sshKey, sshOptions } = action;
  if (!source || !destination || !user || !host) {
    writeToLog(logPath, '[ERROR] Missing rsync params\n');
    return callback(new Error('Missing required parameters'));
  }

  const sourcePath = path.resolve(path.join(__dirname, source));
  if (!sourcePath.startsWith(path.resolve(__dirname) + path.sep) && sourcePath !== path.resolve(__dirname)) {
    writeToLog(logPath, '[ERROR] Source path traversal\n');
    return callback(new Error('Path traversal blocked'));
  }

  if (typeof host !== 'string' || !/^[a-zA-Z0-9._:-]+$/.test(host)) {
    writeToLog(logPath, '[ERROR] Invalid host\n');
    return callback(new Error('Invalid host'));
  }
  if (typeof user !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(user)) {
    writeToLog(logPath, '[ERROR] Invalid user\n');
    return callback(new Error('Invalid user'));
  }

  const args = ['-av'];
  if (sshKey || sshOptions) {
    let sshCmd = 'ssh';
    if (sshKey) {
      const escapedKey = String(sshKey).replace(/'/g, "'\\''");
      sshCmd += ` -i '${escapedKey}'`;
    }
    if (sshOptions) sshCmd += ` ${sshOptions}`;
    args.push('-e', sshCmd);
  }
  args.push(sourcePath, `${user}@${host}:${destination}`);

  const child = spawn('rsync', args, { timeout: 60 * 60 * 1000 });
  child.stdout.on('data', d => writeToLog(logPath, d.toString('utf8')));
  child.stderr.on('data', d => writeToLog(logPath, '[STDERR] ' + d.toString('utf8')));
  child.on('error', err => {
    writeToLog(logPath, `[ERROR] rsync: ${err.message}\n`);
    callback(err);
  });
  child.on('close', code => {
    writeToLog(logPath, `[${new Date().toISOString()}] rsync exit: ${code}\n`);
    callback(code === 0 ? null : new Error(`rsync exit: ${code}`));
  });
}

function runSshDeploy(action, logPath, callback) {
  const { command, user, host, sshKey, sshOptions } = action;
  if (!command || !user || !host) {
    writeToLog(logPath, '[ERROR] Missing SSH params\n');
    return callback(new Error('Missing required parameters'));
  }
  if (typeof host !== 'string' || !/^[a-zA-Z0-9._:-]+$/.test(host)) {
    writeToLog(logPath, '[ERROR] Invalid host\n');
    return callback(new Error('Invalid host'));
  }
  if (typeof user !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(user)) {
    writeToLog(logPath, '[ERROR] Invalid user\n');
    return callback(new Error('Invalid user'));
  }

  const args = [];
  if (sshKey) args.push('-i', sshKey);
  if (sshOptions) args.push(...String(sshOptions).split(/\s+/).filter(Boolean));
  args.push(`${user}@${host}`, command);

  const child = spawn('ssh', args, { timeout: 30 * 60 * 1000 });
  child.stdout.on('data', d => writeToLog(logPath, d.toString('utf8')));
  child.stderr.on('data', d => writeToLog(logPath, '[STDERR] ' + d.toString('utf8')));
  child.on('error', err => {
    writeToLog(logPath, `[ERROR] ssh: ${err.message}\n`);
    callback(err);
  });
  child.on('close', code => {
    writeToLog(logPath, `[${new Date().toISOString()}] SSH exit: ${code}\n`);
    callback(code === 0 ? null : new Error(`SSH exit: ${code}`));
  });
}

function validateActionBody(action) {
  if (!action || !action.type || !['script', 'deploy'].includes(action.type)) {
    return 'Invalid action type';
  }
  if (action.type === 'script') {
    if (!action.script) return 'Missing script name';
    if (!normalizeScriptPath(action.script)) return 'Invalid script path';
  } else {
    if (!action.method || !['rsync', 'ssh'].includes(action.method)) return 'Invalid deploy method';
    if (!action.user || !action.host) return 'Missing user or host';
    if (typeof action.host !== 'string' || !/^[a-zA-Z0-9._:-]+$/.test(action.host)) return 'Invalid host';
    if (typeof action.user !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(action.user)) return 'Invalid user';
    if (action.method === 'rsync') {
      if (!action.source || !action.destination) return 'rsync requires source and destination';
      const normSource = String(action.source).replace(/^\.\//, '');
      if (normSource.includes('..') || normSource.startsWith('/')) return 'Invalid rsync source path';
    }
    if (action.method === 'ssh' && !action.command) return 'ssh requires command';
  }
  return null;
}

function actionConfigFromBody(action) {
  if (action.type === 'script') {
    return { script: normalizeScriptPath(action.script) || action.script };
  }
  const cfg = {
    method: action.method,
    user: action.user,
    host: action.host,
  };
  if (action.sshKey) cfg.sshKey = action.sshKey;
  if (action.sshOptions) cfg.sshOptions = action.sshOptions;
  if (action.method === 'rsync') {
    cfg.source = action.source;
    cfg.destination = action.destination;
  } else {
    cfg.command = action.command;
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
  res.json({ user });
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

app.post('/webhook', (req, res) => handleWebhook(req, res, null));

app.post('/webhook/:slug', (req, res) => {
  const repo = db.getRepoBySlug(req.params.slug);
  if (!repo) return res.status(404).json({ error: 'Unknown webhook endpoint' });
  handleWebhook(req, res, repo);
});

// Static + protected API
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', requireAuth);

// Status

app.get('/api/status', (req, res) => {
  res.json({
    current: currentJob
      ? { id: currentJob.id, name: currentJob.name, type: currentJob.type, repo: currentJob.repo }
      : null,
    queue_length: jobQueue.length,
    is_processing: isProcessing,
    user: req.user,
    poll: {
      interval_ms: POLL_INTERVAL_MS,
      last_cycle_at: lastPollCycleAt,
      last_cycle: lastPollCycleSummary,
    },
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

app.put('/api/repos/:id/actions/:keyword', requireStaff, (req, res) => {
  const repo = db.getRepoById(parseInt(req.params.id, 10));
  if (!repo) return res.status(404).json({ error: 'Not found' });

  const keyword = req.params.keyword;
  if (!isValidKeyword(keyword)) return res.status(400).json({ error: 'Invalid keyword' });

  const body = req.body || {};
  const err = validateActionBody(body);
  if (err) return res.status(400).json({ error: err });

  const config = actionConfigFromBody(body);
  const action = db.upsertRepoAction(repo.id, keyword, body.type, config, body.enabled !== false);
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

// Logs

app.get('/api/logs', (req, res) => {
  res.json(getLogFilesList());
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

startPollLoop();

app.listen(PORT, () => {
  console.log(`[SERVER] AT Field CI on :${PORT}`);
  console.log(`[SERVER] DB: ${db.DB_PATH}`);
  console.log(`[SERVER] Dashboard: http://localhost:${PORT}`);
  console.log(`[SERVER] Webhook: POST /webhook or /webhook/:slug`);
  console.log(`[SERVER] Poll: enabled repos checked every ${POLL_INTERVAL_MS}ms`);
});
