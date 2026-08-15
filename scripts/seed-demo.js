#!/usr/bin/env node
/**
 * Seed the local dev database with realistic demo data:
 * users, ssh keys, deployment machines, repos, scripts, actions,
 * notifications, job runs (with log files) and audit entries.
 *
 * WARNING: this deletes data/at-field-ci.db and the logs/ directory.
 *
 * Run:
 *   node scripts/seed-demo.js
 *   ADMIN_USER=admin ADMIN_PASSWORD=admin node server.js
 *
 * Login creds (all password = "demo1234"):
 *   admin      (admin)
 *   sarah.ops  (devops)
 *   mike.dev   (developer)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LOGS_DIR = path.join(ROOT, 'logs');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

// ---------------------------------------------------------------------------
// 1. Wipe the DB and logs
// ---------------------------------------------------------------------------

for (const f of fs.readdirSync(DATA_DIR)) {
  if (f.startsWith('at-field-ci.db')) fs.unlinkSync(path.join(DATA_DIR, f));
}
for (const f of fs.readdirSync(LOGS_DIR)) {
  fs.unlinkSync(path.join(LOGS_DIR, f));
}
console.log('[seed] wiped database + logs');

const db = require('../lib/db');
db.init();

// ---------------------------------------------------------------------------
// 2. Users
// ---------------------------------------------------------------------------

const PASSWORD = 'demo1234';
const admin = db.createUser('admin', PASSWORD, 'admin');
const sarah = db.createUser('sarah.ops', PASSWORD, 'devops');
const mike = db.createUser('mike.dev', PASSWORD, 'developer');
console.log('[seed] users:', [admin.username, sarah.username, mike.username].join(', '));

// ---------------------------------------------------------------------------
// 3. SSH keys
// ---------------------------------------------------------------------------

function fakePrivateKey(label) {
  return `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdzc2gtcn
NhAAAAAwEAAQAAAYEA1rHt0vsFv8YXN0q1LmWGhZlO8vnNQnQ3mT6kXwDgPcFKfKl2YFk8
sBq0hQ8UwzjCud3qVbe8xYJ3R9uQ2xBhVkR4eT7fY9fL3mYt0SfQ7NvC9gB5eH6QkP2r7E0
ZZy3TjZlOK5tW3e1g0q1w0oKZfY8sQx0rPdHd8JhZ5hJ3O5tW3e1g0q1w0oKZfY8sQx0r
PdHd8JhZ5hJ3O5tW3e1g0q1w0oKZfY8sQx0rPdHd8JhZ5hJ3O5tW3e1g0q1w0oKZfY8sQ
x0rPdHd8JhZ5hJ3O5tW3e1g0q1w0oKZfY8sQx0rPdHd8JhZ5hJ3O5tW3e1g0q1w0oKZfY
8sQx0rPdHd8JhZ5hJ3O5tW3e1g0q1w0oKZfY8sQx0rPdHd8JhZ5hJ3O5tW3e1g0q1w0oKZ
fY8sQx0rPdHd8JhZ5hJ3O5tW3e1g0q1w0oKZfY8sQx0rPdHd8JhZ5hJ3O5tW3e1g0q1w0o
-----END OPENSSH PRIVATE KEY-----`;
}

const keyWebProd = db.createSshKey({
  name: 'web-prod-key',
  key_data: fakePrivateKey('web-prod'),
  fingerprint: 'SHA256:q6kW9cJ2lF0bXpZ7vR2mN4sD8tY3hG5jK1aW0eR',
});
const keyDb = db.createSshKey({
  name: 'db-backup-key',
  key_data: fakePrivateKey('db-backup'),
  fingerprint: 'SHA256:a7sDf3gH5jK9lP0oI2uY6tR4eW1qZ8xNm0bVc',
});
const keyStaging = db.createSshKey({
  name: 'staging-key',
  key_data: fakePrivateKey('staging'),
  fingerprint: 'SHA256:z8xQw2eR4tY6uI0oP9aSdF7gH3jK1lZm5nBv',
});
console.log('[seed] ssh keys:', [keyWebProd.name, keyDb.name, keyStaging.name].join(', '));

// ---------------------------------------------------------------------------
// 4. Deployment machines
// ---------------------------------------------------------------------------

const machineWebProd = db.createDeployMachine({
  name: 'web-prod-01',
  ssh_user: 'deploy',
  host: 'web-01.at-field-cicd.com',
  port: 22,
  ssh_key: 'web-prod-key',
  ssh_options: 'StrictHostKeyChecking=accept-new',
});
const machineApiProd = db.createDeployMachine({
  name: 'api-prod-01',
  ssh_user: 'deploy',
  host: 'api-01.at-field-cicd.com',
  port: 2222,
  ssh_key: 'web-prod-key',
});
const machineDbProd = db.createDeployMachine({
  name: 'db-prod-01',
  ssh_user: 'backup',
  host: 'db-01.at-field-cicd.com',
  ssh_key: 'db-backup-key',
});
const machineWebStaging = db.createDeployMachine({
  name: 'web-staging-01',
  ssh_user: 'deploy',
  host: 'staging-01.at-field-cicd.com',
  port: 22,
  ssh_key: 'staging-key',
});
console.log('[seed] machines:', [
  machineWebProd.name, machineApiProd.name, machineDbProd.name, machineWebStaging.name,
].join(', '));

// ---------------------------------------------------------------------------
// 5. Repositories
// ---------------------------------------------------------------------------

function mkRepo({ name, full_name, provider, poll = false, token = false }) {
  return db.createRepo({
    name,
    full_name,
    provider,
    webhook_secret: require('crypto').randomBytes(32).toString('hex'),
    enabled: 1,
    git_username: token ? 'ci-bot' : null,
    git_token: token ? 'ghp_demo_token_1234567890abcdef' : null,
    clone_url: null,
    poll_enabled: poll ? 1 : 0,
    poll_branch: poll ? 'main' : null,
  });
}

const repoWeb = mkRepo({ name: 'Acme Webstore', full_name: 'acme/webstore', provider: 'github', poll: true });
const repoApi = mkRepo({ name: 'Acme API', full_name: 'acme/api', provider: 'github', token: true });
const repoDocs = mkRepo({ name: 'Acme Docs', full_name: 'acme/docs', provider: 'forgejo' });
const repoMobile = mkRepo({ name: 'Acme Mobile', full_name: 'acme/mobile-app', provider: 'github', poll: true });
console.log('[seed] repos:', [repoWeb.full_name, repoApi.full_name, repoDocs.full_name, repoMobile.full_name].join(', '));

// ---------------------------------------------------------------------------
// 6. Scripts (files in scripts/)
// ---------------------------------------------------------------------------

const demoScripts = {
  'deploy-webstore.sh': `#!/bin/bash
set -euo pipefail
echo "==> Deploying Acme Webstore (\${CI_KEYWORD:-deploy})"
echo "==> Machine: \${CI_MACHINES:-n/a}"
cd /var/www/webstore
rsync -a --delete /tmp/deploy/ ./ 2>/dev/null || echo "(rsync stage skipped - local)"
echo "==> Restarting services"
sudo systemctl restart webstore
echo "==> Health check"
curl -sf http://localhost/health && echo "OK" || echo "WARN"
echo "==> Deploy finished in \${CI_DURATION:-0}s"
`,
  'migrate-db.sh': `#!/bin/bash
set -euo pipefail
echo "==> Running DB migrations"
psql "\$DATABASE_URL" -f /srv/migrations/\$(cat /srv/migrations/latest) 
echo "==> VACUUM ANALYZE"
psql "\$DATABASE_URL" -c "VACUUM ANALYZE;"
echo "==> Migrations complete"
`,
  'backup-postgres.sh': `#!/bin/bash
set -euo pipefail
STAMP=\$(date +%Y%m%d-%H%M%S)
echo "==> Dumping production database"
pg_dump --format=custom --file=/backups/acme-\$STAMP.dump acme_prod
echo "==> Rotating old backups"
find /backups -name 'acme-*.dump' -mtime +14 -delete
echo "==> Backup complete: acme-\$STAMP.dump"
`,
  'smoke-test-api.sh': `#!/bin/bash
set -euo pipefail
echo "==> Smoke testing API endpoints"
BASE="\${API_BASE:-http://localhost:8080}"
curl -sf "\$BASE/health" > /dev/null && echo "health: OK"
curl -sf "\$BASE/api/v1/products?limit=1" > /dev/null && echo "products: OK"
curl -sf -X POST "\$BASE/api/v1/auth/login" -d '{}' -o /dev/null && echo "auth: OK"
echo "==> All smoke tests passed"
`,
};

for (const [name, content] of Object.entries(demoScripts)) {
  fs.writeFileSync(path.join(SCRIPTS_DIR, name), content, 'utf8');
  fs.chmodSync(path.join(SCRIPTS_DIR, name), 0o755);
}
console.log('[seed] scripts:', Object.keys(demoScripts).join(', '));

// ---------------------------------------------------------------------------
// 7. Actions
// ---------------------------------------------------------------------------

db.upsertRepoAction(repoWeb.id, 'deploy-webstore', 'deploy', {
  script: 'deploy-webstore.sh',
  machine_ids: [machineWebProd.id, machineWebStaging.id],
  method: 'ssh',
  command: 'sudo systemctl reload nginx && echo deployed',
}, 1, admin.id);

db.upsertRepoAction(repoApi.id, 'migrate-db', 'deploy', {
  script: 'migrate-db.sh',
  machine_ids: [machineDbProd.id],
  method: 'ssh',
  command: 'true',
}, 1, sarah.id);

db.upsertRepoAction(repoApi.id, 'smoke-test', 'script', {
  script: 'smoke-test-api.sh',
  machine_ids: [machineApiProd.id],
  method: 'ssh',
  command: 'true',
}, 1, mike.id);

db.upsertRepoAction(repoApi.id, 'backup-db', 'script', {
  script: 'backup-postgres.sh',
  machine_ids: [machineDbProd.id],
  method: 'ssh',
  command: 'true',
}, 1, sarah.id);

db.upsertRepoAction(repoDocs.id, 'publish-docs', 'deploy', {
  script: 'deploy-webstore.sh',
  machine_ids: [machineWebStaging.id],
  method: 'rsync',
  source: '/tmp/docs',
  destination: '/srv/www/docs',
}, 1, admin.id);

console.log('[seed] actions: deploy-webstore, migrate-db, smoke-test, backup-db, publish-docs');

// ---------------------------------------------------------------------------
// 8. Notifications
// ---------------------------------------------------------------------------

const notifSlack = db.createNotification({
  userId: admin.id,
  name: 'Acme #ci-deploys (Slack)',
  type: 'slack',
  config: { url: 'https://hooks.slack.com/services/T04A7B9C2D/B05E8F1G3H/t9xK4mQ8vL2nW7rY5sB3cD6' },
  events: ['job_start', 'job_success', 'job_failure'],
  enabled: 1,
});
const notifDiscord = db.createNotification({
  userId: admin.id,
  name: 'CI Alerts (Discord)',
  type: 'discord',
  config: { url: 'https://discord.com/api/webhooks/1123456789012345678/4xKj0mQ8vL2nW7rY5sB3cD6E9fG1hJ2kL4mN5oP6qR7sT8uV9wX0yZ1aB2cD3eF4' },
  events: ['job_failure', 'job_timeout'],
  enabled: 1,
});
const notifTelegram = db.createNotification({
  userId: sarah.id,
  name: 'Sarah Telegram',
  type: 'telegram',
  config: { bot_token: '7312456789:AAGhX9kL2mQ8vW7rY5sB3cD6E9fG1hJ2kL4mN5oP', chat_id: '-1001987654321' },
  events: ['job_failure'],
  enabled: 1,
});
const notifGeneric = db.createNotification({
  userId: admin.id,
  name: 'Statuspage Webhook',
  type: 'generic',
  config: {
    url: 'https://status.at-field-cicd.com/hooks/ci',
    token: 'stsp_live_4f8a2d91c7b3e6a0d9f5c1b2',
    message_template: '{{title}}\n{{message}}',
  },
  events: ['job_success', 'job_failure'],
  enabled: 1,
});
console.log('[seed] notifications:', [notifSlack.name, notifDiscord.name, notifTelegram.name, notifGeneric.name].join(', '));

// ---------------------------------------------------------------------------
// 9. Job runs with realistic log files (14 days of history)
// ---------------------------------------------------------------------------

function sampleLog({ keyword, repo, machine, status, durationSec }) {
  const lines = [];
  const started = new Date(Date.now() - durationSec * 1000).toISOString();
  lines.push(`[${started}] Starting job: ${keyword} (type: deploy)`);
  lines.push(`Repo: ${repo}`);
  lines.push(`Trigger: commit:abc1234`);
  lines.push(`[DEPLOY] Machine ${machine} (deploy@web-01.at-field-cicd.com)`);
  lines.push(`[SSH] deploy@web-01.at-field-cicd.com: connected`);
  lines.push(`[DEPLOY] rsync deploy stage -> /tmp/deploy/`);
  lines.push(`[RUN] Executing script: ${keyword}.sh`);
  lines.push(`==> Deploying (CI simulation)`);
  lines.push(`==> Restarting services: ok`);
  if (status === 'success') {
    lines.push(`==> Health check: OK`);
    lines.push(`[${new Date().toISOString()}] Job finished: success (${durationSec}s)`);
  } else if (status === 'fail') {
    lines.push(`==> Health check: FAILED (exit 1)`);
    lines.push(`[${new Date().toISOString()}] Job finished: fail (${durationSec}s)`);
  } else {
    lines.push(`==> Health check: TIMED OUT`);
    lines.push(`[${new Date().toISOString()}] Job finished: timeout (${durationSec}s)`);
  }
  return lines.join('\n') + '\n';
}

const jobTemplates = [
  { repo: repoWeb, keyword: 'deploy-webstore', type: 'deploy', machine: 'web-prod-01', weight: 8 },
  { repo: repoApi, keyword: 'migrate-db', type: 'deploy', machine: 'db-prod-01', weight: 3 },
  { repo: repoApi, keyword: 'smoke-test', type: 'script', machine: 'api-prod-01', weight: 6 },
  { repo: repoApi, keyword: 'backup-db', type: 'script', machine: 'db-prod-01', weight: 2 },
  { repo: repoDocs, keyword: 'publish-docs', type: 'deploy', machine: 'web-staging-01', weight: 2 },
];

const triggers = ['commit:abc1234', 'commit:def5678', 'manual:sarah.ops', 'manual:admin', 'poll:main'];
const statuses = ['success', 'success', 'success', 'success', 'fail', 'success', 'timeout'];

let runSeq = 0;
for (let day = 13; day >= 0; day -= 1) {
  const runsToday = 2 + Math.floor(Math.random() * 4); // 2-5 runs per day
  for (let i = 0; i < runsToday; i += 1) {
    const tpl = jobTemplates[Math.floor(Math.random() * jobTemplates.length)];
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    const durationSec = 2 + Math.floor(Math.random() * 28);
    const started = new Date();
    started.setDate(started.getDate() - day);
    started.setHours(9 + Math.floor(Math.random() * 10), Math.floor(Math.random() * 60), Math.floor(Math.random() * 60), 0);

    const ts = started.getTime();
    const jobId = `${tpl.repo.slug}_${tpl.keyword}_${ts}_${runSeq++}`;
    const logFile = `${tpl.repo.slug}_${tpl.keyword}_${ts}_${i}.log`;

    const runId = db.recordJobStart({
      jobId,
      repoId: tpl.repo.id,
      repoName: tpl.repo.full_name,
      keyword: tpl.keyword,
      type: tpl.type,
      trigger: triggers[Math.floor(Math.random() * triggers.length)],
      logFile,
    });
    db.recordJobFinish(runId, {
      status,
      durationMs: durationSec * 1000,
      exitCode: status === 'success' ? 0 : 1,
    });

    fs.writeFileSync(
      path.join(LOGS_DIR, logFile),
      sampleLog({
        keyword: tpl.keyword,
        repo: tpl.repo.full_name,
        machine: tpl.machine,
        status,
        durationSec,
      }),
      'utf8'
    );

    // backdate the log file mtime so the Logs tab sorts naturally
    fs.utimesSync(path.join(LOGS_DIR, logFile), started, started);
  }
}
console.log('[seed] job runs + log files created');

// ---------------------------------------------------------------------------
// 10. Audit trail
// ---------------------------------------------------------------------------

const auditActions = [
  ['repo_create', { id: repoWeb.id, full_name: repoWeb.full_name, provider: repoWeb.provider }],
  ['repo_create', { id: repoApi.id, full_name: repoApi.full_name, provider: repoApi.provider }],
  ['repo_create', { id: repoDocs.id, full_name: repoDocs.full_name, provider: repoDocs.provider }],
  ['machine_create', { id: machineWebProd.id, name: machineWebProd.name }],
  ['machine_create', { id: machineDbProd.id, name: machineDbProd.name }],
  ['key_upload', { name: keyWebProd.name }],
  ['action_upsert', { repo_id: repoWeb.id, keyword: 'deploy-webstore' }],
  ['action_upsert', { repo_id: repoApi.id, keyword: 'migrate-db' }],
  ['action_run', { repo_id: repoWeb.id, keyword: 'deploy-webstore', job_id: 'run-1' }],
  ['notification_create', { name: notifSlack.name }],
  ['settings_update', { keys: ['app_url'] }],
  ['user_create', { username: sarah.username }],
  ['user_create', { username: mike.username }],
];

for (const [action, details] of auditActions) {
  const user = Math.random() > 0.5 ? sarah : admin;
  db.audit(user, action, details, '10.0.0.' + (2 + Math.floor(Math.random() * 240)));
}
console.log('[seed] audit entries created');

// ---------------------------------------------------------------------------
// 11. Settings
// ---------------------------------------------------------------------------

db.setSettings({
  app_url: 'https://at-field-cicd.com',
  poll_interval_ms: 60000,
  max_active_jobs: 1,
  script_timeout_ms: 30 * 60 * 1000,
  rsync_timeout_ms: 15 * 60 * 1000,
  ssh_timeout_ms: 20 * 60 * 1000,
  maintenance_mode: false,
  log_retention_days: 30,
});
console.log('[seed] settings saved');

console.log('\n[seed] done. Start the server with: ADMIN_USER=admin ADMIN_PASSWORD=admin node server.js');
console.log('      demo credentials (password = demo1234): admin, sarah.ops, mike.dev');
