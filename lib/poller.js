'use strict';

const MAX_COMMITS_PER_POLL = 30;

function parseCloneHost(cloneUrl) {
  if (!cloneUrl || typeof cloneUrl !== 'string') return null;
  try {
    const u = new URL(cloneUrl);
    return { host: u.host, origin: u.origin, protocol: u.protocol };
  } catch {
    return null;
  }
}

function splitFullName(fullName) {
  if (!fullName || !fullName.includes('/')) return null;
  const parts = fullName.split('/');
  if (parts.length < 2) return null;
  const name = parts.pop();
  const owner = parts.join('/');
  return { owner, name, path: `${owner}/${name}` };
}

function authHeaders(repo) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'at-field-ci-poller',
  };
  if (repo.git_token) {
    const token = String(repo.git_token);
    if (repo.provider === 'gitlab') {
      headers['PRIVATE-TOKEN'] = token;
    } else {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  return headers;
}

function normalizeCommits(list) {
  return (list || [])
    .map(c => ({
      id: c.sha || c.id || c.commit?.id || '',
      message: c.commit?.message || c.message || c.title || '',
      author:
        c.commit?.author?.name ||
        c.author?.login ||
        c.author?.name ||
        c.author_name ||
        '',
    }))
    .filter(c => c.id);
}

async function httpJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg =
      (data && (data.message || data.error || data.error_description)) ||
      text.slice(0, 200) ||
      res.statusText;
    const err = new Error(`HTTP ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function githubApiBase(repo) {
  const parsed = parseCloneHost(repo.clone_url);
  if (parsed && !/github\.com$/i.test(parsed.host)) {
    // GitHub Enterprise
    return `${parsed.origin}/api/v3`;
  }
  return 'https://api.github.com';
}

function giteaApiBase(repo) {
  const parsed = parseCloneHost(repo.clone_url);
  if (!parsed) {
    throw new Error('clone_url required for Gitea/Forgejo polling (e.g. https://git.example.com/owner/repo.git)');
  }
  return `${parsed.origin}/api/v1`;
}

function gitlabApiBase(repo) {
  const parsed = parseCloneHost(repo.clone_url);
  if (parsed && !/gitlab\.com$/i.test(parsed.host)) {
    return `${parsed.origin}/api/v4`;
  }
  if (parsed) return `${parsed.origin}/api/v4`;
  return 'https://gitlab.com/api/v4';
}

async function fetchGithubStyleCommits(repo, apiBase) {
  const parts = splitFullName(repo.full_name);
  if (!parts) throw new Error('Invalid full_name');
  const branch = repo.poll_branch || '';
  const qs = new URLSearchParams({ per_page: String(MAX_COMMITS_PER_POLL) });
  if (branch) qs.set('sha', branch);
  const url = `${apiBase}/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}/commits?${qs}`;
  const data = await httpJson(url, authHeaders(repo));
  return normalizeCommits(Array.isArray(data) ? data : []);
}

async function fetchGiteaCommits(repo) {
  const parts = splitFullName(repo.full_name);
  if (!parts) throw new Error('Invalid full_name');
  const base = giteaApiBase(repo);
  const qs = new URLSearchParams({ limit: String(MAX_COMMITS_PER_POLL) });
  if (repo.poll_branch) qs.set('sha', repo.poll_branch);
  const url = `${base}/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}/commits?${qs}`;
  const data = await httpJson(url, authHeaders(repo));
  return normalizeCommits(Array.isArray(data) ? data : []);
}

async function fetchGitlabCommits(repo) {
  const parts = splitFullName(repo.full_name);
  if (!parts) throw new Error('Invalid full_name');
  const base = gitlabApiBase(repo);
  const project = encodeURIComponent(parts.path);
  const qs = new URLSearchParams({ per_page: String(MAX_COMMITS_PER_POLL) });
  if (repo.poll_branch) qs.set('ref_name', repo.poll_branch);
  const url = `${base}/projects/${project}/repository/commits?${qs}`;
  const data = await httpJson(url, authHeaders(repo));
  return normalizeCommits(Array.isArray(data) ? data : []);
}

// Fetch newest commits for a repo (newest first).
async function fetchRecentCommits(repo) {
  const provider = repo.provider || 'github';
  if (provider === 'github') {
    return fetchGithubStyleCommits(repo, githubApiBase(repo));
  }
  if (provider === 'gitea' || provider === 'forgejo') {
    return fetchGiteaCommits(repo);
  }
  if (provider === 'gitlab') {
    return fetchGitlabCommits(repo);
  }
  // generic: try GitHub-compatible API from clone_url host
  const parsed = parseCloneHost(repo.clone_url);
  if (!parsed) {
    throw new Error('generic provider needs clone_url for polling');
  }
  // Prefer Gitea-style then GitHub-style
  try {
    return await fetchGiteaCommits({ ...repo, provider: 'gitea' });
  } catch (e1) {
    try {
      return await fetchGithubStyleCommits(repo, `${parsed.origin}/api/v3`);
    } catch (e2) {
      throw new Error(`generic poll failed: ${e1.message}; ${e2.message}`);
    }
  }
}

// Given newest-first commits and last seen SHA, return new commits oldest-first.
// If lastSha is null/empty, baseline mode (no new commits, caller stores HEAD).
// If lastSha not found in list, treat all fetched as new (capped).
function diffNewCommits(commitsNewestFirst, lastSha) {
  if (!commitsNewestFirst.length) {
    return { head: null, newCommits: [], baseline: !lastSha, gap: false };
  }
  const head = commitsNewestFirst[0].id;
  if (!lastSha) {
    return { head, newCommits: [], baseline: true, gap: false };
  }
  if (head === lastSha) {
    return { head, newCommits: [], baseline: false, gap: false };
  }

  const newer = [];
  let found = false;
  for (const c of commitsNewestFirst) {
    if (c.id === lastSha) {
      found = true;
      break;
    }
    newer.push(c);
  }
  // chronological order for job processing
  newer.reverse();
  return { head, newCommits: newer, baseline: false, gap: !found };
}

module.exports = {
  MAX_COMMITS_PER_POLL,
  fetchRecentCommits,
  diffNewCommits,
};
