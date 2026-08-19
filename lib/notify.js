'use strict';

// Notification delivery - Shoutrrr-style push notifications.
// Supported targets: discord, slack, telegram, pushover, gotify, ntfy, generic.
// Generic covers SMS/email gateways that expose an HTTP API (Twilio, Mailgun,
// Postmark, SendGrid, ...) and any custom webhook endpoint.

const NOTIFY_TIMEOUT_MS = 10000;

// Shoutrrr-style generic URL: generic://host/path or generic+https://host/path.
// Query params prefixed @ become headers, $ become JSON body fields
// (template=json), and template/disabletls/contenttype/method/titlekey/
// messagekey are config props; everything else is forwarded to the target.
function buildGenericRequest(config, payload) {
  const parsed = new URL(config.url);
  const disableTls = parsed.searchParams.get('disabletls') === 'yes';
  const scheme = parsed.protocol === 'generic+https:' || !disableTls ? 'https' : 'http';

  const headers = {};
  const bodyFields = {};
  const targetParams = new URLSearchParams();
  const template = parsed.searchParams.get('template') || '';
  const contentType = parsed.searchParams.get('contenttype');
  const method = (parsed.searchParams.get('method') || 'POST').toUpperCase();
  const titleKey = parsed.searchParams.get('titlekey') || 'title';
  const messageKey = parsed.searchParams.get('messagekey') || 'message';

  for (const [key, raw] of parsed.searchParams.entries()) {
    let name = key;
    let value = raw;
    if (name.startsWith('@')) {
      headers[name.slice(1)] = value;
    } else if (name.startsWith('$')) {
      bodyFields[name.slice(1)] = value;
    } else if (!['disabletls', 'template', 'contenttype', 'method', 'titlekey', 'messagekey'].includes(name)) {
      targetParams.append(name, value);
    }
  }
  const qs = targetParams.toString();
  const rebuilt = `${scheme}://${parsed.host}${parsed.pathname || '/'}${qs ? `?${qs}` : ''}`;

  if (config.token && !Object.keys(headers).some(h => h.toLowerCase() === 'authorization')) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  let body;
  let bodyContentType = contentType;
  if (template === 'json') {
    body = JSON.stringify({ [titleKey]: payload.title, [messageKey]: payload.message, ...bodyFields });
    bodyContentType = bodyContentType || 'application/json';
  } else {
    body = payload.message;
    bodyContentType = bodyContentType || 'text/plain';
  }
  headers['Content-Type'] = bodyContentType;

  return { url: rebuilt, method, headers, body };
}

// Targets may arrive as DB rows (config fields spread to top level) or raw
// objects ({ type, config }). Normalize so send() always sees config.
function normalizeTarget(target) {
  const cfg = { ...(target.config || {}) };
  for (const [k, v] of Object.entries(target)) {
    if (!['id', 'user_id', 'name', 'type', 'enabled', 'events', 'created_at', 'updated_at', 'config'].includes(k)) {
      cfg[k] = v;
    }
  }
  return { ...target, config: cfg };
}

/** Fill {{placeholder}} fields in a custom message template from the payload.
 * Tokens missing from the payload render as empty so a template can never
 * leak raw "{{...}}" text into a message. */
function renderTemplate(template, payload) {
  if (!template || typeof template !== 'string') return null;
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key) => {
    const value = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), payload);
    return value == null ? '' : String(value);
  });
}

// Standard fields every template can use. Missing ones are filled with empty
// strings so templates render cleanly for test/ping/status/job payloads alike.
const TEMPLATE_DEFAULTS = {
  title: '',
  message: '',
  repo: '',
  repo_slug: '',
  keyword: '',
  job_id: '',
  duration: '',
  status: '',
  commit: '',
  trigger: '',
  ok: true,
  event: '',
};

async function send(rawTarget, rawPayload) {
  const target = normalizeTarget(rawTarget);
  const { type, config = {} } = target;
  const payload = { ...TEMPLATE_DEFAULTS, ...rawPayload };
  const title = payload.title || 'AT FIELD CICD';
  // Only fall back to the standard message when NO template is configured.
  // A configured template is always used as-is so it can never be silently
  // replaced with a totally different message.
  const message = config.message_template
    ? renderTemplate(config.message_template, payload) || ''
    : payload.message || '';

  let url;
  let options = {
    method: 'POST',
    signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
  };

  switch (type) {
    case 'discord': {
      // config: { url: "https://discord.com/api/webhooks/ID/TOKEN" }
      url = config.url;
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify({ content: `**${title}**\n${message}` });
      break;
    }
    case 'slack': {
      // config: { url: "https://hooks.slack.com/services/..." }
      url = config.url;
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify({ text: `*${title}*\n${message}` });
      break;
    }
    case 'telegram': {
      // config: { bot_token: "...", chat_id: "..." }
      url = `https://api.telegram.org/bot${config.bot_token}/sendMessage`;
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify({
        chat_id: config.chat_id,
        text: `${title}\n${message}`,
        disable_web_page_preview: true,
      });
      break;
    }
    case 'pushover': {
      // config: { api_token: "...", user_key: "..." }
      url = 'https://api.pushover.net/1/messages.json';
      options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      options.body = new URLSearchParams({
        token: config.api_token,
        user: config.user_key,
        title,
        message,
      }).toString();
      break;
    }
    case 'gotify': {
      // config: { url: "https://gotify.example.com", app_token: "..." }
      url = `${String(config.url).replace(/\/+$/, '')}/message`;
      options.headers = {
        'Content-Type': 'application/json',
        'X-Gotify-Key': config.app_token,
      };
      options.body = JSON.stringify({ title, message, priority: payload.ok === false ? 8 : 3 });
      break;
    }
    case 'ntfy': {
      // config: { url: "https://ntfy.sh/topic" or https://ntfy.example.com, topic: "..." }
      const base = String(config.url || 'https://ntfy.sh').replace(/\/+$/, '');
      url = config.topic ? `${base}/${config.topic}` : base;
      options.headers = {
        Title: title,
        Priority: payload.ok === false ? 'high' : 'default',
      };
      options.body = message;
      break;
    }
    case 'generic':
    default: {
      // config: { url: "http(s)://..." or "generic://...", token?: "..." }
      // Plain http(s) URLs: sends JSON { title, message, ok, ...payload } with optional bearer token.
      // generic:// URLs: Shoutrrr-style (see buildGenericRequest).
      if (/^generic(?:\+https)?:\/\//.test(config.url)) {
        const built = buildGenericRequest(config, { ...payload, title, message });
        url = built.url;
        options.method = built.method;
        options.headers = built.headers;
        options.body = built.body;
        break;
      }
      url = config.url;
      options.headers = { 'Content-Type': 'application/json' };
      if (config.token) options.headers.Authorization = `Bearer ${config.token}`;
      options.body = JSON.stringify({ ...payload, title, message });
      break;
    }
  }

  if (!url) throw new Error('Missing URL in notification config');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid notification URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Notification URL must be http(s)');
  }

  const res = await fetch(url, options);
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`${type} responded HTTP ${res.status}: ${body}`);
  }
  return { ok: true, status: res.status };
}

module.exports = { send };
