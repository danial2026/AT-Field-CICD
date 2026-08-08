// STATE

let appState = {
  user: null,
  profile: null,
  repos: [],
  scripts: [],
  logs: [],
  audit: [],
  users: [],
  actions: [],
  currentRepo: null,
  currentJob: null,
  queueLength: 0,
  page: 'splash',
  isStaff: false,
  isAdminUser: false,
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

// AUTH FLOW

async function boot() {
  showPage('splash');
  const minSplash = new Promise(r => setTimeout(r, 900));

  try {
    const data = await apiCall('GET', '/api/auth/me', null, { silent: true });
    await minSplash;
    appState.user = data.user;
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
  appState.isAdminUser = appState.user.role === 'admin';

  document.getElementById('current-user-label').textContent =
    `${appState.user.username} · ${capitalize(appState.user.role)}`;

  document.querySelectorAll('[data-staff="1"]').forEach(el => {
    el.classList.toggle('hidden', !appState.isStaff);
  });
  document.querySelectorAll('[data-admin-user="1"]').forEach(el => {
    el.classList.toggle('hidden', !appState.isAdminUser);
  });

  switchTab('repos');
  loadRepos();
  loadScripts();
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
  if (tab === 'users' && !appState.isAdminUser) tab = 'repos';

  document.querySelectorAll('.tab-button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-content').forEach(c => {
    c.classList.toggle('active', c.id === `${tab}-tab`);
  });

  if (tab === 'repos') {
    if (appState.currentRepo) openRepoDetail(appState.currentRepo.id);
    else loadRepos().then(renderReposList);
  } else if (tab === 'scripts') loadScripts();
  else if (tab === 'logs') loadLogs();
  else if (tab === 'profile') loadProfile();
  else if (tab === 'audit') loadAudit();
  else if (tab === 'users') loadUsers();
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
    ];
    if (appState.isStaff) {
      buttons.push(
        `<button class="btn btn-small" data-edit-repo="${repo.id}">Edit</button>`,
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
        <span class="action-type-badge script">${escapeHtml(repo.provider)}</span>
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

  const origin = window.location.origin;
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
    const typeLabel = action.type === 'script' ? 'Script' : `Deploy (${action.method})`;
    const details = action.type === 'script'
      ? `Script: ${action.script}`
      : `${action.user}@${action.host}`;
    const buttons = [];
    if (appState.isStaff) {
      buttons.push(`<button class="btn btn-small btn-primary" data-edit-action="${escapeHtml(action.keyword)}">Edit</button>`);
    }
    buttons.push(`<button class="btn btn-small" data-run-action="${escapeHtml(action.keyword)}">Run Now</button>`);
    if (appState.isStaff) {
      buttons.push(`<button class="btn btn-small btn-danger" data-del-action="${escapeHtml(action.keyword)}">Delete</button>`);
    }
    return `
      <div class="action-item">
        <div class="item-info">
          <div class="item-name">${escapeHtml(action.keyword)}</div>
          <div class="item-details">${escapeHtml(details)}</div>
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
    webhookPath ? `Webhook URL: ${window.location.origin}${webhookPath}` : '';
  openModal('secret-modal');
}

// ACTIONS

function showFormFields(type) {
  document.getElementById('script-fields').classList.toggle('hidden', type !== 'script');
  document.getElementById('deploy-fields').classList.toggle('hidden', type !== 'deploy');
}

function showDeployMethodFields(method) {
  document.getElementById('rsync-fields').classList.toggle('hidden', method !== 'rsync');
  document.getElementById('ssh-fields').classList.toggle('hidden', method !== 'ssh');
}

function resetActionForm() {
  document.getElementById('action-keyword').disabled = false;
  document.getElementById('action-form').reset();
  showFormFields('');
  document.getElementById('action-modal-title').textContent = 'Add Action';
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
  document.getElementById('action-type').value = action.type;

  if (action.type === 'script') {
    populateScriptSelect(action.script);
    showFormFields('script');
  } else {
    document.getElementById('deploy-method').value = action.method || '';
    document.getElementById('deploy-user').value = action.user || '';
    document.getElementById('deploy-host').value = action.host || '';
    document.getElementById('deploy-ssh-key').value = action.sshKey || '';
    document.getElementById('deploy-ssh-options').value = action.sshOptions || '';
    if (action.method === 'rsync') {
      document.getElementById('deploy-source').value = action.source || '';
      document.getElementById('deploy-destination').value = action.destination || '';
    } else {
      document.getElementById('deploy-command').value = action.command || '';
    }
    showFormFields('deploy');
    showDeployMethodFields(action.method);
  }

  document.getElementById('action-modal-title').textContent = 'Edit Action';
  openModal('action-modal');
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
  const type = document.getElementById('action-type').value;
  if (!keyword || !type) return showError('Fill required fields');

  let action = { type };

  if (type === 'script') {
    const script = document.getElementById('action-script').value.trim();
    if (!script) return showError('Select a script');
    action.script = script;
  } else {
    const method = document.getElementById('deploy-method').value;
    const user = document.getElementById('deploy-user').value.trim();
    const host = document.getElementById('deploy-host').value.trim();
    if (!method || !user || !host) return showError('Fill deploy fields');
    action.method = method;
    action.user = user;
    action.host = host;
    action.sshKey = document.getElementById('deploy-ssh-key').value.trim() || undefined;
    action.sshOptions = document.getElementById('deploy-ssh-options').value.trim() || undefined;
    if (method === 'rsync') {
      action.source = document.getElementById('deploy-source').value.trim();
      action.destination = document.getElementById('deploy-destination').value.trim();
      if (!action.source || !action.destination) return showError('rsync needs source + destination');
    } else {
      action.command = document.getElementById('deploy-command').value.trim();
      if (!action.command) return showError('SSH needs command');
    }
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
    const buttons = [];
    if (appState.isStaff) {
      buttons.push(`<button class="btn btn-small btn-primary" data-edit-script="${escapeHtml(name)}">Edit</button>`);
      buttons.push(`<button class="btn btn-small btn-danger" data-del-script="${escapeHtml(name)}">Delete</button>`);
    } else {
      buttons.push(`<button class="btn btn-small btn-primary" data-view-script="${escapeHtml(name)}">View</button>`);
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
  container.querySelectorAll('[data-view-script]').forEach(btn => {
    btn.addEventListener('click', () => editScript(btn.dataset.viewScript));
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
    document.getElementById('script-content').readOnly = !appState.isStaff;
    document.getElementById('script-submit-btn').classList.toggle('hidden', !appState.isStaff);
    document.getElementById('script-modal-title').textContent =
      appState.isStaff ? `Edit: ${name}` : `View: ${name}`;
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
  container.innerHTML = appState.logs.map(log => {
    const date = new Date(log.mtime);
    const sizeKB = (log.size / 1024).toFixed(1);
    return `
      <div class="log-item">
        <div class="item-info">
          <div class="item-name">${escapeHtml(log.name)}</div>
          <div class="item-details">${date.toLocaleString()} · ${sizeKB} KB</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-small btn-primary" data-view-log="${escapeHtml(log.name)}">View</button>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-view-log]').forEach(btn => {
    btn.addEventListener('click', () => viewLog(btn.dataset.viewLog));
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
    document.getElementById('profile-created').textContent = p.created_at
      ? new Date(p.created_at).toLocaleString()
      : '—';
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
    appState.currentJob = status.current;
    appState.queueLength = status.queue_length;
    renderStatus();
  } catch (err) {
    console.error('Status failed:', err.message);
  }
}

function renderStatus() {
  const bar = document.getElementById('status-bar');
  let text = '';
  if (appState.currentJob) {
    const repo = appState.currentJob.repo ? ` @ ${appState.currentJob.repo}` : '';
    text = `Running: ${appState.currentJob.name}${repo} (${appState.currentJob.type})`;
    bar.classList.add('running');
    bar.classList.remove('queued');
  } else if (appState.queueLength > 0) {
    text = `Queued: ${appState.queueLength} job(s)`;
    bar.classList.add('queued');
    bar.classList.remove('running');
  } else {
    text = 'Ready';
    bar.classList.remove('running', 'queued');
  }
  document.getElementById('status-info').textContent = text;
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
  document.getElementById('action-type').addEventListener('change', (e) => {
    showFormFields(e.target.value);
    if (e.target.value === 'script') populateScriptSelect();
  });
  document.getElementById('deploy-method').addEventListener('change', (e) => {
    showDeployMethodFields(e.target.value);
  });
  document.getElementById('action-form').addEventListener('submit', handleActionSubmit);

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

  boot();
});
