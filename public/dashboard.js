const byId = (id) => document.getElementById(id);
const domains = byId('domains');
const domainTable = byId('domain-table');
const domainCount = byId('domain-count');
const auditTable = byId('audit-table');
const loadStatus = byId('load-status');
const domainDialog = byId('domain-dialog');
const dialogStatus = byId('dialog-status');
const removeCard = byId('remove-card');
const unmanage = byId('unmanage');
const unmanageStatus = byId('unmanage-status');
const removeButton = byId('remove');
const removeConfirm = byId('remove-confirm');
const removeTyped = byId('remove-typed');
const removeGo = byId('remove-go');
const removeStatus = byId('remove-status');
const connectionCard = byId('connection-card');
const connectionTag = byId('connection-tag');
const connectionDetail = byId('connection-detail');
const connectButton = byId('connect');
const connectStatus = byId('connect-status');
const domainsStatus = byId('domains-status');
const cfBanner = byId('cf-banner');
const cfBannerText = byId('cf-banner-text');
const connectAll = byId('connect-all');
const addDialog = byId('add-dialog');
const addForm = byId('add-form');
const addHostname = byId('add-hostname');
const addApp = byId('add-app');
const addAliases = byId('add-aliases');
const addPreview = byId('add-preview');
const addStatus = byId('add-status');
const addSubmit = byId('add-submit');
const addUsePreview = byId('add-use-preview');
const allowCard = byId('allow-card');
const allowList = byId('allow-list');
const allowTable = byId('allow-table');
const allowEmpty = byId('allow-empty');
const allowCount = byId('allow-count');
const allowForm = byId('allow-form');
const allowIp = byId('allow-ip');
const allowLabel = byId('allow-label');
const allowMine = byId('allow-mine');
const allowPaste = byId('allow-paste');
const allowPasteAdd = byId('allow-paste-add');
const allowCopyBox = byId('allow-copy-box');
const allowCopyTargets = byId('allow-copy-targets');
const allowCopy = byId('allow-copy');
const allowStatus = byId('allow-status');
const allowControls = () => [allowIp, allowLabel, allowMine, allowPaste, allowPasteAdd, allowCopy,
  ...allowForm.querySelectorAll('button'), ...allowList.querySelectorAll('button')];
const MAX_ALLOWED_IPS = 200;
const settings = byId('settings');
const history = byId('history');
const historyStatus = byId('history-status');
const form = byId('policy');
const preview = byId('preview');
const statusTag = byId('public-status');
const managed = byId('managed');
const maintenance = byId('maintenance');
const basicAuth = byId('basic-auth');
const message = byId('message');
const retryAfter = byId('retry-after');
const controls = [managed, maintenance, basicAuth, message, retryAfter];
const loginCard = byId('login-card');
const loginForm = byId('login');
const loginSource = byId('login-source');
const loginUsername = byId('login-username');
const loginPassword = byId('login-password');
const generate = byId('generate');
const reveal = byId('reveal');
const saveLogin = byId('save-login');
const loginStatus = byId('login-status');
const loginControls = [loginUsername, loginPassword, generate, reveal, saveLogin];
const save = byId('save');
const reload = byId('reload');
const saveStatus = byId('save-status');
const audit = byId('audit');
const dateDisplay = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const fields = {
  managed: 'Managed',
  allowedIp: 'Allowed IP',
  previewLogin: 'Preview login',
  maintenanceEnabled: 'Maintenance mode',
  basicAuthEnabled: 'Basic Auth',
  maintenanceMessage: 'Maintenance message',
  retryAfterAt: 'Expected recovery time',
};

let current = null;
let policy = null;
let generation = 0;
const rows = new Map();
let domainList = [];
let appsInfo = { apps: [], cloudflare: false, zones: [] };
let routeStatus = { configured: false, domains: {} };
const hostnamesOf = (domain) => [domain.hostname, domain.preview, ...(domain.aliases ?? [])].filter(Boolean);
const usedHostnames = () => new Set(domainList.flatMap(hostnamesOf));

async function api(path, options) {
  const response = await fetch(path, { ...options, cache: 'no-store' });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

const endpoint = (domain) => `/api/domains/${encodeURIComponent(domain.hostname)}`;

function status(element, text, failed = false) {
  element.textContent = text;
  element.dataset.error = String(failed);
}

function localDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function publicMode(value) {
  if (value.managed === false) return ['off', 'Not managed'];
  if (value.maintenanceEnabled) return ['maintenance', 'In maintenance'];
  if (value.basicAuthEnabled) return ['protected', 'Basic Auth enabled'];
  return ['open', 'Publicly accessible'];
}

function setTag(element, value) {
  const [mode, label] = publicMode(value);
  element.dataset.mode = mode;
  element.textContent = label;
}

function setFlag(element, on) {
  element.dataset.on = String(on);
  element.textContent = on ? 'On' : 'Off';
}

function previewUrl(domain) {
  const local = domain.preview.endsWith('.localhost');
  const port = local && location.port ? `:${location.port}` : '';
  return `${local ? location.protocol : 'https:'}//${domain.preview}${port}/`;
}

function addRow(domain) {
  const row = document.createElement('tr');
  const cells = Array.from({ length: 6 }, () => document.createElement('td'));
  const [name, state, maintenanceCell, authCell, previewCell, actionCell] = cells;
  // Classes and labels let small screens show each row as a card.
  const layout = [['c-name'], ['c-status', 'Status'], ['c-maintenance', 'Maintenance'],
    ['c-auth', 'Basic Auth'], ['c-preview', 'Preview'], ['c-action']];
  cells.forEach((item, index) => {
    const [className, label] = layout[index];
    item.classList.add(className);
    if (label) item.dataset.label = label;
  });

  name.classList.add('hostname');
  name.textContent = domain.hostname;
  if (domain.aliases?.length) {
    const aliases = document.createElement('small');
    aliases.className = 'aliases';
    aliases.textContent = `Also: ${domain.aliases.join(', ')}`;
    name.append(aliases);
  }
  const tag = document.createElement('span');
  tag.className = 'status-tag';
  tag.textContent = '…';
  const routeTag = document.createElement('span');
  routeTag.className = 'status-tag route-tag';
  routeTag.dataset.mode = 'none';
  routeTag.textContent = 'Not connected';
  routeTag.hidden = true;
  state.append(tag, routeTag);
  maintenanceCell.classList.add('flag');
  authCell.classList.add('flag');
  maintenanceCell.textContent = '…';
  authCell.textContent = '…';
  if (domain.preview) {
    const link = document.createElement('a');
    link.href = previewUrl(domain);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = domain.preview;
    previewCell.append(link);
  } else {
    previewCell.textContent = '—';
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-action';
  button.textContent = 'Manage';
  button.setAttribute('aria-label', `Manage ${domain.hostname}`);
  button.addEventListener('click', () => selectDomain(domain));
  actionCell.append(button);

  row.dataset.hostname = domain.hostname;
  row.append(...cells);
  domains.append(row);
  rows.set(domain.hostname, { row, tag, routeTag, maintenanceCell, authCell });
}

function updateRow(hostname, value) {
  const row = rows.get(hostname);
  if (!row) return;
  row.row.dataset.managed = String(value.managed !== false);
  setTag(row.tag, value);
  setFlag(row.maintenanceCell, value.maintenanceEnabled);
  setFlag(row.authCell, value.basicAuthEnabled);
}

const loginLabels = {
  dashboard: ['open', 'Set in dashboard'],
  secret: ['protected', 'Using deploy secret'],
  none: ['none', 'Not set'],
};

function setPasswordVisible(visible) {
  loginPassword.type = visible ? 'text' : 'password';
  reveal.textContent = visible ? 'Hide' : 'Show';
  reveal.setAttribute('aria-pressed', String(visible));
}

function showLogin(value) {
  const [mode, label] = loginLabels[value.loginSource] ?? loginLabels.none;
  loginSource.dataset.mode = mode;
  loginSource.textContent = label;
  loginUsername.value = value.login?.username ?? '';
  loginPassword.value = '';
  setPasswordVisible(false);
  let note = '';
  if (value.login) note = `Last changed ${dateDisplay.format(new Date(value.login.updatedAt))}.`;
  else if (value.loginSource === 'secret') note = 'Saving a login here replaces the deploy secret for this domain.';
  else note = 'Set a login to open the preview and to enable Basic Auth.';
  status(loginStatus, note);
}

// Single addresses read better without /32 or /128.
const displayCidr = (cidr) => {
  const single = cidr.includes(':') ? '/128' : '/32';
  return cidr.endsWith(single) ? cidr.slice(0, -single.length) : cidr;
};
const asEntries = (list) => list.map(({ cidr, label }) => ({ ip: cidr, label }));

function renderAllowlist(list) {
  allowList.replaceChildren();
  allowTable.hidden = !list.length;
  allowEmpty.hidden = list.length > 0;
  allowCount.textContent = `${list.length} of ${MAX_ALLOWED_IPS}`;
  for (const entry of list) {
    const row = document.createElement('tr');
    const address = cell(displayCidr(entry.cidr), 'allow-cidr');
    const label = cell(entry.label || '—', 'allow-label');
    const action = document.createElement('td');
    action.className = 'allow-action';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'link-button';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${displayCidr(entry.cidr)}`);
    remove.addEventListener('click', () => {
      const next = (policy?.allowlist ?? []).filter((item) => item.cidr !== entry.cidr);
      saveAllowlist(asEntries(next), `Removed ${displayCidr(entry.cidr)}.`);
    });
    action.append(remove);
    row.append(address, label, action);
    allowList.append(row);
  }
}

async function saveAllowlist(entries, success) {
  if (!current || !policy) return false;
  const domain = current;
  const requestGeneration = generation;
  for (const control of allowControls()) control.disabled = true;
  status(allowStatus, 'Saving…');
  try {
    const updated = await api(`${endpoint(domain)}/allowlist`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${policy.revision}"` },
      body: JSON.stringify({ entries }),
    });
    if (requestGeneration !== generation) return false;
    showPolicy(updated, { refreshLogin: false });
    status(allowStatus, `${success} It applies immediately.`);
    await loadHistory(domain, requestGeneration);
    return true;
  } catch (error) {
    if (requestGeneration === generation) {
      const message = error.status === 412 ? 'This domain changed elsewhere. Close and reopen it, then try again.' : error.message;
      status(allowStatus, message, true);
    }
    return false;
  } finally {
    if (requestGeneration === generation) for (const control of allowControls()) control.disabled = false;
  }
}

function renderCopyTargets() {
  allowCopyTargets.replaceChildren();
  const others = domainList.filter((item) => item.hostname !== current?.hostname);
  allowCopyBox.hidden = !others.length;
  for (const item of others) {
    const label = document.createElement('label');
    label.className = 'check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = item.hostname;
    label.append(box, ` ${item.hostname}`);
    allowCopyTargets.append(label);
  }
}

function showPolicy(value, { refreshLogin = true } = {}) {
  policy = value;
  managed.checked = value.managed !== false;
  maintenance.checked = value.maintenanceEnabled;
  basicAuth.checked = value.basicAuthEnabled;
  message.value = value.maintenanceMessage;
  retryAfter.value = localDate(value.retryAfterAt);
  setTag(statusTag, value);
  if (refreshLogin) showLogin(value);
  renderAllowlist(value.allowlist ?? []);
  unmanage.disabled = value.managed === false;
  unmanage.textContent = value.managed === false ? 'Not managed' : 'Stop managing now';
  if (current) updateRow(current.hostname, value);
}

function displayValue(field, value) {
  if (value === null) return field === 'allowedIp' ? '—' : 'None';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (field === 'retryAfterAt') return dateDisplay.format(new Date(value));
  return value;
}

function cell(text, className, label) {
  const td = document.createElement('td');
  if (className) td.className = className;
  if (label) td.dataset.label = label;
  td.textContent = text;
  return td;
}

function renderHistory(entries) {
  audit.replaceChildren();
  auditTable.hidden = !entries.length;
  status(historyStatus, entries.length ? '' : 'No changes yet.');
  for (const entry of entries) {
    entry.changes.forEach(({ field, before, after }, index) => {
      const row = document.createElement('tr');
      const when = document.createElement('td');
      when.className = 'audit-time';
      if (index === 0) {
        row.className = 'group-start';
        const time = document.createElement('time');
        time.dateTime = entry.changedAt;
        time.textContent = dateDisplay.format(new Date(entry.changedAt));
        when.append(time);
      }
      row.append(
        when,
        cell(index === 0 ? entry.actor : '', 'audit-actor'),
        cell(fields[field] ?? field, 'audit-setting'),
        cell(displayValue(field, before), 'audit-before', 'Previous'),
        cell(displayValue(field, after), 'audit-new', 'New'),
      );
      audit.append(row);
    });
  }
}

async function loadHistory(domain, requestGeneration) {
  status(historyStatus, 'Loading history…');
  try {
    const entries = await api(`${endpoint(domain)}/audit`);
    if (requestGeneration === generation) renderHistory(entries);
  } catch (error) {
    if (requestGeneration === generation) status(historyStatus, error.message, true);
  }
}

async function selectDomain(domain) {
  current = domain;
  policy = null;
  const requestGeneration = ++generation;
  settings.hidden = true;
  loginCard.hidden = true;
  history.hidden = true;
  removeCard.hidden = true;
  connectionCard.hidden = true;
  removeConfirm.hidden = true;
  removeButton.hidden = false;
  status(removeStatus, '');
  status(connectStatus, '');
  allowCard.hidden = true;
  status(allowStatus, '');
  allowForm.reset();
  allowPaste.value = '';
  for (const details of allowCard.querySelectorAll('details')) details.open = false;
  status(unmanageStatus, '');
  byId('selected-domain').textContent = domain.hostname;
  status(dialogStatus, 'Loading settings…');
  if (!domainDialog.open) domainDialog.showModal();
  reload.hidden = true;
  save.disabled = false;
  for (const input of [...controls, ...loginControls]) input.disabled = false;
  audit.replaceChildren();
  auditTable.hidden = true;
  status(saveStatus, '');
  for (const row of domains.children) {
    row.setAttribute('aria-selected', String(row.dataset.hostname === domain.hostname));
  }

  try {
    const value = await api(endpoint(domain));
    if (requestGeneration !== generation) return;
    status(dialogStatus, '');
    byId('remove-name').textContent = domain.hostname;
    byId('remove-preview-note').hidden = !domain.preview;
    showConnection(domain);
    const aliasNote = byId('selected-aliases');
    aliasNote.hidden = !domain.aliases?.length;
    aliasNote.textContent = domain.aliases?.length ? `Same settings apply to ${domain.aliases.join(', ')}` : '';
    preview.hidden = !domain.preview;
    if (domain.preview) preview.href = previewUrl(domain);
    showPolicy(value);
    settings.hidden = false;
    loginCard.hidden = false;
    history.hidden = false;
    removeCard.hidden = false;
    connectionCard.hidden = false;
    allowCard.hidden = false;
    renderCopyTargets();
    await loadHistory(domain, requestGeneration);
  } catch (error) {
    if (requestGeneration === generation) status(dialogStatus, error.message, true);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!current || !policy) return;
  const domain = current;
  const requestGeneration = generation;
  const data = {
    managed: managed.checked,
    maintenanceEnabled: maintenance.checked,
    basicAuthEnabled: basicAuth.checked,
    maintenanceMessage: message.value,
    retryAfterAt: retryAfter.value ? new Date(retryAfter.value).toISOString() : null,
  };
  // Preserve the exact API timestamp when the displayed minute is unchanged.
  if (retryAfter.value === localDate(policy.retryAfterAt)) data.retryAfterAt = policy.retryAfterAt;
  const patch = Object.fromEntries(Object.entries(data).filter(([field, value]) => value !== policy[field]));
  if (!Object.keys(patch).length) {
    status(saveStatus, 'No changes to save.');
    return;
  }
  save.disabled = true;
  for (const input of controls) input.disabled = true;
  status(saveStatus, 'Saving…');
  try {
    const updated = await api(endpoint(domain), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${policy.revision}"` },
      body: JSON.stringify(patch),
    });
    if (requestGeneration !== generation) return;
    // Keep any password being typed in the login form.
    showPolicy(updated, { refreshLogin: false });
    reload.hidden = true;
    status(saveStatus, 'Changes saved.');
    await loadHistory(domain, requestGeneration);
  } catch (error) {
    if (requestGeneration !== generation) return;
    status(saveStatus, error.message, true);
    reload.hidden = error.status !== 412;
  } finally {
    if (requestGeneration === generation) {
      for (const input of controls) input.disabled = false;
      save.disabled = false;
    }
  }
});

reload.addEventListener('click', () => selectDomain(current));

// Dialogs: close buttons, backdrop clicks, and cleanup when the domain dialog closes.
for (const dialog of [domainDialog, addDialog]) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
  });
}
domainDialog.addEventListener('close', () => {
  generation++;
  current = null;
  policy = null;
  for (const row of domains.children) row.setAttribute('aria-selected', 'false');
});

unmanage.addEventListener('click', async () => {
  if (!current || !policy) return;
  const domain = current;
  const requestGeneration = generation;
  unmanage.disabled = true;
  status(unmanageStatus, 'Saving…');
  try {
    const updated = await api(endpoint(domain), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${policy.revision}"` },
      body: JSON.stringify({ managed: false }),
    });
    if (requestGeneration !== generation) return;
    showPolicy(updated, { refreshLogin: false });
    status(unmanageStatus, 'Requests now go straight to the app.');
    await loadHistory(domain, requestGeneration);
  } catch (error) {
    if (requestGeneration !== generation) return;
    status(unmanageStatus, error.message, true);
    unmanage.disabled = false;
  }
});

allowForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const ip = allowIp.value.trim();
  const added = await saveAllowlist(
    [...asEntries(policy?.allowlist ?? []), { ip, label: allowLabel.value.trim() }],
    `Added ${ip}.`,
  );
  if (added) allowForm.reset();
});

allowMine.addEventListener('click', async () => {
  try {
    const client = await api('/api/client-ip');
    if (!client.suggested) return status(allowStatus, 'Your IP address is not available here.', true);
    const label = allowLabel.value.trim() || 'My current IP';
    const note = client.suggested.endsWith('/64') ? ` (your IPv6 network ${client.suggested})` : '';
    if (await saveAllowlist([...asEntries(policy?.allowlist ?? []), { ip: client.suggested, label }], `Added ${client.ip}${note}.`)) {
      allowForm.reset();
    }
  } catch (error) {
    status(allowStatus, error.message, true);
  }
});

allowPasteAdd.addEventListener('click', async () => {
  const pasted = allowPaste.value.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [ip, ...rest] = line.split(/[\s,]+/);
      return { ip, label: rest.join(' ').slice(0, 60) };
    });
  if (!pasted.length) return status(allowStatus, 'Paste at least one IP address or range.', true);
  const saved = await saveAllowlist([...asEntries(policy?.allowlist ?? []), ...pasted],
    `Added ${pasted.length} ${pasted.length === 1 ? 'entry' : 'entries'}. Repeats were skipped.`);
  if (saved) allowPaste.value = '';
});

allowCopy.addEventListener('click', async () => {
  const targets = [...allowCopyTargets.querySelectorAll('input:checked')].map((box) => box.value);
  const entries = asEntries(policy?.allowlist ?? []);
  if (!targets.length) return status(allowStatus, 'Choose at least one domain.', true);
  if (!entries.length) return status(allowStatus, 'This domain has no allowed IPs to copy.', true);
  allowCopy.disabled = true;
  status(allowStatus, 'Copying…');
  const failed = [];
  for (const hostname of targets) {
    const path = `/api/domains/${encodeURIComponent(hostname)}`;
    try {
      const target = await api(path);
      await api(`${path}/allowlist`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': `"${target.revision}"` },
        body: JSON.stringify({ entries: [...asEntries(target.allowlist ?? []), ...entries] }),
      });
    } catch (error) {
      failed.push(`${hostname} (${error.message})`);
    }
  }
  allowCopy.disabled = false;
  const copied = targets.length - failed.length;
  if (failed.length) status(allowStatus, `Copied to ${copied} of ${targets.length}. Failed: ${failed.join('; ')}`, true);
  else status(allowStatus, `Copied to ${copied} ${copied === 1 ? 'domain' : 'domains'}. It applies immediately.`);
  for (const box of allowCopyTargets.querySelectorAll('input')) box.checked = false;
});

// Routes: which domains have their Cloudflare routes pointing at this dashboard.
function routeInfo(hostname) {
  if (!routeStatus.configured) return null;
  return routeStatus.domains[hostname] ?? { connected: false, missing: [] };
}

function showConnection(domain) {
  const info = routeInfo(domain.hostname);
  connectButton.disabled = !appsInfo.cloudflare;
  if (!appsInfo.cloudflare) {
    connectionTag.dataset.mode = 'off';
    connectionTag.textContent = 'Not checked';
    connectionDetail.textContent = 'Set the CLOUDFLARE_API_TOKEN secret to check and change routes from here.';
    connectButton.hidden = true;
    return;
  }
  connectButton.hidden = !!info?.connected;
  connectionTag.dataset.mode = info?.connected ? 'open' : 'none';
  connectionTag.textContent = info?.connected ? 'Connected' : 'Not connected';
  connectionDetail.textContent = info?.connected
    ? `${hostnamesOf(domain).map((host) => `${host}/*`).join(', ')} point to this dashboard.`
    : `Missing: ${(info?.missing?.length ? info.missing : hostnamesOf(domain).map((host) => `${host}/*`)).join(', ')}. Until they are connected, requests go straight to the app and these settings do not apply.`;
}

function renderBanner() {
  const disconnected = domainList.filter((domain) => routeInfo(domain.hostname)?.connected === false);
  let text = '';
  if (!appsInfo.cloudflare) text = 'Adding, removing and connecting domains needs the CLOUDFLARE_API_TOKEN secret. Everything else works without it.';
  else if (disconnected.length) {
    text = `${disconnected.length === 1 ? '1 domain is' : `${disconnected.length} domains are`} not connected, so their maintenance settings do not apply yet.`;
  }
  cfBannerText.textContent = text;
  cfBanner.hidden = !text;
  connectAll.hidden = !appsInfo.cloudflare || !disconnected.length;
  for (const domain of domainList) {
    const row = rows.get(domain.hostname);
    if (row) row.routeTag.hidden = routeInfo(domain.hostname)?.connected !== false;
  }
}

async function refreshRoutes() {
  try {
    routeStatus = await api('/api/route-status');
  } catch (error) {
    routeStatus = { configured: false, domains: {} };
    status(domainsStatus, `Could not check Cloudflare routes. ${error.message}`, true);
  }
  renderBanner();
  if (current) showConnection(current);
}

async function connectDomain(domain) {
  const result = await api(`${endpoint(domain)}/connect`, { method: 'POST' });
  return result.warnings ?? [];
}

connectButton.addEventListener('click', async () => {
  if (!current) return;
  const domain = current;
  connectButton.disabled = true;
  status(connectStatus, 'Connecting…');
  try {
    const warnings = await connectDomain(domain);
    await refreshRoutes();
    status(connectStatus, ['Routes connected.', ...warnings].join(' '));
  } catch (error) {
    status(connectStatus, error.message, true);
  } finally {
    connectButton.disabled = false;
  }
});

connectAll.addEventListener('click', async () => {
  const targets = domainList.filter((domain) => routeInfo(domain.hostname)?.connected === false);
  connectAll.disabled = true;
  status(domainsStatus, 'Connecting…');
  const problems = [];
  for (const domain of targets) {
    try {
      problems.push(...await connectDomain(domain));
    } catch (error) {
      problems.push(`${domain.hostname}: ${error.message}`);
    }
  }
  connectAll.disabled = false;
  await refreshRoutes();
  status(domainsStatus, problems.length ? problems.join(' ') : `Connected ${targets.length} ${targets.length === 1 ? 'domain' : 'domains'}.`, problems.some((item) => item.includes(':')));
});

// Remove: type the hostname to confirm, then delete routes and the registry entry.
removeButton.addEventListener('click', () => {
  if (!appsInfo.cloudflare) {
    status(removeStatus, 'Set the CLOUDFLARE_API_TOKEN secret to remove domains from here.', true);
    return;
  }
  removeButton.hidden = true;
  removeConfirm.hidden = false;
  removeTyped.value = '';
  removeGo.disabled = true;
  removeTyped.focus();
});
byId('remove-cancel').addEventListener('click', () => {
  removeConfirm.hidden = true;
  removeButton.hidden = false;
});
removeTyped.addEventListener('input', () => {
  removeGo.disabled = removeTyped.value.trim().toLowerCase() !== current?.hostname;
});
removeGo.addEventListener('click', async () => {
  if (!current) return;
  const domain = current;
  removeGo.disabled = true;
  status(removeStatus, 'Removing…');
  try {
    const result = await api(endpoint(domain), { method: 'DELETE' });
    domainList = domainList.filter((item) => item.hostname !== domain.hostname);
    rows.get(domain.hostname)?.row.remove();
    rows.delete(domain.hostname);
    updateCount();
    domainDialog.close();
    status(domainsStatus, [`Removed ${domain.hostname}. Its traffic now goes straight to the app.`, ...result.warnings].join(' '));
    renderBanner();
  } catch (error) {
    status(removeStatus, error.message, true);
    removeGo.disabled = false;
  }
});

// Add domain: validate as you type, then create the routes through the API.
const hostPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const cleanHost = (value) => value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

// blog.example.com -> blog-preview.example.com; the zone apex example.com -> preview.example.com.
function suggestedPreview(host) {
  const labels = host.split('.');
  const apex = appsInfo.zones.length ? appsInfo.zones.includes(host) : labels.length <= 2;
  if (apex) return `preview.${host}`;
  return `${labels[0]}-preview.${labels.slice(1).join('.')}`;
}

function readAddForm() {
  const host = cleanHost(addHostname.value);
  const aliases = addAliases.value.split(',').map(cleanHost).filter(Boolean);
  const usePreview = addUsePreview.checked;
  addPreview.disabled = !usePreview;
  addPreview.placeholder = hostPattern.test(host) ? suggestedPreview(host) : '';
  const preview = usePreview ? cleanHost(addPreview.value) || (hostPattern.test(host) ? suggestedPreview(host) : '') : null;
  const hosts = [host, ...aliases, ...(preview ? [preview] : [])];

  let problem = '';
  if (!appsInfo.cloudflare) problem = 'Set the CLOUDFLARE_API_TOKEN secret to add domains from here.';
  else if (!appsInfo.apps.length) problem = 'No app Workers are connected yet. Run npm run app:add first.';
  else if (!host) problem = 'Enter the public hostname.';
  else if (hosts.some((item) => !hostPattern.test(item))) problem = `"${hosts.find((item) => !hostPattern.test(item))}" is not a valid hostname.`;
  else if (new Set(hosts).size !== hosts.length) problem = 'The hostname, aliases and preview must all differ.';
  else if (hosts.some((item) => usedHostnames().has(item))) problem = `${hosts.find((item) => usedHostnames().has(item))} is already used by a listed domain.`;
  else if (appsInfo.zones.length && !hosts.every((item) => appsInfo.zones.some((zone) => item === zone || item.endsWith(`.${zone}`)))) {
    problem = `Every hostname must be in ${appsInfo.zones.join(' or ')}.`;
  }
  return { body: { hostname: host, service: addApp.value, aliases, preview }, problem, preview };
}

function checkAddForm() {
  const { problem, preview, body } = readAddForm();
  addSubmit.disabled = !!problem;
  const empty = !body.hostname;
  if (problem) status(addStatus, problem, !empty && appsInfo.cloudflare);
  else status(addStatus, preview ? `The preview will be https://${preview}.` : 'No preview. Use allowed IPs to check the site during maintenance.');
}

addForm.addEventListener('input', checkAddForm);
addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const { body, problem } = readAddForm();
  if (problem) return status(addStatus, problem, true);
  addSubmit.disabled = true;
  status(addStatus, 'Creating routes in Cloudflare…');
  try {
    const result = await api('/api/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const domain = result.domain;
    domainList.push(domain);
    addRow(domain);
    updateCount();
    updateRow(domain.hostname, await api(endpoint(domain)));
    addDialog.close();
    await refreshRoutes();
    status(domainsStatus, [`Added ${domain.hostname}.`, ...result.warnings].join(' '));
    await selectDomain(domain);
  } catch (error) {
    status(addStatus, error.message, true);
    addSubmit.disabled = false;
  }
});

byId('open-add').addEventListener('click', () => {
  addForm.reset();
  addApp.replaceChildren(...appsInfo.apps.map((app) => {
    const option = document.createElement('option');
    option.value = app.binding;
    option.textContent = app.worker;
    return option;
  }));
  if (appsInfo.zones.length) byId('add-zone-hint').textContent = `Must be in ${appsInfo.zones.join(' or ')}.`;
  checkAddForm();
  addDialog.showModal();
  addHostname.focus();
});

generate.addEventListener('click', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  loginPassword.value = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
  setPasswordVisible(true);
  loginPassword.select();
  status(loginStatus, 'Copy this password somewhere safe before saving.');
});

reveal.addEventListener('click', () => setPasswordVisible(loginPassword.type === 'password'));

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!current || !policy) return;
  const domain = current;
  const requestGeneration = generation;
  for (const input of loginControls) input.disabled = true;
  status(loginStatus, 'Saving…');
  try {
    const updated = await api(`${endpoint(domain)}/login`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: loginUsername.value.trim(), password: loginPassword.value }),
    });
    if (requestGeneration !== generation) return;
    showPolicy(updated);
    status(loginStatus, 'Login saved. It applies immediately.');
    await loadHistory(domain, requestGeneration);
  } catch (error) {
    if (requestGeneration === generation) status(loginStatus, error.message, true);
  } finally {
    if (requestGeneration === generation) for (const input of loginControls) input.disabled = false;
  }
});

function updateCount() {
  domainCount.textContent = `${domainList.length} ${domainList.length === 1 ? 'domain' : 'domains'}`;
  domainTable.hidden = !domainList.length;
  status(loadStatus, domainList.length ? '' : 'No domains yet. Select Add domain to connect one.');
}

try {
  const [list, apps] = await Promise.all([api('/api/domains'), api('/api/apps')]);
  domainList = list;
  appsInfo = apps;
  for (const domain of list) addRow(domain);
  updateCount();
  await Promise.all(list.map(async (domain) => {
    try {
      updateRow(domain.hostname, await api(endpoint(domain)));
    } catch {
      rows.get(domain.hostname).tag.textContent = 'Unavailable';
    }
  }));
  renderBanner();
  if (appsInfo.cloudflare) await refreshRoutes();
} catch (error) {
  status(loadStatus, error.message, true);
}

// Basic Auth has no logout. Sign in to /logout with a placeholder login so the browser saves it
// in place of the real one; the dashboard rejects it, so the next visit asks to sign in again.
byId('sign-out').addEventListener('click', () => {
  const request = new XMLHttpRequest();
  request.open('GET', '/logout', true, 'signed-out', 'signed-out');
  request.onloadend = () => location.replace('/signed-out');
  request.send();
});
