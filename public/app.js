// STATE

let appState = {
  user: null,
  profile: null,
  repos: [],
  scripts: [],
  machines: [],
  sshKeys: [],
  logs: [],
  audit: [],
  users: [],
  actions: [],
  stats: null,
  notifications: { targets: [], events: [], types: [], status_webhook: '' },
  currentRepo: null,
  activeJobs: [],
  queueLength: 0,
  poll: {},
  settings: {},
  maintenanceMode: false,
  page: 'splash',
  isStaff: false,
};

let pendingDelete = null;
let statusTimer = null;
let loadingCount = 0;

// UI HELPERS

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function showToast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

function showError(message) {
  console.error(message);
  showToast(message, true);
}

function showSuccess(message) {
  showToast(message, false);
}

function setGlobalLoading(on, text) {
  const el = document.getElementById('global-loading');
  if (on) {
    loadingCount += 1;
    if (text) document.getElementById('global-loading-text').textContent = text;
    el.classList.remove('hidden');
  } else {
    loadingCount = Math.max(0, loadingCount - 1);
    if (loadingCount === 0) el.classList.add('hidden');
  }
}

function hideAllPages() {
  document.getElementById('splash').classList.add('hidden');
  document.getElementById('login-page').classList.add('hidden');
  document.getElementById('logout-page').classList.add('hidden');
  document.getElementById('app-shell').classList.add('hidden');
}

function showPage(name) {
  hideAllPages();
  appState.page = name;
  if (name === 'splash') document.getElementById('splash').classList.remove('hidden');
  else if (name === 'login') {
    document.getElementById('login-page').classList.remove('hidden');
    setTimeout(() => document.getElementById('login-username')?.focus(), 50);
  } else if (name === 'logout') document.getElementById('logout-page').classList.remove('hidden');
  else if (name === 'app') document.getElementById('app-shell').classList.remove('hidden');
}

function openModal(id) {
  document.getElementById(id).classList.add('active');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

function closeAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
}

// API

async function apiCall(method, endpoint, data = null, opts = {}) {
  const silent = !!opts.silent;
  if (!silent) setGlobalLoading(true, opts.loadingText || 'Loading…');

  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
  };
  if (data) options.body = JSON.stringify(data);

  try {
    const response = await fetch(endpoint, options);
    if (response.status === 401 && !endpoint.startsWith('/api/auth/') && endpoint !== '/api/profile') {
      if (appState.page === 'app') showPage('login');
      throw new Error('Session expired');
    }
    // profile password wrong returns 401 - don't kick out if on profile intentionally
    if (response.status === 401 && endpoint === '/api/profile' && method === 'GET') {
      showPage('login');
      throw new Error('Session expired');
    }
    if (!response.ok) {
      let error = `HTTP ${response.status}`;
      try {
        const json = await response.json();
        error = json.error || error;
      } catch {}
      throw new Error(error);
    }
    if (response.status === 204) return null;
    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return null;
    return await response.json();
  } finally {
    if (!silent) setGlobalLoading(false);
  }
}

async function apiCallBlob(method, endpoint, data = null) {
  setGlobalLoading(true, 'Preparing backup…');
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
  };
  if (data) options.body = JSON.stringify(data);
  try {
    const response = await fetch(endpoint, options);
    if (!response.ok) {
      let error = `HTTP ${response.status}`;
      try {
        const json = await response.json();
        error = json.error || error;
      } catch {}
      throw new Error(error);
    }
    return await response.blob();
  } finally {
    setGlobalLoading(false);
  }
}

// AUTH FLOW

async function boot() {
  document.documentElement.classList.remove('boot');
  showPage('splash');
  const minSplash = new Promise(r => setTimeout(r, 900));

  try {
    const data = await apiCall('GET', '/api/auth/me', null, { silent: true });
    await minSplash;
    appState.user = data.user;
    appState.settingsVersion = data.version;
    enterApp();
  } catch {
    await minSplash;
    showPage('login');
  } finally {
    document.getElementById('splash').classList.add('splash-done');
  }
}

function enterApp() {
  showPage('app');
  appState.isStaff = appState.user.role === 'admin' || appState.user.role === 'devops';

  document.getElementById('current-user-label').textContent =
    `${appState.user.username} · ${capitalize(appState.user.role)}`;

  document.querySelectorAll('[data-staff="1"]').forEach(el => {
    el.classList.toggle('hidden', !appState.isStaff);
  });

  switchTab('dashboard');
  loadRepos();
  loadScripts();
  loadMachines();
  loadStats();
  loadNotifications();
  if (appState.isStaff) loadSettings();
  updateStatus();
  if (!statusTimer) statusTimer = setInterval(updateStatus, 2500);
}

async function handleLogin(e) {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  const btn = document.getElementById('login-submit');
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;

  try {
    const data = await apiCall('POST', '/api/auth/login', { username, password }, {
      loadingText: 'Signing in…',
    });
    appState.user = data.user;
    document.getElementById('login-form').reset();
    enterApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

async function handleLogout() {
  showPage('logout');
  document.getElementById('logout-message').textContent = 'Signing you out…';
  document.getElementById('logout-spinner').classList.remove('hidden');
  document.getElementById('logout-to-login').classList.add('hidden');

  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }

  try {
    await apiCall('POST', '/api/auth/logout', null, { silent: true });
  } catch {}

  appState.user = null;
  appState.currentRepo = null;
  document.getElementById('logout-spinner').classList.add('hidden');
  document.getElementById('logout-message').textContent = 'You have been logged out.';
  document.getElementById('logout-to-login').classList.remove('hidden');
}

// TABS

function switchTab(tab) {
  if (tab === 'audit' && !appState.isStaff) tab = 'repos';
  if (tab === 'machines' && !appState.isStaff) tab = 'repos';
  if (tab === 'settings' && !appState.isStaff) tab = 'repos';
  if (tab === 'users' && !appState.isStaff) tab = 'repos';

  document.querySelectorAll('.tab-button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-content').forEach(c => {
    c.classList.toggle('active', c.id === `${tab}-tab`);
  });

  if (tab === 'dashboard') loadStats();
  else if (tab === 'repos') {
    if (appState.currentRepo) openRepoDetail(appState.currentRepo.id);
    else loadRepos().then(renderReposList);
  } else if (tab === 'scripts') loadScripts();
  else if (tab === 'logs') loadLogs();
  else if (tab === 'notifications') loadNotifications();
  else if (tab === 'profile') loadProfile();
  else if (tab === 'audit') loadAudit();
  else if (tab === 'machines') loadMachines();
  else if (tab === 'settings') loadSettings();
  else if (tab === 'users') loadUsers();
}

// GLOBAL SETTINGS

function baseUrl() {
  const custom = (appState.settings && appState.settings.app_url) || '';
  return custom.replace(/\/+$/, '') || window.location.origin;
}

async function loadSettings() {
  try {
    const data = await apiCall('GET', '/api/settings', null, { loadingText: 'Loading settings…' });
    appState.settings = data.settings;
    appState.settingsVersion = data.version;
    fillSettingsForm();
  } catch (err) {
    showError(err.message);
  }
}

function fillSettingsForm() {
  const s = appState.settings || {};
  document.getElementById('settings-app-url').value = s.app_url || '';
  document.getElementById('settings-poll-interval').value = Math.round((s.poll_interval_ms || 60000) / 1000);
  document.getElementById('settings-max-jobs').value = s.max_active_jobs || 1;
  document.getElementById('settings-script-timeout').value = Math.round((s.script_timeout_ms || 1800000) / 60000);
  document.getElementById('settings-rsync-timeout').value = Math.round((s.rsync_timeout_ms || 3600000) / 60000);
  document.getElementById('settings-ssh-timeout').value = Math.round((s.ssh_timeout_ms || 1800000) / 60000);
  document.getElementById('settings-log-retention').value = s.log_retention_days || 0;
  document.getElementById('settings-maintenance').checked = !!s.maintenance_mode;
  const verEl = document.getElementById('settings-version');
  if (verEl) verEl.textContent = 'v' + (appState.settingsVersion || '—');
  updateSettingsRuntime();
}

function settingsFromForm() {
  return {
    app_url: document.getElementById('settings-app-url').value.trim(),
    poll_interval_ms: Math.round(parseFloat(document.getElementById('settings-poll-interval').value) || 0) * 1000,
    max_active_jobs: parseInt(document.getElementById('settings-max-jobs').value, 10) || 0,
    script_timeout_ms: Math.round(parseFloat(document.getElementById('settings-script-timeout').value) || 0) * 60000,
    rsync_timeout_ms: Math.round(parseFloat(document.getElementById('settings-rsync-timeout').value) || 0) * 60000,
    ssh_timeout_ms: Math.round(parseFloat(document.getElementById('settings-ssh-timeout').value) || 0) * 60000,
    log_retention_days: parseInt(document.getElementById('settings-log-retention').value, 10) || 0,
    maintenance_mode: document.getElementById('settings-maintenance').checked,
  };
}

function updateSettingsRuntime() {
  const el = document.getElementById('settings-runtime');
  if (el) el.textContent = 'Settings apply immediately; commit-poll scheduling and job concurrency react without restarting the server.';
}

async function saveSettings() {
  try {
    const payload = settingsFromForm();
    const data = await apiCall('PUT', '/api/settings', payload, { loadingText: 'Saving settings…' });
    appState.settings = data.settings;
    fillSettingsForm();
    updateStatus();
    if (appState.isStaff && payload.maintenance_mode !== undefined) {
      document.getElementById('maintenance-banner').classList.toggle('hidden', !payload.maintenance_mode);
    }
    showSuccess('Settings saved');
  } catch (err) {
    showError(err.message);
  }
}

async function downloadBackup() {
  try {
    const blob = await apiCallBlob('POST', '/api/settings/backup');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `at-field-ci-backup-${new Date().toISOString().slice(0, 10)}.db`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showSuccess('Backup downloaded');
  } catch (err) {
    showError(`Backup failed: ${err.message}`);
  }
}

// REPOS

async function loadRepos() {
  try {
    appState.repos = await apiCall('GET', '/api/repos', null, { loadingText: 'Loading repos…' });
    if (!appState.currentRepo) renderReposList();
  } catch (err) {
    showError(err.message);
  }
}

function renderReposList() {
  document.getElementById('repo-detail').classList.add('hidden');
  document.getElementById('repos-list').classList.remove('hidden');
  const container = document.getElementById('repos-list');

  if (!appState.repos.length) {
    container.innerHTML = '<p class="empty-state">No repos yet. Add one to receive webhooks.</p>';
    return;
  }

  container.innerHTML = appState.repos.map(repo => {
    const buttons = [
      `<button class="btn btn-small btn-primary" data-open-repo="${repo.id}">Actions</button>`,
      `<button class="btn btn-small" data-edit-repo="${repo.id}">Edit</button>`,
    ];
    if (appState.isStaff) {
      buttons.push(
        `<button class="btn btn-small" data-reveal-secret="${repo.id}">Secret</button>`,
        `<button class="btn btn-small btn-danger" data-del-repo="${repo.id}">Delete</button>`
      );
    }
    return `
    <div class="action-item">
      <div class="item-info">
        <div class="item-name">${escapeHtml(repo.name)}</div>
        <div class="item-details">
          ${escapeHtml(repo.full_name)} · ${escapeHtml(repo.provider)}
          ${repo.enabled ? '' : ' · DISABLED'}
          ${repo.poll_enabled ? ' · poll' : ''}
          ${repo.has_git_token ? ' · private' : ''}
        </div>
      </div>
      <div class="item-actions">${buttons.join('')}</div>
    </div>
  `;
  }).join('');

  container.querySelectorAll('[data-open-repo]').forEach(btn => {
    btn.addEventListener('click', () => openRepoDetail(parseInt(btn.dataset.openRepo, 10)));
  });
  container.querySelectorAll('[data-edit-repo]').forEach(btn => {
    btn.addEventListener('click', () => editRepo(parseInt(btn.dataset.editRepo, 10)));
  });
  container.querySelectorAll('[data-reveal-secret]').forEach(btn => {
    btn.addEventListener('click', () => revealSecret(parseInt(btn.dataset.revealSecret, 10)));
  });
  container.querySelectorAll('[data-del-repo]').forEach(btn => {
    btn.addEventListener('click', () => confirmDelete('repo', btn.dataset.delRepo));
  });
}

async function openRepoDetail(id) {
  const repo = appState.repos.find(r => r.id === id);
  if (!repo) return;
  appState.currentRepo = repo;

  document.getElementById('repos-list').classList.add('hidden');
  document.getElementById('repo-detail').classList.remove('hidden');
  document.getElementById('repo-detail-title').textContent = repo.name;

  const origin = baseUrl();
  const sha = repo.last_commit_sha
    ? (repo.last_commit_sha.length > 12 ? repo.last_commit_sha.slice(0, 12) + '…' : repo.last_commit_sha)
    : '—';
  const secretRow = appState.isStaff
    ? `<div><span class="meta-k">Webhook secret</span><span class="meta-v monospace">${escapeHtml(repo.webhook_secret_hint || '—')}</span></div>`
    : '';
  const pollBtnHtml = appState.isStaff
    ? `<button type="button" class="btn btn-small" id="repo-poll-now-btn">Check for commits now</button>`
    : '';
  document.getElementById('repo-meta').innerHTML = `
    <div class="repo-meta-grid">
      <div><span class="meta-k">Full name</span><span class="meta-v monospace">${escapeHtml(repo.full_name)}</span></div>
      <div><span class="meta-k">Provider</span><span class="meta-v">${escapeHtml(repo.provider)}</span></div>
      <div><span class="meta-k">Webhook URL</span><span class="meta-v monospace">${escapeHtml(origin + repo.webhook_path)}</span></div>
      ${secretRow}
      <div><span class="meta-k">Git user</span><span class="meta-v monospace">${escapeHtml(repo.git_username || '—')}</span></div>
      <div><span class="meta-k">Git token</span><span class="meta-v monospace">${escapeHtml(repo.has_git_token ? (repo.git_token_hint || 'set') : 'not set')}</span></div>
      <div><span class="meta-k">Clone URL</span><span class="meta-v monospace">${escapeHtml(repo.clone_url || 'default')}</span></div>
      <div><span class="meta-k">Commit poll</span><span class="meta-v">${repo.poll_enabled ? 'on' : 'off'}${repo.poll_branch ? ' · ' + escapeHtml(repo.poll_branch) : ''}</span></div>
      <div><span class="meta-k">Last checked SHA</span><span class="meta-v monospace" title="${escapeHtml(repo.last_commit_sha || '')}">${escapeHtml(sha)}</span></div>
      <div><span class="meta-k">Last polled</span><span class="meta-v">${escapeHtml(repo.last_polled_at || 'never')}</span></div>
    </div>
    <div class="repo-meta-actions">
      ${pollBtnHtml}
    </div>
  `;

  const pollBtn = document.getElementById('repo-poll-now-btn');
  if (pollBtn) {
    pollBtn.addEventListener('click', () => pollRepoNow(repo.id));
  }

  await loadActions();
}

async function pollRepoNow(id) {
  try {
    const result = await apiCall('POST', `/api/repos/${id}/poll`, null, {
      loadingText: 'Checking commits…',
    });
    await loadRepos();
    if (appState.currentRepo && appState.currentRepo.id === id) {
      const updated = appState.repos.find(r => r.id === id);
      if (updated) appState.currentRepo = updated;
      await openRepoDetail(id);
    }
    if (result.status === 'error') {
      showError(result.error || 'Poll failed');
    } else if (result.status === 'baseline') {
      showSuccess(result.message || 'Baseline HEAD stored');
    } else if (result.queued > 0) {
      showSuccess(`Queued ${result.queued} job(s) from ${result.new_commits} commit(s)`);
    } else if (result.new_commits > 0) {
      showSuccess(`${result.new_commits} new commit(s), no keyword matches`);
    } else {
      showSuccess('Up to date');
    }
  } catch (err) {
    showError(err.message);
  }
}

function backToRepos() {
  appState.currentRepo = null;
  appState.actions = [];
  renderReposList();
}

async function loadActions() {
  if (!appState.currentRepo) return;
  try {
    appState.actions = await apiCall(
      'GET',
      `/api/repos/${appState.currentRepo.id}/actions`,
      null,
      { loadingText: 'Loading actions…' }
    );
    renderActionsList();
  } catch (err) {
    showError(err.message);
  }
}

function renderActionsList() {
  const container = document.getElementById('actions-list');
  if (!appState.actions.length) {
    container.innerHTML = '<p class="empty-state">No keyword actions for this repo</p>';
    return;
  }

  container.innerHTML = appState.actions.map(action => {
    const machineNames = (action.machine_ids || [])
      .map(id => {
        const m = appState.machines.find(x => x.id === id);
        return m ? m.name : `#${id} (deleted)`;
      })
      .join(', ');
    const isCombined = Array.isArray(action.machine_ids) && action.machine_ids.length > 0;
    const typeLabel = isCombined
      ? `Deploy (${action.method})`
      : 'Script';
    const details = isCombined
      ? `Machines: ${machineNames} · Script: ${action.script}`
      : `Script: ${action.script} (runs on CI host)`;
    const customLabel = typeof action.script_content === 'string' && action.script_content.trim()
      ? ' · customized copy (template untouched)'
      : '';
    const notifyIds = action.notification_target_ids || [];
    let notifyLabel = '';
    if (notifyIds.length) {
      const targetMap = new Map((appState.notifications.targets || []).map(t => [t.id, t.name]));
      notifyLabel = ' · notify: ' + notifyIds.map(id => targetMap.get(id) || `#${id}`).join(', ');
    }
    const buttons = [];
    buttons.push(`<button class="btn btn-small btn-primary" data-edit-action="${escapeHtml(action.keyword)}">Edit</button>`);
    buttons.push(`<button class="btn btn-small" data-run-action="${escapeHtml(action.keyword)}">Run Now</button>`);
    if (appState.isStaff) {
      buttons.push(`<button class="btn btn-small btn-danger" data-del-action="${escapeHtml(action.keyword)}">Delete</button>`);
    }
    return `
      <div class="action-item">
        <div class="item-info">
          <div class="item-name">${escapeHtml(action.keyword)}</div>
          <div class="item-details">${escapeHtml(details + notifyLabel + customLabel)}</div>
          <span class="action-type-badge ${action.type}">${escapeHtml(typeLabel)}</span>
        </div>
        <div class="item-actions">${buttons.join('')}</div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-edit-action]').forEach(btn => {
    btn.addEventListener('click', () => editAction(btn.dataset.editAction));
  });
  container.querySelectorAll('[data-run-action]').forEach(btn => {
    btn.addEventListener('click', () => runActionNow(btn.dataset.runAction));
  });
  container.querySelectorAll('[data-del-action]').forEach(btn => {
    btn.addEventListener('click', () => confirmDelete('action', btn.dataset.delAction));
  });
}

function resetRepoForm() {
  document.getElementById('repo-form').reset();
  document.getElementById('repo-edit-id').value = '';
  document.getElementById('repo-enabled').checked = true;
  document.getElementById('repo-poll-enabled').checked = false;
  document.getElementById('repo-poll-branch').value = '';
  document.getElementById('repo-modal-title').textContent = 'Add Repository';
  document.getElementById('repo-secret').placeholder = 'leave blank to auto-generate';
  document.getElementById('repo-git-token').placeholder = 'ghp_… or access token';
  document.getElementById('repo-git-token-help').textContent =
    'Never shown again. Injected as CI_GIT_TOKEN in scripts. Also used for commit polling.';
}

function editRepo(id) {
  const repo = appState.repos.find(r => r.id === id);
  if (!repo) return;
  document.getElementById('repo-edit-id').value = String(repo.id);
  document.getElementById('repo-name').value = repo.name;
  document.getElementById('repo-full-name').value = repo.full_name;
  document.getElementById('repo-provider').value = repo.provider;
  document.getElementById('repo-secret').value = '';
  document.getElementById('repo-secret').placeholder = 'leave blank to keep current';
  document.getElementById('repo-git-user').value = repo.git_username || '';
  document.getElementById('repo-git-token').value = '';
  document.getElementById('repo-git-token').placeholder = repo.has_git_token
    ? `keep current (${repo.git_token_hint || '••••'})`
    : 'ghp_… or access token';
  document.getElementById('repo-git-token-help').textContent = repo.has_git_token
    ? 'Leave blank to keep. Enter new token to replace.'
    : 'Optional PAT for private repos and commit polling.';
  document.getElementById('repo-clone-url').value = repo.clone_url || '';
  document.getElementById('repo-poll-enabled').checked = !!repo.poll_enabled;
  document.getElementById('repo-poll-branch').value = repo.poll_branch || '';
  document.getElementById('repo-enabled').checked = !!repo.enabled;
  document.getElementById('repo-modal-title').textContent = 'Edit Repository';
  openModal('repo-modal');
}

async function handleRepoSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('repo-edit-id').value;
  const payload = {
    name: document.getElementById('repo-name').value.trim(),
    full_name: document.getElementById('repo-full-name').value.trim(),
    provider: document.getElementById('repo-provider').value,
    enabled: document.getElementById('repo-enabled').checked,
    git_username: document.getElementById('repo-git-user').value.trim(),
    clone_url: document.getElementById('repo-clone-url').value.trim(),
    poll_enabled: document.getElementById('repo-poll-enabled').checked,
    poll_branch: document.getElementById('repo-poll-branch').value.trim(),
  };
  const secret = document.getElementById('repo-secret').value.trim();
  if (secret) payload.webhook_secret = secret;

  const tokenVal = document.getElementById('repo-git-token').value;
  if (id) {
    // only send token if user typed something
    if (tokenVal.length > 0) payload.git_token = tokenVal.trim();
  } else if (tokenVal.trim()) {
    payload.git_token = tokenVal.trim();
  }

  try {
    let result;
    if (id) {
      result = await apiCall('PATCH', `/api/repos/${id}`, payload, { loadingText: 'Saving repo…' });
    } else {
      result = await apiCall('POST', '/api/repos', payload, { loadingText: 'Creating repo…' });
    }
    closeAllModals();
    await loadRepos();
    if (result.webhook_secret) showSecret(result.webhook_secret, result.webhook_path);
    if (appState.currentRepo && String(appState.currentRepo.id) === String(result.id || id)) {
      openRepoDetail(result.id || parseInt(id, 10));
    } else {
      renderReposList();
    }
    showSuccess('Repository saved');
  } catch (err) {
    showError(err.message);
  }
}

async function revealSecret(id) {
  try {
    const data = await apiCall('POST', `/api/repos/${id}/reveal-secret`, null, {
      loadingText: 'Loading secret…',
    });
    const repo = appState.repos.find(r => r.id === id);
    showSecret(data.webhook_secret, repo?.webhook_path);
  } catch (err) {
    showError(err.message);
  }
}

function showSecret(secret, webhookPath) {
  document.getElementById('secret-value').textContent = secret;
  document.getElementById('secret-webhook-url').textContent =
    webhookPath ? `Webhook URL: ${baseUrl()}${webhookPath}` : '';
  openModal('secret-modal');
}

// ACTIONS

const ACTION_SCRIPT_TEMPLATE = '#!/bin/bash\nset -e\n' +
  '# Template only - edit to fit your build.\n' +
  '# clone: git clone "$CI_CLONE_AUTH_URL" workdir\n' +
  '# environment: CI_COMMIT_SHA, CI_KEYWORD, CI_REPO_SLUG, CI_TRIGGER\n';
let actionScriptOriginal = '';

// Default notification message template (renders to the standard message).
// Filled with {{...}} placeholders from the job result payload.
const DEFAULT_NOTIFY_TEMPLATE = '{{message}}\nRepo: {{repo}}\nKeyword: {{keyword}}\nDuration: {{duration}}';

let notificationTargetsLoaded = false;

async function ensureNotificationTargets() {
  if (notificationTargetsLoaded) return appState.notifications.targets;
  try {
    appState.notifications = await apiCall('GET', '/api/notifications', null, { silent: true });
    notificationTargetsLoaded = true;
  } catch {
    appState.notifications.targets = [];
  }
  return appState.notifications.targets;
}

function populateNotifyPicker(selectedIds = []) {
  const container = document.getElementById('action-notify-picker');
  if (!container) return;
  const selected = new Set(selectedIds.map(Number));
  const targets = appState.notifications.targets || [];
  const validIds = new Set(targets.map(t => t.id));
  const orphaned = selectedIds.filter(id => !validIds.has(Number(id)));
  if (!targets.length) {
    container.innerHTML = '<p class="empty-state">No notification targets yet — add one in the Notifications tab.</p>';
    return;
  }
  const orphanNote = orphaned.length
    ? `<p class="empty-state">${orphaned.length} previously selected target(s) no longer exist — pick targets below or the custom template will have no effect.</p>`
    : '';
  container.innerHTML = orphanNote + `
    <div class="picker-list-header">
      <span class="picker-check"></span>
      <span>Name</span>
      <span>Type</span>
      <span>Status</span>
    </div>
    ${targets.map(t => {
      const disabled = !t.enabled;
      return `
      <label class="picker-list-row">
        <span class="picker-check"><input type="checkbox" class="notify-pick" value="${t.id}" ${selected.has(t.id) ? 'checked' : ''} ${disabled ? 'disabled' : ''}></span>
        <span class="picker-name">${escapeHtml(t.name)}</span>
        <span class="picker-detail">${escapeHtml(t.type)}</span>
        <span class="picker-detail pick-status ${disabled ? 'off' : 'on'}">${disabled ? 'Disabled' : 'Enabled'}</span>
      </label>`;
    }).join('')}`;
}

function showDeployMethodFields(method) {
  document.getElementById('rsync-fields').classList.toggle('hidden', method !== 'rsync');
  document.getElementById('ssh-fields').classList.toggle('hidden', method !== 'ssh');
}

function setActionScriptHint(customized) {
  document.getElementById('action-script-editor-hint').textContent = customized
    ? 'Customized copy stored with this action only — the template file is never modified.'
    : 'Template only — edit it to fit your build. Your changes are stored with this action only; the template file is never modified.';
}

function updateActionModalPermissions() {
  const editor = document.getElementById('action-script-content');
  if (!editor) return;
  editor.readOnly = false;
  setActionScriptHint(false);
}

function populateMachinePicker(selectedIds = []) {
  const container = document.getElementById('action-machines-picker');
  const selected = new Set(selectedIds.map(Number));
  if (!appState.machines.length) {
    container.innerHTML = appState.isStaff
      ? '<p class="empty-state">No deployment machines yet — add one in the Machines tab.</p>'
      : '<p class="empty-state">No deployment machines available — ask DevOps to add one.</p>';
    return;
  }
  container.innerHTML = `
    <div class="picker-list-header">
      <span class="picker-check"></span>
      <span>Name</span>
      <span>Host</span>
      <span>Port</span>
    </div>
    ${appState.machines.map(m => `
    <label class="picker-list-row">
      <span class="picker-check"><input type="checkbox" class="machine-pick" value="${m.id}" ${selected.has(m.id) ? 'checked' : ''}></span>
      <span class="picker-name">${escapeHtml(m.name)}</span>
      <span class="picker-detail">${escapeHtml(m.ssh_user)}@${escapeHtml(m.host)}</span>
      <span class="picker-detail">${escapeHtml(String(m.port || 22))}</span>
    </label>
    `).join('')}`;
}

function resetActionForm() {
  document.getElementById('action-keyword').disabled = false;
  document.getElementById('action-form').reset();
  showDeployMethodFields('');
  populateMachinePicker();
  populateNotifyPicker();
  document.getElementById('action-notify-template').value = DEFAULT_NOTIFY_TEMPLATE;
  document.getElementById('action-script-content').value = '';
  actionScriptOriginal = '';
  document.getElementById('action-modal-title').textContent = 'Add Action';
  updateActionModalPermissions();
  ensureNotificationTargets().then(() => populateNotifyPicker());
}

function populateScriptSelect(selected) {
  const select = document.getElementById('action-script');
  select.innerHTML = '<option value="">-- Select --</option>' +
    appState.scripts.map(name =>
      `<option value="${escapeHtml(name)}" ${name === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`
    ).join('');
}

function editAction(keyword) {
  const action = appState.actions.find(a => a.keyword === keyword);
  if (!action) return;

  document.getElementById('action-keyword').value = keyword;
  document.getElementById('action-keyword').disabled = true;

  populateMachinePicker(action.machine_ids || []);
  populateNotifyPicker(action.notification_target_ids || []);
  document.getElementById('action-notify-template').value =
    action.notification_template || DEFAULT_NOTIFY_TEMPLATE;
  const method = action.method || '';
  document.getElementById('deploy-method').value = method;
  showDeployMethodFields(method);
  if (method === 'rsync') {
    document.getElementById('deploy-source').value = action.source || '';
    document.getElementById('deploy-destination').value = action.destination || '';
  } else if (method === 'ssh') {
    document.getElementById('deploy-command').value = action.command || '';
  }

  populateScriptSelect(action.script);
  updateActionModalPermissions();
  loadActionScriptEditor(action.script || '', action);

  document.getElementById('action-modal-title').textContent = 'Edit Action';
  openModal('action-modal');
  ensureNotificationTargets().then(() => populateNotifyPicker(action.notification_target_ids || []));
}

async function loadActionScriptEditor(scriptName, action) {
  const editor = document.getElementById('action-script-content');
  if (!scriptName) {
    actionScriptOriginal = ACTION_SCRIPT_TEMPLATE;
    editor.value = ACTION_SCRIPT_TEMPLATE;
    setActionScriptHint(false);
    return;
  }
  if (action && typeof action.script_content === 'string' && action.script_content.trim()) {
    actionScriptOriginal = action.script_content;
    editor.value = action.script_content;
    setActionScriptHint(true);
    return;
  }
  try {
    const data = await apiCall('GET', `/api/scripts/${encodeURIComponent(scriptName)}`, null, { silent: true });
    actionScriptOriginal = data.content;
    editor.value = data.content;
    setActionScriptHint(false);
  } catch {
    actionScriptOriginal = ACTION_SCRIPT_TEMPLATE;
    editor.value = ACTION_SCRIPT_TEMPLATE;
    setActionScriptHint(false);
  }
}

async function runActionNow(keyword) {
  if (!appState.currentRepo) return;
  try {
    await apiCall(
      'POST',
      `/api/repos/${appState.currentRepo.id}/actions/${encodeURIComponent(keyword)}/run`,
      null,
      { loadingText: 'Queuing…' }
    );
    showSuccess(`Queued ${keyword}`);
  } catch (err) {
    showError(err.message);
  }
}

async function handleActionSubmit(e) {
  e.preventDefault();
  if (!appState.currentRepo) return;

  const keyword = document.getElementById('action-keyword').value.trim();
  if (!keyword) return showError('Fill required fields');

  const machineIds = Array.from(document.querySelectorAll('.machine-pick:checked')).map(cb => parseInt(cb.value, 10));
  if (!machineIds.length) return showError('Select at least one deployment machine');

  const method = document.getElementById('deploy-method').value;
  if (!method) return showError('Select a deploy method');

  const script = document.getElementById('action-script').value.trim();
  if (!script) return showError('Select a script');

  const action = {
    type: 'deploy',
    machine_ids: machineIds,
    method,
    script,
  };

  const notifyIds = Array.from(document.querySelectorAll('.notify-pick:checked')).map(cb => parseInt(cb.value, 10));
  const notifyTemplate = document.getElementById('action-notify-template').value;
  if (notifyIds.length) action.notification_target_ids = notifyIds;
  if (notifyTemplate.trim() && notifyTemplate.trim() !== DEFAULT_NOTIFY_TEMPLATE) {
    action.notification_template = notifyTemplate.trim();
    if (!notifyIds.length) {
      showToast('Custom message template saved, but no notification target is selected — it only applies to targets picked below.');
    }
  }

  const content = document.getElementById('action-script-content').value;
  if (content !== actionScriptOriginal) {
    // Store the edit as a per-action override in the DB. The shared
    // template file under scripts/ is never modified.
    action.script_content = content;
    actionScriptOriginal = content;
  }

  if (method === 'rsync') {
    action.source = document.getElementById('deploy-source').value.trim();
    action.destination = document.getElementById('deploy-destination').value.trim();
    if (!action.source || !action.destination) return showError('rsync needs source + destination');
  } else {
    action.command = document.getElementById('deploy-command').value.trim();
  }

  try {
    await apiCall(
      'PUT',
      `/api/repos/${appState.currentRepo.id}/actions/${encodeURIComponent(keyword)}`,
      action,
      { loadingText: 'Saving action…' }
    );
    closeAllModals();
    resetActionForm();
    loadActions();
    showSuccess('Action saved');
  } catch (err) {
    showError(err.message);
  }
}

// SCRIPTS

async function loadScripts() {
  try {
    appState.scripts = await apiCall('GET', '/api/scripts', null, { loadingText: 'Loading scripts…' });
    renderScriptsList();
  } catch (err) {
    showError(err.message);
  }
}

function renderScriptsList() {
  const container = document.getElementById('scripts-list');
  if (!appState.scripts.length) {
    container.innerHTML = '<p class="empty-state">No scripts yet</p>';
    return;
  }
  container.innerHTML = appState.scripts.map(name => {
    const buttons = [
      `<button class="btn btn-small btn-primary" data-edit-script="${escapeHtml(name)}">Edit</button>`,
    ];
    if (appState.isStaff) {
      buttons.push(`<button class="btn btn-small btn-danger" data-del-script="${escapeHtml(name)}">Delete</button>`);
    }
    return `
    <div class="script-item">
      <div class="item-info"><div class="item-name">${escapeHtml(name)}</div></div>
      <div class="item-actions">${buttons.join('')}</div>
    </div>
  `;
  }).join('');

  container.querySelectorAll('[data-edit-script]').forEach(btn => {
    btn.addEventListener('click', () => editScript(btn.dataset.editScript));
  });
  container.querySelectorAll('[data-del-script]').forEach(btn => {
    btn.addEventListener('click', () => confirmDelete('script', btn.dataset.delScript));
  });
}

async function editScript(name) {
  try {
    const data = await apiCall('GET', `/api/scripts/${encodeURIComponent(name)}`, null, {
      loadingText: 'Loading script…',
    });
    document.getElementById('script-name').value = data.name;
    document.getElementById('script-name').disabled = true;
    document.getElementById('script-content').value = data.content;
    document.getElementById('script-content').readOnly = false;
    document.getElementById('script-submit-btn').classList.remove('hidden');
    document.getElementById('script-modal-title').textContent = `Edit: ${name}`;
    openModal('script-modal');
  } catch (err) {
    showError(err.message);
  }
}

function resetScriptForm() {
  document.getElementById('script-name').disabled = false;
  document.getElementById('script-form').reset();
  document.getElementById('script-content').readOnly = false;
  document.getElementById('script-submit-btn').classList.remove('hidden');
  document.getElementById('script-modal-title').textContent = 'Create Script';
}

async function handleScriptSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('script-name').value.trim();
  const content = document.getElementById('script-content').value;
  if (!name || !content) return showError('Fill all fields');
  try {
    await apiCall('POST', `/api/scripts/${encodeURIComponent(name)}`, { content }, {
      loadingText: 'Saving script…',
    });
    closeAllModals();
    resetScriptForm();
    loadScripts();
    showSuccess('Script saved');
  } catch (err) {
    showError(err.message);
  }
}

// DEPLOYMENT MACHINES

async function loadMachines() {
  try {
    const [machines, keys] = await Promise.all([
      apiCall('GET', '/api/machines', null, { loadingText: 'Loading machines…' }),
      apiCall('GET', '/api/sshkeys', null, { loadingText: 'Loading keys…' }).catch(() => []),
    ]);
    appState.machines = machines;
    appState.sshKeys = keys;
    renderMachinesList();
    renderSshKeysList();
  } catch (err) {
    showError(err.message);
  }
}

function renderMachinesList() {
  const container = document.getElementById('machines-list');
  if (!container) return;
  if (!appState.machines.length) {
    container.innerHTML = '<p class="empty-state">No deployment machines yet. Add one — actions deploy to these machines and run their scripts on them.</p>';
    return;
  }
  container.innerHTML = `
    <div class="machines-header">
      <span>Name</span>
      <span>Host</span>
      <span>Port</span>
      <span></span>
    </div>
    ${appState.machines.map(m => {
      const port = m.port && Number(m.port) !== 22 ? m.port : '22';
      return `
      <div class="machine-row">
        <span class="machine-name" data-label="Name">${escapeHtml(m.name)}</span>
        <span class="machine-host" data-label="Host">${escapeHtml(m.ssh_user)}@${escapeHtml(m.host)}</span>
        <span class="machine-port" data-label="Port">${escapeHtml(String(port))}</span>
        <span class="machine-actions">
          <button class="btn btn-small btn-primary" data-edit-machine="${m.id}">Edit</button>
          <button class="btn btn-small btn-danger" data-del-machine="${m.id}">Delete</button>
        </span>
      </div>`;
    }).join('')}`;

  container.querySelectorAll('[data-edit-machine]').forEach(btn => {
    btn.addEventListener('click', () => editMachine(parseInt(btn.dataset.editMachine, 10)));
  });
  container.querySelectorAll('[data-del-machine]').forEach(btn => {
    btn.addEventListener('click', () => confirmDelete('machine', btn.dataset.delMachine));
  });
}

function renderSshKeysList() {
  const container = document.getElementById('ssh-keys-list');
  if (!container) return;
  if (!appState.sshKeys.length) {
    container.innerHTML = '<p class="empty-state">No SSH keys uploaded yet. Upload a private key so machines can authenticate.</p>';
    return;
  }
  container.innerHTML = appState.sshKeys.map(k => `
    <div class="action-item">
      <div class="item-info">
        <div class="item-name">${escapeHtml(k.name)}</div>
        <div class="item-details">
          ${escapeHtml(k.fingerprint)}${k.machine_uses ? ' · in use by ' + k.machine_uses + ' machine(s)' : ''}
        </div>
      </div>
      <div class="item-actions">
        <button class="btn btn-small btn-danger" data-del-key="${k.id}">Delete</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-del-key]').forEach(btn => {
    btn.addEventListener('click', () => confirmDelete('sshkey', btn.dataset.delKey));
  });
}

function populateKeySelect() {
  const select = document.getElementById('machine-ssh-key');
  if (!select) return;
  select.innerHTML = '<option value="">Default (no key)</option>' +
    appState.sshKeys.map(k => `<option value="${escapeHtml(k.name)}">${escapeHtml(k.name)}</option>`).join('');
}

function resetMachineForm() {
  document.getElementById('machine-form').reset();
  document.getElementById('machine-edit-id').value = '';
  document.getElementById('machine-modal-title').textContent = 'Add Deployment Machine';
  populateKeySelect();
}

function editMachine(id) {
  const m = appState.machines.find(x => x.id === id);
  if (!m) return;
  populateKeySelect();
  document.getElementById('machine-edit-id').value = String(m.id);
  document.getElementById('machine-name').value = m.name;
  document.getElementById('machine-user').value = m.ssh_user;
  document.getElementById('machine-host').value = m.host;
  document.getElementById('machine-port').value = m.port || 22;
  document.getElementById('machine-ssh-key').value = m.ssh_key || '';
  document.getElementById('machine-ssh-options').value = m.ssh_options || '';
  document.getElementById('machine-modal-title').textContent = `Edit: ${m.name}`;
  openModal('machine-modal');
}

async function handleMachineSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('machine-edit-id').value;
  const payload = {
    name: document.getElementById('machine-name').value.trim(),
    ssh_user: document.getElementById('machine-user').value.trim(),
    host: document.getElementById('machine-host').value.trim(),
    port: parseInt(document.getElementById('machine-port').value, 10) || 22,
    ssh_key: document.getElementById('machine-ssh-key').value,
    ssh_options: document.getElementById('machine-ssh-options').value.trim(),
  };
  try {
    if (id) {
      await apiCall('PATCH', `/api/machines/${id}`, payload, { loadingText: 'Saving machine…' });
    } else {
      await apiCall('POST', '/api/machines', payload, { loadingText: 'Creating machine…' });
    }
    closeAllModals();
    resetMachineForm();
    await loadMachines();
    showSuccess('Machine saved');
  } catch (err) {
    showError(err.message);
  }
}

// LOGS

async function loadLogs() {
  try {
    appState.logs = await apiCall('GET', '/api/logs', null, { loadingText: 'Loading logs…' });
    renderLogsList();
  } catch (err) {
    showError(err.message);
  }
}

function renderLogsList() {
  const container = document.getElementById('logs-list');
  if (!appState.logs.length) {
    container.innerHTML = '<p class="empty-state">No logs yet</p>';
    return;
  }
  container.innerHTML = `
    <div class="logs-header">
      <span>Repo</span>
      <span>Keyword</span>
      <span>Status</span>
      <span>Size</span>
      <span></span>
    </div>
    ${appState.logs.map(log => {
      const date = new Date(log.mtime);
      const sizeKB = (log.size / 1024).toFixed(1);
      const repo = log.repo_name || log.name.split('_')[0] || '—';
      const statusClass = log.status ? log.status.toLowerCase() : '';
      return `
      <div class="log-row" data-log="${escapeHtml(log.name)}" data-run-id="${log.run_id ?? ''}" title="${escapeHtml(date.toLocaleString())}">
        <span class="log-repo" data-label="Repo">${escapeHtml(repo)}</span>
        <span class="log-keyword" data-label="Keyword">${escapeHtml(log.keyword || '—')}</span>
        <span class="log-status ${escapeHtml(statusClass)}" data-label="Status">${escapeHtml(log.status || '—')}</span>
        <span class="log-size" data-label="Size">${sizeKB} KB</span>
        <span class="machine-actions">
          <button class="btn btn-small btn-primary" data-view-log="${escapeHtml(log.name)}">View</button>
        </span>
      </div>`;
    }).join('')}`;

  const openLog = row => {
    const runId = row.dataset.runId;
    if (runId) openRunDetails(parseInt(runId, 10));
    else viewLog(row.dataset.log);
  };
  container.querySelectorAll('.log-row').forEach(row => {
    row.addEventListener('click', () => openLog(row));
  });
  container.querySelectorAll('[data-view-log]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const runId = btn.closest('.log-row').dataset.runId;
      if (runId) openRunDetails(parseInt(runId, 10));
      else viewLog(btn.dataset.viewLog);
    });
  });
}

async function viewLog(filename) {
  try {
    document.getElementById('log-content').innerHTML =
      '<div class="inline-loading"><div class="loading-spinner sm"></div> Loading…</div>';
    openModal('log-modal');
    const data = await apiCall('GET', `/api/logs/${encodeURIComponent(filename)}`, null, {
      loadingText: 'Loading log…',
    });
    document.getElementById('log-modal-title').textContent = `Log: ${filename}`;
    document.getElementById('log-content').textContent = data.content;
  } catch (err) {
    showError(err.message);
  }
}

// PROFILE

async function loadProfile() {
  try {
    const p = await apiCall('GET', '/api/profile', null, { loadingText: 'Loading profile…' });
    appState.profile = p;
    document.getElementById('profile-username').textContent = p.username;
    document.getElementById('profile-role').textContent = p.role;
    document.getElementById('profile-avatar-initials').textContent = (p.username || '?').charAt(0).toUpperCase();
    document.getElementById('profile-created').textContent = p.created_at
      ? new Date(p.created_at).toLocaleString()
      : '—';
    const verEl = document.getElementById('settings-version');
    if (verEl) verEl.textContent = 'v' + (appState.settingsVersion || '—');
  } catch (err) {
    showError(err.message);
  }
}

async function handleProfileSubmit(e) {
  e.preventDefault();
  const errEl = document.getElementById('profile-error');
  const okEl = document.getElementById('profile-success');
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');

  const current_password = document.getElementById('profile-current').value;
  const new_password = document.getElementById('profile-new').value;
  const confirm = document.getElementById('profile-confirm').value;

  if (new_password !== confirm) {
    errEl.textContent = 'New passwords do not match';
    errEl.classList.remove('hidden');
    return;
  }

  const btn = document.getElementById('profile-submit');
  btn.disabled = true;
  try {
    await apiCall('PATCH', '/api/profile', { current_password, new_password }, {
      loadingText: 'Updating password…',
    });
    document.getElementById('profile-form').reset();
    okEl.textContent = 'Password updated';
    okEl.classList.remove('hidden');
    showSuccess('Password updated');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

// DASHBOARD / STATS

function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function fmtNum(n) {
  return n == null ? '0' : String(n);
}

function svgWrap(inner, w, h, par = 'none') {
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="${par}">${inner}</svg>`;
}

async function loadStats() {
  const days = document.getElementById('stats-days').value;
  try {
    appState.stats = await apiCall('GET', `/api/stats?days=${days}`, null, { loadingText: 'Loading stats…' });
    renderStats();
  } catch (err) {
    showError(err.message);
  }
}

// For ranges longer than 14 days, group per-day data into 7-day buckets so
// bars stay readable instead of collapsing into thin slivers.
function bucketPerDay(perDay) {
  if (!perDay || perDay.length <= 14) return perDay;
  const out = [];
  const rev = [...perDay].reverse();
  for (let i = 0; i < rev.length; i += 7) {
    const chunk = rev.slice(i, i + 7);
    const b = { day: chunk[chunk.length - 1].day, total: 0, success: 0, failed: 0, timeouts: 0, running: 0 };
    for (const d of chunk) {
      b.total += d.total;
      b.success += d.success;
      b.failed += d.failed;
      b.timeouts += d.timeouts;
      b.running += d.running;
    }
    out.push(b);
  }
  return out.reverse();
}

function renderStats() {
  if (!appState.stats) return;
  const { overview, by_keyword, by_type, by_trigger, recent } = appState.stats;
  const per_day = bucketPerDay(appState.stats.per_day);
  const successRate = overview.total
    ? Math.round((overview.success / overview.total) * 100)
    : 0;

  document.getElementById('stats-cards').innerHTML = `
    <div class="stat-card"><div class="stat-value">${fmtNum(overview.total)}</div><div class="stat-label">Total runs</div></div>
    <div class="stat-card"><div class="stat-value success">${fmtNum(overview.success)}</div><div class="stat-label">Success</div></div>
    <div class="stat-card"><div class="stat-value error">${fmtNum(overview.failed)}</div><div class="stat-label">Failed</div></div>
    <div class="stat-card"><div class="stat-value warning">${fmtNum(overview.timeouts)}</div><div class="stat-label">Timeouts</div></div>
    <div class="stat-card"><div class="stat-value">${fmtNum(overview.deploys)}</div><div class="stat-label">Deploys</div></div>
    <div class="stat-card"><div class="stat-value">${fmtNum(overview.webhook_calls)}</div><div class="stat-label">Webhook calls</div></div>
    <div class="stat-card"><div class="stat-value">${successRate}%</div><div class="stat-label">Success rate</div></div>
    <div class="stat-card"><div class="stat-value">${fmtDuration(overview.avg_duration_ms)}</div><div class="stat-label">Avg duration</div></div>
  `;

  // Stacked bar chart: runs per day
  const maxDay = Math.max(1, ...per_day.map(d => d.total));
  const barW = per_day.length > 20 ? 10 : 26;
  const gap = per_day.length > 20 ? 6 : 18;
  const totalW = barW * per_day.length + gap * (per_day.length - 1);
  const chartW = Math.max(totalW, 400);
  const chartH = 200;
  const bars = per_day.map((d, i) => {
    const x = 30 + i * (barW + gap);
    let y = chartH - 10;
    const segs = [];
    const push = (val, color, label) => {
      if (!val) return;
      const h = Math.max(2, (val / maxDay) * (chartH - 30));
      y -= h;
      segs.push(`<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${color}"><title>${d.day}: ${label} ${val}</title></rect>`);
    };
    push(d.success, '#00FF88', 'success');
    push(d.failed, '#FF3366', 'failed');
    push(d.timeouts, '#FFCC00', 'timeouts');
    if (!segs.length) segs.push(`<rect x="${x}" y="${chartH - 12}" width="${barW}" height="2" fill="#1A1A1A"/>`);
    const week = appState.stats.per_day.length > 14;
    const lbl = week ? `w/e ${d.day.slice(5)}` : d.day.slice(5);
    const tip = week ? `week ending ${d.day}: ${d.total} runs` : `${d.day}: ${d.total} runs`;
    return `${segs.join('')}<text x="${x + barW / 2}" y="${chartH + 6}" font-size="9" fill="#666" text-anchor="middle">${lbl}</text><title>${tip}</title>`;
  }).join('');
  document.getElementById('chart-runs').innerHTML =
    svgWrap(`<line x1="30" y1="${chartH - 10}" x2="${chartW}" y2="${chartH - 10}" stroke="#1A1A1A"/>${bars}`, chartW, chartH + 20);

  // Horizontal bars: by keyword
  const maxKw = Math.max(1, ...by_keyword.map(k => k.total));
  const kwRows = by_keyword.length
    ? by_keyword.map(k => `
        <div class="hbar-row">
          <div class="hbar-label" title="${escapeHtml(k.keyword)}">${escapeHtml(k.keyword)}</div>
          <div class="hbar-track"><div class="hbar-fill" style="width:${Math.round((k.total / maxKw) * 100)}%"></div></div>
          <div class="hbar-values">${fmtNum(k.total)}<span class="hbar-sub">${fmtNum(k.success)} ok · ${fmtDuration(k.avg_duration_ms)}</span></div>
        </div>`).join('')
    : '<p class="empty-state">No runs yet</p>';
  document.getElementById('chart-keywords').innerHTML = kwRows;

  // Donut: by type, plus trigger counts
  const totalType = by_type.reduce((n, t) => n + t.total, 0) || 1;
  const colors = { script: '#4CC9F0', deploy: '#00FF88' };
  let acc = 0;
  const donutSegs = by_type.map(t => {
    const frac = t.total / totalType;
    const start = acc * 360;
    acc += frac;
    const end = acc * 360;
    return `<path d="${donutArc(40, 40, 32, start, end)}" fill="${colors[t.type] || '#4CC9F0'}"><title>${escapeHtml(t.type)}: ${t.total}</title></path>`;
  }).join('');
  const triggerRows = (by_trigger || []).map(t => `
    <div class="hbars-mini"><span>${escapeHtml(t.trigger)}</span><b>${fmtNum(t.total)}</b></div>`).join('');
  document.getElementById('chart-types').innerHTML = `
    ${by_type.length ? svgWrap(donutSegs, 80, 80, 'xMidYMid meet') : '<p class="empty-state">No runs yet</p>'}
    <div class="legend-mini">
      ${by_type.map(t => `<span><i style="background:${colors[t.type] || '#4CC9F0'}"></i>${escapeHtml(t.type)} (${fmtNum(t.total)})</span>`).join('')}
    </div>
    <div class="mini-list">${triggerRows}</div>`;

  // Recent runs table
  const recentRows = recent.length
    ? recent.map(r => `
      <div class="recent-row clickable" data-run-id="${escapeHtml(r.id)}" title="Click for details">
        <span class="status-dot ${escapeHtml(r.status)}"></span>
        <span class="recent-kw">${escapeHtml(r.keyword)}</span>
        <span class="recent-extra">${escapeHtml(r.repo_name || '')} · ${escapeHtml(r.type)} · ${escapeHtml(r.trigger || '')}</span>
        <span class="recent-extra">${fmtDuration(r.duration_ms)}</span>
        <span class="recent-time">${escapeHtml((r.started_at || '').slice(0, 16).replace('T', ' '))}</span>
      </div>`).join('')
    : '<p class="empty-state">No runs yet</p>';
  const recentEl = document.getElementById('chart-recent');
  recentEl.innerHTML = recentRows;
  recentEl.querySelectorAll('[data-run-id]').forEach(row => {
    row.addEventListener('click', () => openRunDetails(parseInt(row.dataset.runId, 10)));
  });
}

function openRunDetails(runId) {
  const modal = document.getElementById('run-modal');
  document.getElementById('run-modal-title').textContent = 'Run Details';
  document.getElementById('run-detail').innerHTML =
    '<div class="inline-loading"><div class="loading-spinner sm"></div> Loading…</div>';
  openModal('run-modal');
  apiCall('GET', `/api/runs/${runId}`).then(({ run, log }) => {
    const el = document.getElementById('run-detail');
    if (!run) {
      el.innerHTML = '<p class="empty-state">Run not found.</p>';
      return;
    }
    const statusLabel = capitalize(run.status);
    const started = run.started_at ? run.started_at.slice(0, 16).replace('T', ' ') : '—';
    const finished = run.finished_at ? run.finished_at.slice(0, 16).replace('T', ' ') : '—';
    const exit = run.exit_code !== null && run.exit_code !== undefined
      ? escapeHtml(String(run.exit_code)) : '—';
    document.getElementById('run-modal-title').textContent = `${run.keyword} · ${statusLabel}`;
    el.innerHTML = `
      <div class="run-status-banner ${escapeHtml(run.status)}">
        <span class="status-dot ${escapeHtml(run.status)}"></span>
        <b>${statusLabel}</b>
        ${run.duration_ms != null ? `<span class="run-duration">${fmtDuration(run.duration_ms)}</span>` : ''}
      </div>
      <div class="run-info-grid">
        <div class="run-info-item"><span>Keyword</span><b>${escapeHtml(run.keyword)}</b></div>
        <div class="run-info-item"><span>Type</span><b>${escapeHtml(run.type)}</b></div>
        <div class="run-info-item"><span>Repo</span><b>${escapeHtml(run.repo_name || '—')}</b></div>
        <div class="run-info-item"><span>Trigger</span><b>${escapeHtml(run.trigger || '—')}</b></div>
        <div class="run-info-item"><span>Started</span><b>${started}</b></div>
        <div class="run-info-item"><span>Finished</span><b>${finished}</b></div>
        <div class="run-info-item"><span>Exit code</span><b>${exit}</b></div>
        <div class="run-info-item"><span>Job ID</span><b class="monospace small">${escapeHtml(run.job_id)}</b></div>
      </div>
      <div class="run-log-head">Log${log ? '' : ' (not available)'}</div>
      <pre class="log-viewer log-viewer-static">${escapeHtml(log || '')}</pre>`;
  }).catch(err => {
    const el = document.getElementById('run-detail');
    el.innerHTML = `<p class="empty-state">Failed to load run: ${escapeHtml(err.message)}</p>`;
  });
}

function donutArc(cx, cy, r, startDeg, endDeg) {
  const rad = deg => (deg - 90) * Math.PI / 180;
  const x = (deg, rr) => cx + rr * Math.cos(rad(deg));
  const y = (deg, rr) => cy + rr * Math.sin(rad(deg));
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${x(startDeg, r)} ${y(startDeg, r)} A ${r} ${r} 0 ${large} 1 ${x(endDeg, r)} ${y(endDeg, r)} L ${x(endDeg, r - 14)} ${y(endDeg, r - 14)} A ${r - 14} ${r - 14} 0 ${large} 0 ${x(startDeg, r - 14)} ${y(startDeg, r - 14)} Z`;
}

// NOTIFICATIONS

const notifFieldMap = {
  generic: ['url', 'token'],
  discord: ['url'],
  slack: ['url'],
  telegram: ['bot-token', 'chat-id'],
  pushover: ['api-token', 'user-key'],
  gotify: ['url', 'api-token'],
  ntfy: ['url', 'topic'],
};

function notifConfigFromForm() {
  const type = document.getElementById('notification-type').value;
  const config = {};
  for (const f of notifFieldMap[type] || []) {
    const v = document.getElementById(`notification-${f}`).value.trim();
    if (v) config[f === 'api-token' ? 'api_token' : f === 'bot-token' ? 'bot_token' : f === 'user-key' ? 'user_key' : f] = v;
  }
  const tpl = document.getElementById('notification-message-template').value.trim();
  if (tpl) config.message_template = tpl;
  return config;
}

function censorValue(v) {
  const s = String(v || '');
  if (s.length <= 8) return '••••';
  return `••••${s.slice(-4)}`;
}

function censorUrl(u) {
  return String(u).replace(/([?&]@[^=]*=)([^&]*)/g, '$1••••');
}

function notifFormFromConfig(type, config = {}) {
  const m = { api_token: 'api-token', bot_token: 'bot-token', user_key: 'user-key', token: 'token' };
  const secretKeys = ['token', 'api_token', 'bot_token', 'user_key'];
  for (const [key, val] of Object.entries(config)) {
    const el = document.getElementById(`notification-${m[key] || key}`);
    if (!el) continue;
    if (secretKeys.includes(key)) {
      el.value = '';
      el.placeholder = `saved ${censorValue(val)} · leave blank to keep`;
    } else if (key === 'url') {
      el.value = censorUrl(val);
    } else {
      el.value = val;
    }
  }
  const tpl = document.getElementById('notification-message-template');
  if (tpl) tpl.value = config.message_template || DEFAULT_NOTIFY_TEMPLATE;
}

function showNotifFields(type) {
  const fields = notifFieldMap[type] || [];
  document.querySelectorAll('[id^="notif-field-"]').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('[id^="notif-field-"] input').forEach(el => { el.value = ''; el.placeholder = ''; });
  for (const f of fields) {
    const group = document.getElementById(`notif-field-${f}`);
    if (group) group.classList.remove('hidden');
  }
  if (type === 'generic') {
    document.getElementById('notif-url-help').textContent =
      'SMS/email gateways (Twilio, Mailgun, Postmark, …) or any webhook. Receives JSON { title, message, ok }.';
  } else if (type === 'ntfy') {
    document.getElementById('notif-url-help').textContent = 'ntfy server, e.g. https://ntfy.sh (topic appended separately)';
  } else if (type === 'gotify') {
    document.getElementById('notif-url-help').textContent = 'Gotify server URL, e.g. https://gotify.example.com';
  } else {
    document.getElementById('notif-url-help').textContent = 'Incoming webhook URL';
  }
}

function resetNotificationForm() {
  document.getElementById('notification-form').reset();
  document.getElementById('notification-edit-id').value = '';
  document.getElementById('notification-modal-title').textContent = 'Add Notification Target';
  document.getElementById('notification-enabled').checked = true;
  document.getElementById('notification-message-template').value = DEFAULT_NOTIFY_TEMPLATE;
  document.querySelectorAll('.notif-event').forEach(cb => {
    cb.checked = ['job_failure', 'job_timeout', 'poll_error'].includes(cb.value);
  });
  showNotifFields('generic');
}

async function loadNotifications() {
  try {
    appState.notifications = await apiCall('GET', '/api/notifications', null, { loadingText: 'Loading notifications…' });
    notificationTargetsLoaded = true;
    renderNotifications();
  } catch (err) {
    showError(err.message);
  }
}

function renderNotifications() {
  const { targets, status_webhook } = appState.notifications;
  document.getElementById('status-webhook-url').value = baseUrl() + status_webhook;

  const container = document.getElementById('notifications-list');
  if (!targets.length) {
    container.innerHTML = '<p class="empty-state">No notification targets yet. Add one to get SMS, email or chat alerts for builds, deploys, timeouts and poll errors.</p>';
    return;
  }
  container.innerHTML = `
    <div class="notif-header">
      <span>Name</span>
      <span>Type</span>
      <span>Status</span>
      <span></span>
    </div>
    ${targets.map(t => {
      const status = t.enabled ? 'Enabled' : 'Disabled';
      return `
      <div class="notif-row">
        <span class="notif-name" data-label="Name">${escapeHtml(t.name)}</span>
        <span class="notif-type" data-label="Type">${escapeHtml(t.type)}</span>
        <span class="notif-status ${t.enabled ? 'on' : 'off'}" data-label="Status">${escapeHtml(status)}</span>
        <span class="machine-actions">
          ${t.enabled ? `<button class="btn btn-small" data-test-notification="${t.id}">Test</button>` : ''}
          <button class="btn btn-small btn-primary" data-edit-notification="${t.id}">Edit</button>
          <button class="btn btn-small btn-danger" data-del-notification="${t.id}">Delete</button>
        </span>
      </div>`;
    }).join('')}`;

  container.querySelectorAll('[data-test-notification]').forEach(btn => {
    btn.addEventListener('click', () => testNotification(parseInt(btn.dataset.testNotification, 10)));
  });
  container.querySelectorAll('[data-edit-notification]').forEach(btn => {
    btn.addEventListener('click', () => editNotification(parseInt(btn.dataset.editNotification, 10)));
  });
  container.querySelectorAll('[data-del-notification]').forEach(btn => {
    btn.addEventListener('click', () => confirmDelete('notification', btn.dataset.delNotification));
  });
}

function editNotification(id) {
  const t = appState.notifications.targets.find(x => x.id === id);
  if (!t) return;
  document.getElementById('notification-edit-id').value = String(t.id);
  document.getElementById('notification-name').value = t.name;
  document.getElementById('notification-type').value = t.type;
  document.getElementById('notification-enabled').checked = !!t.enabled;
  showNotifFields(t.type);
  notifFormFromConfig(t.type, t);
  document.querySelectorAll('.notif-event').forEach(cb => {
    cb.checked = (t.events || []).includes(cb.value);
  });
  document.getElementById('notification-modal-title').textContent = 'Edit Notification Target';
  openModal('notification-modal');
}

async function testNotification(id) {
  try {
    await apiCall('POST', `/api/notifications/${id}/test`, null, { loadingText: 'Sending test…' });
    showSuccess('Test notification sent');
  } catch (err) {
    showError(err.message);
  }
}

async function handleNotificationSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('notification-edit-id').value;
  const name = document.getElementById('notification-name').value.trim();
  const type = document.getElementById('notification-type').value;
  if (!name) return showError('Name required');

  const events = Array.from(document.querySelectorAll('.notif-event:checked')).map(cb => cb.value);
  const config = notifConfigFromForm();
  const requiredUrl = notifFieldMap[type].includes('url');
  if (requiredUrl && !config.url) return showError('Webhook URL required for this type');
  if (type === 'telegram' && (!config.bot_token || !config.chat_id)) return showError('Telegram needs bot token + chat ID');
  if (type === 'pushover' && (!config.api_token || !config.user_key)) return showError('Pushover needs API token + user key');
  if (type === 'gotify' && (!config.url || !config.api_token)) return showError('Gotify needs server URL + app token');

  const payload = { name, type, events, config, enabled: document.getElementById('notification-enabled').checked };
  try {
    if (id) {
      await apiCall('PATCH', `/api/notifications/${id}`, payload, { loadingText: 'Saving…' });
    } else {
      await apiCall('POST', '/api/notifications', payload, { loadingText: 'Saving…' });
    }
    closeAllModals();
    resetNotificationForm();
    loadNotifications();
    showSuccess('Notification target saved');
  } catch (err) {
    showError(err.message);
  }
}

async function testStatusPing() {
  const status = appState.notifications;
  if (!status || !status.status_webhook) return showError('Status webhook not loaded');
  try {
    const data = await apiCall('POST', status.status_webhook, {
      title: 'Ping',
      message: `Ping from dashboard at ${new Date().toISOString()}`,
      ok: true,
    }, { loadingText: 'Sending ping…' });
    showSuccess(`Ping received, forwarded to ${data.sent || 0} target(s)`);
  } catch (err) {
    showError(err.message);
  }
}

async function rotateStatusToken() {
  try {
    const data = await apiCall('POST', '/api/notifications/status-token/rotate', null, { loadingText: 'Rotating…' });
    appState.notifications.status_webhook = data.status_webhook;
    document.getElementById('status-webhook-url').value = window.location.origin + data.status_webhook;
    showSuccess('Status token rotated');
  } catch (err) {
    showError(err.message);
  }
}

// AUDIT / USERS

async function loadAudit() {
  try {
    appState.audit = await apiCall('GET', '/api/audit?limit=200', null, { loadingText: 'Loading audit…' });
    renderAuditList();
  } catch (err) {
    showError(err.message);
  }
}

function renderAuditList() {
  const container = document.getElementById('audit-list');
  if (!appState.audit.length) {
    container.innerHTML = '<p class="empty-state">No audit events</p>';
    return;
  }
  container.innerHTML = appState.audit.map(row => {
    const details = row.details ? JSON.stringify(row.details) : '';
    return `
      <div class="log-item">
        <div class="item-info">
          <div class="item-name">${escapeHtml(row.action)}</div>
          <div class="item-details">
            ${escapeHtml(row.username || 'system')} · ${escapeHtml(row.ip || '—')} · ${escapeHtml(row.created_at)}
            ${details ? `<br><span class="monospace meta-v">${escapeHtml(details)}</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function loadUsers() {
  try {
    appState.users = await apiCall('GET', '/api/users', null, { loadingText: 'Loading users…' });
    renderUsersList();
  } catch (err) {
    showError(err.message);
  }
}

function renderUsersList() {
  const container = document.getElementById('users-list');
  if (!appState.users.length) {
    container.innerHTML = '<p class="empty-state">No users</p>';
    return;
  }
  container.innerHTML = appState.users.map(u => {
    const badgeClass = u.role === 'admin' ? 'deploy' : (u.role === 'devops' ? 'devops' : 'script');
    return `
    <div class="action-item">
      <div class="item-info">
        <div class="item-name">${escapeHtml(u.username)}</div>
        <div class="item-details">${escapeHtml(u.role)} · created ${escapeHtml(u.created_at)}</div>
        <span class="action-type-badge ${badgeClass}">${escapeHtml(u.role)}</span>
      </div>
      <div class="item-actions">
        <button class="btn btn-small btn-primary" data-edit-user="${u.id}">Edit</button>
        <button class="btn btn-small btn-danger" data-del-user="${u.id}" ${u.id === appState.user.id ? 'disabled' : ''}>Delete</button>
      </div>
    </div>
  `;
  }).join('');

  container.querySelectorAll('[data-edit-user]').forEach(btn => {
    btn.addEventListener('click', () => editUser(parseInt(btn.dataset.editUser, 10)));
  });
  container.querySelectorAll('[data-del-user]').forEach(btn => {
    btn.addEventListener('click', () => confirmDelete('user', btn.dataset.delUser));
  });
}

function resetUserForm() {
  document.getElementById('user-form').reset();
  document.getElementById('user-edit-id').value = '';
  document.getElementById('user-username').disabled = false;
  document.getElementById('user-password').required = true;
  document.getElementById('user-password-help').textContent = 'Min 8 characters';
  document.getElementById('user-role').innerHTML =
    '<option value="devops">Devops</option><option value="developer">Developer</option>';
  document.getElementById('user-role').disabled = false;
  document.getElementById('user-role').value = 'developer';
  document.getElementById('user-modal-title').textContent = 'Add User';
}

function editUser(id) {
  const u = appState.users.find(x => x.id === id);
  if (!u) return;
  document.getElementById('user-edit-id').value = String(u.id);
  document.getElementById('user-username').value = u.username;
  document.getElementById('user-username').disabled = true;
  document.getElementById('user-password').value = '';
  document.getElementById('user-password').required = false;
  document.getElementById('user-password-help').textContent = 'Leave blank to keep current password';
  const roleSelect = document.getElementById('user-role');
  if (u.role === 'admin') {
    roleSelect.innerHTML = '<option value="admin">Admin</option>';
    roleSelect.disabled = true;
  } else {
    roleSelect.innerHTML =
      '<option value="devops">Devops</option><option value="developer">Developer</option>';
    roleSelect.disabled = false;
    roleSelect.value = u.role;
  }
  document.getElementById('user-modal-title').textContent = 'Edit User';
  openModal('user-modal');
}

async function handleUserSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('user-edit-id').value;
  const username = document.getElementById('user-username').value.trim();
  const password = document.getElementById('user-password').value;
  const role = document.getElementById('user-role').value;

  try {
    if (id) {
      const body = { role };
      if (password) body.password = password;
      await apiCall('PATCH', `/api/users/${id}`, body, { loadingText: 'Saving user…' });
    } else {
      if (!password || password.length < 8) return showError('Password min 8 chars');
      await apiCall('POST', '/api/users', { username, password, role }, { loadingText: 'Creating user…' });
    }
    closeAllModals();
    resetUserForm();
    loadUsers();
    showSuccess('User saved');
  } catch (err) {
    showError(err.message);
  }
}

// DELETE

function confirmDelete(type, name) {
  pendingDelete = { type, name };
  document.getElementById('confirm-message').textContent =
    `Delete ${type} "${name}"? This cannot be undone.`;
  openModal('confirm-modal');
}

async function handleConfirmDelete() {
  if (!pendingDelete) return;
  const { type, name } = pendingDelete;
  pendingDelete = null;
  try {
    if (type === 'action' && appState.currentRepo) {
      await apiCall('DELETE', `/api/repos/${appState.currentRepo.id}/actions/${encodeURIComponent(name)}`, null, {
        loadingText: 'Deleting…',
      });
      loadActions();
    } else if (type === 'script') {
      await apiCall('DELETE', `/api/scripts/${encodeURIComponent(name)}`, null, { loadingText: 'Deleting…' });
      loadScripts();
    } else if (type === 'repo') {
      await apiCall('DELETE', `/api/repos/${name}`, null, { loadingText: 'Deleting…' });
      appState.currentRepo = null;
      await loadRepos();
      renderReposList();
    } else if (type === 'user') {
      await apiCall('DELETE', `/api/users/${name}`, null, { loadingText: 'Deleting…' });
      loadUsers();
    } else if (type === 'notification') {
      await apiCall('DELETE', `/api/notifications/${name}`, null, { loadingText: 'Deleting…' });
      loadNotifications();
    } else if (type === 'machine') {
      await apiCall('DELETE', `/api/machines/${name}`, null, { loadingText: 'Deleting…' });
      loadMachines();
    } else if (type === 'sshkey') {
      await apiCall('DELETE', `/api/sshkeys/${name}`, null, { loadingText: 'Deleting…' });
      loadMachines();
    }
    closeAllModals();
    showSuccess('Deleted');
  } catch (err) {
    showError(err.message);
  }
}

// STATUS

async function updateStatus() {
  try {
    const status = await apiCall('GET', '/api/status', null, { silent: true });
    appState.activeJobs = status.active_jobs || [];
    appState.queueLength = status.queue_length;
    appState.poll = status.poll || {};
    appState.maintenanceMode = !!status.maintenance_mode;
    document.getElementById('maintenance-banner').classList.toggle('hidden', !appState.maintenanceMode);
    renderStatus();
  } catch (err) {
    console.error('Status failed:', err.message);
  }
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function renderStatus() {
  const bar = document.getElementById('status-bar');
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const jobs = appState.activeJobs || [];
  const queue = appState.queueLength || 0;
  const poll = appState.poll || {};

  const parts = [];
  if (jobs.length) {
    parts.push(`Running: ${jobs.map(j => `${j.name}${j.repo ? ' @ ' + j.repo : ''}`).join(', ')}`);
  }
  if (queue > 0) parts.push(`${queue} queued`);
  if (!parts.length) parts.push('Idle');

  const last = poll.last_cycle_at ? timeAgo(poll.last_cycle_at) : 'never';
  const interval = Math.round((poll.interval_ms || 60000) / 1000);
  parts.push(`poll every ${interval}s · last ${last}`);

  text.textContent = parts.join('  ·  ');
  dot.className = 'status-dot-sm' + (jobs.length ? ' running' : queue > 0 ? ' queued' : '');
  bar.classList.toggle('running', jobs.length > 0);
  bar.classList.toggle('queued', queue > 0 && !jobs.length);
}

// INIT

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('logout-btn').addEventListener('click', handleLogout);
  document.getElementById('logout-to-login').addEventListener('click', () => showPage('login'));
  document.getElementById('profile-form').addEventListener('submit', handleProfileSubmit);

  const pwdToggle = document.getElementById('password-toggle');
  if (pwdToggle) {
    pwdToggle.addEventListener('click', () => {
      const input = document.getElementById('login-password');
      const eye = pwdToggle.querySelector('.icon-eye');
      const eyeOff = pwdToggle.querySelector('.icon-eye-off');
      if (input.type === 'password') {
        input.type = 'text';
        eye.classList.add('hidden');
        eyeOff.classList.remove('hidden');
      } else {
        input.type = 'password';
        eye.classList.remove('hidden');
        eyeOff.classList.add('hidden');
      }
    });
  }

  document.querySelectorAll('.tab-button').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettings();
  });
  document.getElementById('settings-backup-btn').addEventListener('click', downloadBackup);

  document.querySelectorAll('.close-btn, [data-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.dataset.modal;
      if (!modalId) return;
      if (btn.type === 'submit') return;
      closeModal(modalId);
      if (modalId === 'action-modal') resetActionForm();
      if (modalId === 'script-modal') resetScriptForm();
      if (modalId === 'repo-modal') resetRepoForm();
      if (modalId === 'user-modal') resetUserForm();
      if (modalId === 'notification-modal') resetNotificationForm();
      if (modalId === 'machine-modal') resetMachineForm();
    });
  });

  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal(modal.id);
        if (modal.id === 'action-modal') resetActionForm();
        if (modal.id === 'script-modal') resetScriptForm();
        if (modal.id === 'repo-modal') resetRepoForm();
        if (modal.id === 'user-modal') resetUserForm();
        if (modal.id === 'notification-modal') resetNotificationForm();
        if (modal.id === 'machine-modal') resetMachineForm();
      }
    });
  });

  document.getElementById('add-repo-btn').addEventListener('click', () => {
    resetRepoForm();
    openModal('repo-modal');
  });
  document.getElementById('repo-form').addEventListener('submit', handleRepoSubmit);
  document.getElementById('back-repos-btn').addEventListener('click', backToRepos);

  document.getElementById('add-action-btn').addEventListener('click', () => {
    resetActionForm();
    populateScriptSelect();
    openModal('action-modal');
  });
  document.getElementById('action-script').addEventListener('change', (e) => {
    loadActionScriptEditor(e.target.value);
  });
  document.getElementById('deploy-method').addEventListener('change', (e) => {
    showDeployMethodFields(e.target.value);
  });
  document.getElementById('action-form').addEventListener('submit', handleActionSubmit);

  document.getElementById('add-machine-btn').addEventListener('click', () => {
    resetMachineForm();
    openModal('machine-modal');
  });
  document.getElementById('machine-help-btn').addEventListener('click', () => {
    openModal('machine-help-modal');
  });
  document.getElementById('add-key-btn').addEventListener('click', () => {
    document.getElementById('key-form').reset();
    openModal('key-modal');
  });
  document.getElementById('key-help-btn').addEventListener('click', () => {
    openModal('key-help-modal');
  });
  document.getElementById('key-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('key-name').value.trim();
    const file = document.getElementById('key-file').files[0];
    if (!name || !file) return showError('Name and key file are required');
    try {
      const content = await file.text();
      await apiCall('POST', '/api/sshkeys', { name, content }, { loadingText: 'Uploading key…' });
      closeAllModals();
      await loadMachines();
      showSuccess('SSH key uploaded');
    } catch (err) {
      showError(err.message);
    }
  });
  document.getElementById('machine-form').addEventListener('submit', handleMachineSubmit);

  document.getElementById('create-script-btn').addEventListener('click', () => {
    resetScriptForm();
    openModal('script-modal');
  });
  document.getElementById('script-form').addEventListener('submit', handleScriptSubmit);
  document.getElementById('refresh-logs-btn').addEventListener('click', loadLogs);
  document.getElementById('refresh-audit-btn').addEventListener('click', loadAudit);

  document.getElementById('add-user-btn').addEventListener('click', () => {
    resetUserForm();
    openModal('user-modal');
  });
  document.getElementById('user-form').addEventListener('submit', handleUserSubmit);
  document.getElementById('confirm-yes').addEventListener('click', handleConfirmDelete);

  document.getElementById('stats-days').addEventListener('change', loadStats);

  document.getElementById('add-notification-btn').addEventListener('click', () => {
    resetNotificationForm();
    openModal('notification-modal');
  });
  document.getElementById('notification-template-reset').addEventListener('click', () => {
    document.getElementById('notification-message-template').value = DEFAULT_NOTIFY_TEMPLATE;
  });
  document.getElementById('action-notify-template-reset').addEventListener('click', () => {
    document.getElementById('action-notify-template').value = DEFAULT_NOTIFY_TEMPLATE;
  });
  document.getElementById('notification-type').addEventListener('change', (e) => {
    showNotifFields(e.target.value);
  });
  document.getElementById('notification-form').addEventListener('submit', handleNotificationSubmit);
  document.getElementById('copy-status-url').addEventListener('click', () => {
    const input = document.getElementById('status-webhook-url');
    input.select();
    navigator.clipboard?.writeText(input.value).catch(() => {});
    showSuccess('Copied');
  });
  document.getElementById('test-status-ping').addEventListener('click', testStatusPing);
  document.getElementById('rotate-status-token').addEventListener('click', () => {
    if (window.confirm('Rotate the status webhook token? Old scripts using the current URL will stop working.')) {
      rotateStatusToken();
    }
  });

  boot();
});
