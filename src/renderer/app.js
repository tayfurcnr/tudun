const api = window.serviceManager;
document.querySelector('.window-controls').addEventListener('click', (event) => {
  const button = event.target.closest('[data-window-action]');
  if (button) api.windowControl(button.dataset.windowAction);
});
const ui = {
  list: document.getElementById('service-list'),
  search: document.getElementById('service-search'),
  heading: document.getElementById('view-heading'),
  description: document.getElementById('view-description'),
  count: document.getElementById('result-count'),
  refreshStatus: document.getElementById('refresh-status'),
  toast: document.getElementById('toast'),
  details: document.getElementById('service-details'),
  emptyDetail: document.getElementById('empty-detail'),
  dialog: document.getElementById('confirm-dialog'),
  unitDialog: document.getElementById('unit-dialog'),
  analysisDialog: document.getElementById('analysis-dialog'),
  hostDialog: document.getElementById('host-dialog'),
  hostSelect: document.getElementById('host-select'),
  logs: document.getElementById('log-output'),
  logsStatus: document.getElementById('logs-status'),
  lineCount: document.getElementById('log-line-count')
};

const state = {
  services: [],
  favorites: new Set(),
  hosts: [],
  host: 'local',
  hostEpoch: 0,
  view: 'all',
  search: '',
  selected: null,
  theme: 'dark',
  sidebarCollapsed: false,
  detailsCollapsed: false,
  sort: 'name',
  sortDirection: 1,
  refreshing: false,
  actionPending: null,
  toastTimer: null,
  logLines: [],
  logPaused: false,
  logLive: false,
  unitDraft: null,
  analysis: null
};

const remoteSelected = () => state.host !== 'local';
const favoriteKey = (unit) => state.host === 'local' ? unit : `${state.host}/${unit}`;

function renderHosts() {
  ui.hostSelect.replaceChildren(new Option('This computer', 'local'), ...state.hosts.map((host) => new Option(host, host)));
  ui.hostSelect.value = state.host;
  document.getElementById('remove-host').hidden = !remoteSelected();
  document.getElementById('add-service').disabled = false;
  document.getElementById('add-service').title = remoteSelected() ? `Create a service on ${state.host}` : '';
  document.querySelector('.sidebar-footer .system-pill').lastChild.textContent = remoteSelected() ? ` ${state.host}` : ' Ubuntu · systemd';
}

async function selectHost(host) {
  if (host !== 'local' && !state.hosts.includes(host)) return;
  state.hostEpoch += 1;
  state.host = host;
  state.refreshing = false;
  if (ui.analysisDialog.open) ui.analysisDialog.close();
  await stopLiveLogs();
  state.services = [];
  state.selected = null;
  state.logLines = [];
  state.logPaused = false;
  document.getElementById('history-range').value = 'live';
  document.getElementById('logs-status').textContent = 'Waiting for logs';
  document.getElementById('refresh-status').textContent = `Connecting to ${host === 'local' ? 'this computer' : host}…`;
  document.getElementById('system-state').textContent = host === 'local' ? 'System services' : host;
  document.getElementById('view-description').textContent = host === 'local' ? views[state.view][1] : `Viewing ${host} · unit editing available`;
  ui.list.innerHTML = '<div class="list-empty"><strong>Loading services…</strong><p>Connecting to the selected computer.</p></div>';
  renderHosts();
  renderCounts();
  renderDetails();
  renderLogs();
  persistSettings();
  refreshServices();
}

const views = {
  all: ['All Services', 'View and manage system services'],
  favorites: ['Favorites', 'Quick access to frequently used services'],
  running: ['Running', 'Services that are currently running'],
  stopped: ['Stopped', 'Services that are not running'],
  failed: ['Failed', 'Services in a failed state']
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function showToast(message, kind = 'info') {
  ui.toast.textContent = message;
  ui.toast.dataset.kind = kind;
  ui.toast.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => ui.toast.classList.remove('visible'), 3600);
}

function statusLabel(service) {
  const labels = { active: 'Running', inactive: 'Stopped', failed: 'Failed', activating: 'Starting', deactivating: 'Stopping', reloading: 'Reloading' };
  return labels[service.active] || service.active || 'Unknown';
}

function statusClass(service) {
  return service.active === 'active' ? 'active' : (service.active === 'failed' ? 'failed' : '');
}

function startupLabel(service) {
  const labels = {
    enabled: 'Enabled', 'enabled-runtime': 'Enabled', disabled: 'Disabled',
    'disabled-runtime': 'Disabled', static: 'Static', masked: 'Masked',
    'masked-runtime': 'Masked', indirect: 'Indirect', generated: 'Generated',
    transient: 'Transient', linked: 'Linked', 'linked-runtime': 'Linked'
  };
  return labels[service.startup] || service.startup || 'Unknown';
}

function startupClass(service) {
  if (service.startup === 'masked' || service.startup === 'masked-runtime') return 'masked';
  if (['disabled', 'disabled-runtime', 'static', 'indirect', 'generated', 'transient'].includes(service.startup)) return 'disabled';
  return '';
}

function filteredServices() {
  const query = state.search.trim().toLocaleLowerCase('en');
  return state.services.filter((service) => {
    if (state.view === 'favorites' && !state.favorites.has(favoriteKey(service.name))) return false;
    if (state.view === 'running' && service.active !== 'active') return false;
    if (state.view === 'stopped' && service.active !== 'inactive') return false;
    if (state.view === 'failed' && service.active !== 'failed') return false;
    if (query && !`${service.name} ${service.description} ${statusLabel(service)} ${startupLabel(service)}`.toLocaleLowerCase('en').includes(query)) return false;
    return true;
  }).sort((left, right) => {
    const a = String(left[state.sort] || left.name).toLocaleLowerCase('en');
    const b = String(right[state.sort] || right.name).toLocaleLowerCase('en');
    return a.localeCompare(b, 'en') * state.sortDirection;
  });
}

function renderList() {
  const rows = filteredServices();
  const previousScrollTop = ui.list.scrollTop;
  ui.count.textContent = `${rows.length} services`;
  ui.list.setAttribute('aria-busy', 'false');
  if (!rows.length) {
    const previous = state.selected;
    const searching = Boolean(state.search.trim());
    const emptyTitle = searching ? 'No matching services' : (state.view === 'favorites' ? 'No favorites yet' : (state.view === 'failed' ? 'No failed services' : 'No services in this view'));
    const emptyText = searching ? `No results for “${escapeHtml(state.search.trim())}”.` : (state.view === 'favorites' ? 'Use the star icon to add your frequently used services.' : (state.view === 'failed' ? 'There are no failed services on this system.' : 'No services match this filter.'));
    ui.list.innerHTML = `<div class="list-empty"><div class="empty-search-icon" aria-hidden="true">${searching ? '⌕' : '☷'}</div><strong>${emptyTitle}</strong><p>${emptyText}</p><button class="button button-quiet" data-clear-filter="${searching ? 'search' : 'view'}">${searching ? 'Clear search' : 'Show all services'}</button></div>`;
    ui.list.scrollTop = 0;
    state.selected = null;
    if (previous && state.logLive) stopLiveLogs();
    if (previous) {
      state.logLines = [];
      state.logPaused = false;
      document.getElementById('pause-button').textContent = 'Ⅱ  Pause';
      document.getElementById('logs-unit').textContent = 'Select a service';
      document.getElementById('logs-status').textContent = 'Waiting for logs';
      renderLogs();
    }
    renderDetails();
    return;
  }
  if (!rows.some((service) => service.name === state.selected)) {
    const previous = state.selected;
    state.selected = rows[0].name;
    if (previous && state.logLive) stopLiveLogs();
    if (previous) {
      state.logLines = [];
      state.logPaused = false;
      document.getElementById('pause-button').textContent = 'Ⅱ  Pause';
      document.getElementById('history-range').value = 'live';
      document.getElementById('logs-status').textContent = 'Click Live to load logs for this service';
      renderLogs();
    }
  }
  ui.list.innerHTML = rows.map((service) => `
    <div class="service-row service-grid${service.name === state.selected ? ' selected' : ''}" data-unit="${escapeHtml(service.name)}" role="option" aria-selected="${service.name === state.selected}">
      <button class="service-star${state.favorites.has(favoriteKey(service.name)) ? ' is-favorite' : ''}" data-favorite="${escapeHtml(service.name)}" aria-label="Toggle favorite">${state.favorites.has(favoriteKey(service.name)) ? '★' : '☆'}</button>
      <span class="service-name" title="${escapeHtml(service.name)}">${escapeHtml(service.name)}</span>
      <span class="service-description" title="${escapeHtml(service.description)}">${escapeHtml(service.description || 'No description')}</span>
      <span class="status-badge ${statusClass(service)}">${escapeHtml(statusLabel(service))}</span>
      <span class="startup-badge ${startupClass(service)}">${escapeHtml(startupLabel(service))}</span>
      <button class="analyze-button" type="button" data-analyze="${escapeHtml(service.name)}" aria-label="Analyze ${escapeHtml(service.name)}" ${remoteSelected() ? 'disabled title="Analysis is available for this computer only"' : ''}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 15h16M4 12l4-4 3 2 5-6"/></svg>Analyze</button>
    </div>`).join('');
  ui.list.scrollTop = previousScrollTop;
  renderDetails();
}

function formatTime(value) {
  if (!value || value === 'n/a') return '—';
  const normalized = value.replace(/^[A-Za-z]{3} /, '').replace(/ ([+-]\d{2})$/, ' $1:00');
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatMemory(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

function drawAnalysisChart(id, values, maximum) {
  const svg = document.getElementById(id);
  const area = svg.querySelector('.analysis-chart-area');
  const line = svg.querySelector('.analysis-chart-line');
  if (!values.length) {
    area.setAttribute('d', '');
    line.setAttribute('d', '');
    return;
  }
  const points = values.map((value, index) => {
    const x = 500 - (values.length - 1 - index) * (500 / 59);
    const y = 124 - Math.min(value / maximum, 1) * 112;
    return [x, y];
  });
  const linePath = points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  line.setAttribute('d', linePath);
  area.setAttribute('d', `${linePath} L 500 124 L ${points[0][0].toFixed(1)} 124 Z`);
}

function renderAnalysis(sample, cpuPercent) {
  const analysis = state.analysis;
  if (!analysis || analysis.unit !== sample.unit) return;
  document.getElementById('analysis-state').textContent = statusLabel(sample);
  document.getElementById('analysis-updated').textContent = `Updated ${new Date().toLocaleTimeString('en-US')}`;
  document.getElementById('analysis-cpu').textContent = cpuPercent === null ? '—' : `${cpuPercent < 10 ? cpuPercent.toFixed(1) : Math.round(cpuPercent)}%`;
  document.getElementById('analysis-memory').textContent = formatBytes(sample.memoryBytes);
  document.getElementById('analysis-tasks').textContent = sample.tasks === null ? '—' : String(sample.tasks);
  document.getElementById('analysis-peak').textContent = formatBytes(sample.peakBytes);
  document.getElementById('analysis-source').textContent = sample.cpuUsageNs === null
    ? 'CPU accounting is unavailable for this service.'
    : `Service-wide metrics · ${sample.source}`;
  document.getElementById('analysis-pid').textContent = `Main PID ${sample.pid || '—'}`;
  if (cpuPercent !== null) analysis.cpuHistory.push(cpuPercent);
  if (sample.memoryBytes !== null) analysis.memoryHistory.push(sample.memoryBytes);
  analysis.cpuHistory = analysis.cpuHistory.slice(-60);
  analysis.memoryHistory = analysis.memoryHistory.slice(-60);
  const cpuMax = Math.max(100, Math.ceil(Math.max(0, ...analysis.cpuHistory) / 25) * 25);
  const memoryMax = Math.max(1, ...analysis.memoryHistory) * 1.15;
  document.getElementById('analysis-cpu-scale').textContent = analysis.cpuHistory.length ? `0–${cpuMax}%` : 'Collecting samples';
  document.getElementById('analysis-memory-scale').textContent = analysis.memoryHistory.length ? `0–${formatBytes(memoryMax)}` : 'No data';
  drawAnalysisChart('analysis-cpu-chart', analysis.cpuHistory, cpuMax);
  drawAnalysisChart('analysis-memory-chart', analysis.memoryHistory, memoryMax);
}

async function sampleAnalysis(analysis) {
  if (state.analysis !== analysis || analysis.busy) return;
  analysis.busy = true;
  try {
    const sample = await api.serviceMetrics(analysis.unit, state.host);
    if (state.analysis !== analysis) return;
    let cpuPercent = null;
    if (analysis.previous && (analysis.previous.active !== sample.active || analysis.previous.pid !== sample.pid)) {
      analysis.cpuHistory = [];
      analysis.memoryHistory = [];
      analysis.previous = null;
    }
    if (sample.cpuUsageNs !== null && analysis.previous && analysis.previous.cpuUsageNs !== null && analysis.previous.source === sample.source) {
      const usageDelta = BigInt(sample.cpuUsageNs) - BigInt(analysis.previous.cpuUsageNs);
      const timeDelta = BigInt(sample.sampledAtNs) - BigInt(analysis.previous.sampledAtNs);
      if (usageDelta >= 0n && timeDelta > 0n) cpuPercent = Number(usageDelta) / Number(timeDelta) * 100;
      if (usageDelta < 0n) {
        analysis.cpuHistory = [];
        analysis.memoryHistory = [];
      }
    }
    analysis.previous = sample;
    renderAnalysis(sample, cpuPercent);
  } catch (error) {
    if (state.analysis === analysis) document.getElementById('analysis-source').textContent = `Metrics unavailable: ${error.message}`;
  } finally {
    analysis.busy = false;
  }
}

function openAnalysis(unit) {
  if (remoteSelected()) return;
  const service = state.services.find((item) => item.name === unit);
  if (!service) return;
  if (ui.analysisDialog.open) ui.analysisDialog.close();
  const analysis = { unit, previous: null, cpuHistory: [], memoryHistory: [], busy: false, timer: null };
  state.analysis = analysis;
  document.getElementById('analysis-title').textContent = unit;
  document.getElementById('analysis-description').textContent = service.description || 'Live resource usage';
  for (const id of ['analysis-cpu', 'analysis-memory', 'analysis-tasks', 'analysis-peak']) document.getElementById(id).textContent = '—';
  document.getElementById('analysis-state').textContent = 'Connecting…';
  document.getElementById('analysis-updated').textContent = 'Waiting for first sample';
  document.getElementById('analysis-source').textContent = 'Reading service metrics…';
  document.getElementById('analysis-pid').textContent = 'Main PID —';
  document.getElementById('analysis-cpu-scale').textContent = 'Collecting samples';
  document.getElementById('analysis-memory-scale').textContent = 'No data';
  drawAnalysisChart('analysis-cpu-chart', [], 100);
  drawAnalysisChart('analysis-memory-chart', [], 1);
  ui.analysisDialog.showModal();
  sampleAnalysis(analysis);
  analysis.timer = setInterval(() => sampleAnalysis(analysis), 1000);
}

function renderDetails() {
  const service = state.services.find((item) => item.name === state.selected);
  ui.emptyDetail.hidden = Boolean(service);
  ui.details.hidden = !service;
  if (!service) {
    document.getElementById('logs-unit').textContent = 'Select a service';
    return;
  }
  document.getElementById('detail-name').textContent = service.name;
  document.getElementById('detail-description').textContent = service.description || 'No description';
  const favorite = state.favorites.has(favoriteKey(service.name));
  const favoriteButton = document.getElementById('favorite-toggle');
  favoriteButton.textContent = favorite ? '★' : '☆';
  favoriteButton.setAttribute('aria-label', favorite ? 'Remove from favorites' : 'Add to favorites');

  const status = document.getElementById('detail-status');
  status.textContent = statusLabel(service);
  status.className = `status-badge ${statusClass(service)}`;
  const startupButton = document.getElementById('startup-toggle');
  const isEnabled = ['enabled', 'enabled-runtime'].includes(service.startup);
  const cannotToggle = remoteSelected() || ['static', 'masked', 'masked-runtime', 'generated', 'transient'].includes(service.startup);
  startupButton.disabled = cannotToggle;
  startupButton.title = remoteSelected() ? 'Remote computers are read-only' : (service.startup === 'static' ? 'Static units cannot be enabled directly.' : (service.startup.startsWith('masked') ? 'Unmask this unit before changing its startup setting.' : ''));
  const switchNode = document.getElementById('startup-switch');
  switchNode.classList.toggle('enabled', isEnabled);
  switchNode.classList.toggle('not-toggleable', cannotToggle);
  switchNode.innerHTML = cannotToggle ? escapeHtml(startupLabel(service)) : '<i></i>';
  startupButton.disabled = cannotToggle;

  document.getElementById('detail-pid').textContent = service.pid && service.pid !== '0' ? service.pid : '—';
  document.getElementById('detail-memory').textContent = formatMemory(service.memory);
  document.getElementById('detail-file').textContent = service.file || '—';
  document.getElementById('detail-file').title = service.file || '';
  const deleteButton = document.getElementById('delete-service');
  const localUnit = service.file === `/etc/systemd/system/${service.name}`;
  deleteButton.disabled = remoteSelected() || !localUnit;
  deleteButton.title = remoteSelected() ? 'Remote computers are read-only' : (localUnit ? 'Delete this local service' : 'Package-provided services cannot be deleted here');
  document.getElementById('edit-service').disabled = false;
  document.getElementById('edit-service').title = remoteSelected() ? `Edit the unit on ${state.host}` : '';
  document.querySelector('.detail-actions [data-action="restart"]').disabled = remoteSelected();
  document.getElementById('detail-since').textContent = formatTime(service.since);
  const result = service.result && service.result !== 'success' ? `${service.result} (exit ${service.exitCode || '—'})` : (service.active === 'failed' ? 'Failed' : 'Normal');
  document.getElementById('detail-result').textContent = result;
  document.getElementById('logs-unit').textContent = service.name;
  document.querySelectorAll('.action-tile[data-action="start"]').forEach((button) => { button.disabled = remoteSelected() || service.active === 'active'; });
  document.querySelectorAll('.action-tile[data-action="stop"]').forEach((button) => { button.disabled = remoteSelected() || service.active === 'inactive'; });
}

const emptyRevision = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function openCreateUnit() {
  state.unitDraft = { mode: 'create', original: emptyRevision };
  document.getElementById('unit-dialog-title').textContent = 'Add service';
  document.getElementById('unit-dialog-description').textContent = remoteSelected() ? `Create a system service on ${state.host}.` : 'Create a system service in /etc/systemd/system.';
  document.getElementById('unit-name').value = '';
  document.getElementById('unit-name').readOnly = false;
  document.getElementById('unit-description').value = 'My service';
  document.getElementById('unit-description').placeholder = 'What does this service do?';
  document.getElementById('unit-content').value = '[Unit]\nDescription=My service\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=/usr/bin/my-command\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n';
  document.getElementById('unit-target').textContent = `${remoteSelected() ? `${state.host}: ` : ''}/etc/systemd/system/<name>.service`;
  document.getElementById('unit-help').textContent = 'Edit the template and review it before saving. Saving reloads systemd; it does not start or enable the service.';
  document.getElementById('unit-save').textContent = 'Create service';
  document.getElementById('unit-error').hidden = true;
  document.getElementById('unit-auth-field').hidden = !remoteSelected();
  document.getElementById('unit-password').value = '';
  ui.unitDialog.showModal();
  document.getElementById('unit-name').focus();
}

async function openEditUnit() {
  if (!state.selected) return;
  const button = document.getElementById('edit-service');
  button.disabled = true;
  try {
    const draft = await api.getUnitDraft(state.selected, state.host);
    state.unitDraft = draft;
    document.getElementById('unit-dialog-title').textContent = `Edit ${draft.unit}`;
    document.getElementById('unit-dialog-description').textContent = draft.mode === 'local'
      ? 'Edit this local service file. Running services need a restart to use changed settings.'
      : 'Edit a systemd override for this packaged service. The original package file stays intact.';
    document.getElementById('unit-name').value = draft.unit;
    document.getElementById('unit-name').readOnly = true;
    document.getElementById('unit-content').value = draft.content;
    document.getElementById('unit-description').value = draft.content.match(/^Description=(.*)$/m)?.[1] || '';
    document.getElementById('unit-description').placeholder = state.services.find((item) => item.name === draft.unit)?.description || 'What does this service do?';
    document.getElementById('unit-target').textContent = `${remoteSelected() ? `${state.host}: ` : ''}${draft.file}`;
    document.getElementById('unit-help').textContent = draft.mode === 'override'
      ? 'For ExecStart changes, add ExecStart= on one line before the new ExecStart= command. Saving reloads systemd but does not restart the service.'
      : 'Saving reloads systemd but does not restart this service.';
    document.getElementById('unit-save').textContent = 'Save changes';
    document.getElementById('unit-error').hidden = true;
    document.getElementById('unit-auth-field').hidden = !remoteSelected();
    document.getElementById('unit-password').value = '';
    ui.unitDialog.showModal();
    document.getElementById('unit-content').focus();
  } catch (error) { showToast(error.message, 'error'); }
  finally { button.disabled = false; }
}

async function saveUnit(event) {
  event.preventDefault();
  const unit = document.getElementById('unit-name').value.trim();
  const content = document.getElementById('unit-content').value;
  const errorNode = document.getElementById('unit-error');
  if (!/^[A-Za-z0-9_.:@-]+\.service$/.test(unit) || unit.includes('..')) {
    errorNode.textContent = 'Enter a valid name ending in .service.';
    errorNode.hidden = false;
    return;
  }
  const saveButton = document.getElementById('unit-save');
  saveButton.disabled = true;
  saveButton.textContent = 'Saving…';
  errorNode.hidden = true;
  try {
    await api.saveUnitDraft({ ...state.unitDraft, unit, content }, state.host, document.getElementById('unit-password').value);
    document.getElementById('unit-password').value = '';
    ui.unitDialog.close();
    state.selected = unit;
    state.view = 'all';
    state.search = '';
    ui.search.value = '';
    document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('selected', item.dataset.view === 'all'));
    document.getElementById('view-heading').textContent = views.all[0];
    document.getElementById('view-description').textContent = views.all[1];
    await refreshServices();
    showToast(`${unit} saved. Restart the service if it is already running.`, 'success');
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = state.unitDraft?.mode === 'create' ? 'Create service' : 'Save changes';
  }
}

function renderCounts() {
  document.getElementById('all-count').textContent = state.services.length;
  document.getElementById('favorites-count').textContent = state.services.filter((item) => state.favorites.has(favoriteKey(item.name))).length;
  document.getElementById('running-count').textContent = state.services.filter((item) => item.active === 'active').length;
  document.getElementById('stopped-count').textContent = state.services.filter((item) => item.active === 'inactive').length;
  document.getElementById('failed-count').textContent = state.services.filter((item) => item.active === 'failed').length;
}

function setView(view) {
  if (!views[view]) return;
  state.view = view;
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('selected', item.dataset.view === view));
  document.getElementById('view-heading').textContent = views[view][0];
  document.getElementById('view-description').textContent = remoteSelected() ? `Viewing ${state.host} · unit editing available` : views[view][1];
  renderList();
}

async function refreshServices(silent = false) {
  if (state.refreshing) return;
  const target = state.host;
  const epoch = state.hostEpoch;
  state.refreshing = true;
  if (!silent) {
    document.getElementById('system-state').textContent = 'Refreshing';
    document.getElementById('refresh-button').classList.add('spinning');
  }
  try {
    const services = await api.listServices(target);
    if (epoch !== state.hostEpoch) return;
    state.services = services;
    document.getElementById('system-state').textContent = target === 'local' ? 'System services' : target;
    document.querySelector('.system-indicator').classList.remove('offline');
    document.getElementById('refresh-status').textContent = `${state.services.length} services · updated ${new Date().toLocaleTimeString('en-US')}`;
    renderCounts();
    renderList();
  } catch (error) {
    if (epoch !== state.hostEpoch) return;
    document.getElementById('system-state').textContent = 'Connection error';
    document.querySelector('.system-indicator').classList.add('offline');
    document.getElementById('refresh-status').textContent = error.message;
    if (!silent) showToast(error.message, 'error');
  } finally {
    if (epoch === state.hostEpoch) {
      state.refreshing = false;
      document.getElementById('service-list').setAttribute('aria-busy', 'false');
      document.getElementById('refresh-button').classList.remove('spinning');
    }
  }
}

async function persistSettings() {
  try {
    await api.saveSettings({ favorites: [...state.favorites], hosts: state.hosts, selectedHost: state.host, theme: state.theme, sidebarCollapsed: state.sidebarCollapsed, detailsCollapsed: state.detailsCollapsed });
  } catch (error) {
    showToast(`Could not save preferences: ${error.message}`, 'error');
  }
}

function renderPanelVisibility() {
  document.body.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
  document.body.classList.toggle('details-collapsed', state.detailsCollapsed);
  const sidebarButton = document.getElementById('toggle-sidebar');
  sidebarButton.setAttribute('aria-expanded', String(!state.sidebarCollapsed));
  sidebarButton.setAttribute('aria-label', state.sidebarCollapsed ? 'Show navigation' : 'Hide navigation');
  sidebarButton.title = state.sidebarCollapsed ? 'Show navigation' : 'Hide navigation';
  const detailButton = document.getElementById('toggle-details');
  detailButton.setAttribute('aria-expanded', String(!state.detailsCollapsed));
  detailButton.textContent = state.detailsCollapsed ? 'Show details' : 'Hide details';
}

function showConfirmation(title, message, action, unit) {
  state.actionPending = { action, unit };
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  const accept = document.getElementById('confirm-accept');
  accept.textContent = action === 'delete' ? 'Delete service' : 'Confirm';
  accept.classList.toggle('button-danger', action === 'delete');
  ui.dialog.showModal();
}

async function performAction(action, unit) {
  if (remoteSelected()) return;
  const actionNames = { start: 'start', stop: 'stop', restart: 'restart', enable: 'enable at boot', disable: 'disable at boot' };
  try {
    document.getElementById('refresh-status').textContent = `${unit}: performing ${actionNames[action]}… Polkit may request authorization.`;
    await api.serviceAction(action, unit, state.host);
    showToast(`${unit}: ${actionNames[action]} completed.`, 'success');
    await refreshServices(true);
  } catch (error) {
    if (/dismiss|cancel|not authorized/i.test(error.message)) showToast('Action cancelled.', 'info');
    else showToast(error.message, 'error');
  }
}

async function performDelete(unit) {
  if (remoteSelected()) return;
  try {
    document.getElementById('refresh-status').textContent = `${unit}: deleting… Polkit may request authorization.`;
    await api.deleteService(unit, state.host);
    if (state.logLive) await stopLiveLogs();
    state.favorites.delete(unit);
    await persistSettings();
    state.selected = null;
    state.logLines = [];
    renderLogs();
    await refreshServices();
    showToast(`${unit} deleted.`, 'success');
  } catch (error) {
    if (/dismiss|cancel|not authorized/i.test(error.message)) showToast('Deletion cancelled.', 'info');
    else showToast(error.message, 'error');
  }
}

function toggleFavorite(unit) {
  const key = favoriteKey(unit);
  if (state.favorites.has(key)) state.favorites.delete(key);
  else state.favorites.add(key);
  persistSettings();
  renderCounts();
  renderList();
}

function parseJournalLine(raw) {
  try {
    const item = JSON.parse(raw);
    const micros = Number(item.__REALTIME_TIMESTAMP);
    const date = Number.isFinite(micros) ? new Date(micros / 1000) : null;
    const priority = Number(item.PRIORITY);
    const level = priority <= 3 ? 'error' : (priority === 4 ? 'warn' : 'info');
    const clock = date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString('en-US', { hour12: false }) : '';
    const process = item.SYSLOG_IDENTIFIER || item._COMM || item._SYSTEMD_UNIT || '';
    return { time: clock, level, process, message: String(item.MESSAGE || '') };
  } catch {
    const lower = raw.toLowerCase();
    const level = lower.includes('error') || lower.includes('[err') ? 'error' : (lower.includes('warn') ? 'warn' : 'info');
    return { time: '', level, process: '', message: raw };
  }
}

function renderLogLine(raw, index) {
  const line = parseJournalLine(raw);
  const query = document.getElementById('log-search').value.trim().toLocaleLowerCase('en');
  const severity = document.getElementById('severity-filter').value;
  const text = `${line.time} ${line.process} ${line.message}`.toLocaleLowerCase('en');
  if (query && !text.includes(query)) return '';
  if (severity !== 'all' && line.level !== severity) return '';
  return `<div class="log-line"><span class="log-time">${escapeHtml(line.time || String(index + 1).padStart(2, '0'))}</span>  <span class="log-${line.level}">[${line.level.toUpperCase()}]</span>  <span class="log-process">${escapeHtml(line.process)}</span><span class="log-message">${line.process ? ': ' : ''}${escapeHtml(line.message)}</span></div>`;
}

function renderLogs() {
  if (state.logPaused) return;
  const markup = state.logLines.map(renderLogLine).filter(Boolean).join('');
  const emptyText = !state.selected
    ? 'Select a service to view logs.'
    : (state.logLines.length ? 'No log entries match this search.' : 'Click Live or select a time range to load logs.');
  ui.logs.innerHTML = markup || `<div class="log-empty">${emptyText}</div>`;
  ui.logs.scrollTop = ui.logs.scrollHeight;
  ui.lineCount.textContent = `${state.logLines.length} lines`;
}

async function stopLiveLogs() {
  try { await api.stopLogs(); } catch { /* process may already have ended */ }
  state.logLive = false;
  document.getElementById('live-button').classList.remove('is-live');
  document.getElementById('live-button').innerHTML = '<i></i><span>Live</span>';
  document.getElementById('pause-button').disabled = true;
}

async function startLiveLogs() {
  if (!state.selected) return;
  await stopLiveLogs();
  state.logLines = [];
  state.logPaused = false;
  document.getElementById('pause-button').textContent = 'Ⅱ  Pause';
  renderLogs();
  try {
    await api.startLogs(state.selected, 500, state.host);
    state.logLive = true;
    document.getElementById('live-button').classList.add('is-live');
    document.getElementById('live-button').innerHTML = '<i></i><span>Live</span>';
    document.getElementById('pause-button').disabled = false;
    document.getElementById('logs-status').textContent = `Live logs for ${state.selected} · ${remoteSelected() ? 'SSH' : 'Polkit may request authorization'}`;
  } catch (error) {
    document.getElementById('logs-status').textContent = error.message;
    showToast(error.message, 'error');
  }
}

async function loadHistory(range) {
  if (!state.selected || range === 'live') return;
  const selectedUnit = state.selected;
  await stopLiveLogs();
  state.logLines = [];
  ui.logs.innerHTML = '<div class="log-empty">Loading log history…</div>';
  document.getElementById('logs-status').textContent = `Loading history for ${state.selected}…`;
  try {
    const target = state.host;
    const output = await api.readHistory(selectedUnit, range, 500, target);
    if (state.selected !== selectedUnit || state.host !== target) return;
    state.logLines = output.split(/\r?\n/).filter(Boolean);
    renderLogs();
    document.getElementById('logs-status').textContent = `Log history for ${state.selected}`;
  } catch (error) {
    document.getElementById('logs-status').textContent = error.message;
    showToast(error.message, 'error');
  }
}

function updateSelected(unit) {
  if (unit === state.selected) return;
  state.selected = unit;
  renderList();
  if (state.logLive) stopLiveLogs();
  state.logLines = [];
  state.logPaused = false;
  document.getElementById('pause-button').textContent = 'Ⅱ  Pause';
  renderLogs();
  document.getElementById('history-range').value = 'live';
  document.getElementById('logs-status').textContent = unit ? 'Click Live to start streaming logs' : 'Waiting for logs';
}

async function initialize() {
  const settings = await api.loadSettings();
  state.favorites = new Set(settings.favorites || []);
  state.hosts = settings.hosts || [];
  state.host = state.hosts.includes(settings.selectedHost) ? settings.selectedHost : 'local';
  state.theme = settings.theme === 'light' ? 'light' : 'dark';
  state.sidebarCollapsed = settings.sidebarCollapsed === true;
  state.detailsCollapsed = settings.detailsCollapsed === true;
  document.body.dataset.theme = state.theme;
  renderPanelVisibility();
  renderHosts();
  document.getElementById('view-description').textContent = remoteSelected() ? `Viewing ${state.host} · unit editing available` : views[state.view][1];
  await refreshServices();
  setInterval(() => refreshServices(true), 5000);
}

document.querySelector('.view-nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (button) setView(button.dataset.view);
});

ui.hostSelect.addEventListener('change', (event) => selectHost(event.target.value));
let pendingHostSetup = null;
function resetHostSetup() {
  pendingHostSetup = null;
  document.getElementById('host-setup').hidden = true;
  document.getElementById('host-address').readOnly = false;
  document.getElementById('host-password').value = '';
  document.getElementById('host-trust').checked = false;
  document.getElementById('host-error').hidden = true;
  document.getElementById('host-save').textContent = 'Connect';
}
document.getElementById('add-host').addEventListener('click', () => {
  resetHostSetup();
  document.getElementById('host-address').value = '';
  ui.hostDialog.showModal();
  document.getElementById('host-address').focus();
});
ui.hostDialog.addEventListener('close', resetHostSetup);
document.getElementById('host-cancel').addEventListener('click', () => ui.hostDialog.close());
document.getElementById('host-cancel-top').addEventListener('click', () => ui.hostDialog.close());
document.getElementById('host-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const host = document.getElementById('host-address').value.trim();
  const errorNode = document.getElementById('host-error');
  const saveButton = document.getElementById('host-save');
  errorNode.hidden = true;
  saveButton.disabled = true;
  saveButton.textContent = pendingHostSetup ? 'Installing key…' : 'Checking…';
  try {
    if (!pendingHostSetup) {
      const result = await api.inspectHost(host);
      if (!result.ready) {
        pendingHostSetup = result;
        document.getElementById('host-address').readOnly = true;
        document.getElementById('host-key-type').textContent = result.keyType;
        document.getElementById('host-fingerprint').textContent = result.fingerprint;
        document.getElementById('host-trust-label').textContent = result.alreadyTrusted ? 'TRUSTED SSH HOST KEY' : 'NEW SSH HOST KEY';
        document.getElementById('host-trust-field').hidden = result.alreadyTrusted;
        document.getElementById('host-setup').hidden = false;
        document.getElementById('host-password').focus();
        return;
      }
    } else {
      if (!pendingHostSetup.alreadyTrusted && !document.getElementById('host-trust').checked) throw new Error('Verify the host fingerprint and check the confirmation box before continuing.');
      await api.setupHost(pendingHostSetup.token, document.getElementById('host-password').value);
    }
    if (!state.hosts.includes(host)) state.hosts.push(host);
    ui.hostDialog.close();
    await selectHost(host);
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = pendingHostSetup ? 'Trust and install key' : 'Connect';
  }
});
document.getElementById('remove-host').addEventListener('click', async () => {
  if (!remoteSelected()) return;
  const host = state.host;
  state.hosts = state.hosts.filter((item) => item !== host);
  for (const key of [...state.favorites]) if (key.startsWith(`${host}/`)) state.favorites.delete(key);
  await selectHost('local');
  showToast(`${host} removed from Tudun.`, 'info');
});

document.getElementById('toggle-sidebar').addEventListener('click', () => {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  renderPanelVisibility();
  persistSettings();
});
document.getElementById('toggle-details').addEventListener('click', () => {
  state.detailsCollapsed = !state.detailsCollapsed;
  renderPanelVisibility();
  persistSettings();
});
document.getElementById('close-details').addEventListener('click', () => {
  state.detailsCollapsed = true;
  renderPanelVisibility();
  persistSettings();
});

document.querySelector('.table-head').addEventListener('click', (event) => {
  const button = event.target.closest('[data-sort]');
  if (!button) return;
  const column = button.dataset.sort;
  state.sortDirection = state.sort === column ? state.sortDirection * -1 : 1;
  state.sort = column;
  renderList();
});

ui.list.addEventListener('click', (event) => {
  const analyze = event.target.closest('[data-analyze]');
  if (analyze) {
    updateSelected(analyze.dataset.analyze);
    openAnalysis(analyze.dataset.analyze);
    return;
  }
  const clear = event.target.closest('[data-clear-filter]');
  if (clear) {
    if (clear.dataset.clearFilter === 'search') {
      ui.search.value = '';
      state.search = '';
      ui.search.focus();
      renderList();
    } else setView('all');
    return;
  }
  const favorite = event.target.closest('[data-favorite]');
  if (favorite) {
    event.stopPropagation();
    toggleFavorite(favorite.dataset.favorite);
    return;
  }
  const row = event.target.closest('[data-unit]');
  if (row) updateSelected(row.dataset.unit);
});

ui.list.addEventListener('dblclick', (event) => {
  if (event.target.closest('[data-analyze]')) return;
  const row = event.target.closest('[data-unit]');
  if (row) {
    updateSelected(row.dataset.unit);
    startLiveLogs();
  }
});

document.getElementById('service-search').addEventListener('input', (event) => {
  state.search = event.target.value;
  renderList();
});

document.getElementById('refresh-button').addEventListener('click', () => refreshServices());
document.getElementById('add-service').addEventListener('click', openCreateUnit);
document.getElementById('edit-service').addEventListener('click', openEditUnit);
document.getElementById('delete-service').addEventListener('click', () => {
  if (remoteSelected()) return;
  const service = state.services.find((item) => item.name === state.selected);
  if (!service || service.file !== `/etc/systemd/system/${service.name}`) return;
  showConfirmation('Delete service', `Delete ${service.name}? Tudun will stop it, disable startup, remove its local unit file, and reload systemd. This cannot be undone.`, 'delete', service.name);
});
document.getElementById('unit-form').addEventListener('submit', saveUnit);
document.getElementById('unit-description').addEventListener('input', (event) => {
  const editor = document.getElementById('unit-content');
  const description = event.target.value.replace(/[\r\n]/g, ' ').trim();
  if (/^Description=.*$/m.test(editor.value)) {
    editor.value = editor.value.replace(/^Description=.*$/m, `Description=${description}`);
  } else if (description) {
    if (/^\[Unit\]\s*$/m.test(editor.value)) editor.value = editor.value.replace(/^(\[Unit\]\s*)$/m, `$1\nDescription=${description}`);
    else editor.value = `[Unit]\nDescription=${description}\n\n${editor.value}`;
  }
});
document.getElementById('unit-content').addEventListener('input', (event) => {
  document.getElementById('unit-description').value = event.target.value.match(/^Description=(.*)$/m)?.[1] || '';
});
document.getElementById('unit-cancel').addEventListener('click', () => ui.unitDialog.close());
document.getElementById('unit-cancel-top').addEventListener('click', () => ui.unitDialog.close());
ui.unitDialog.addEventListener('close', () => { document.getElementById('unit-password').value = ''; });
document.getElementById('analysis-close').addEventListener('click', () => ui.analysisDialog.close());
ui.analysisDialog.addEventListener('close', () => {
  if (state.analysis) clearInterval(state.analysis.timer);
  state.analysis = null;
});
document.getElementById('theme-button').addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.body.dataset.theme = state.theme;
  persistSettings();
});
document.getElementById('favorite-toggle').addEventListener('click', () => toggleFavorite(state.selected));
document.getElementById('startup-toggle').addEventListener('click', () => {
  if (remoteSelected()) return;
  const service = state.services.find((item) => item.name === state.selected);
  if (!service || ['static', 'masked', 'masked-runtime', 'generated', 'transient'].includes(service.startup)) return;
  const action = ['enabled', 'enabled-runtime'].includes(service.startup) ? 'disable' : 'enable';
  const verb = action === 'enable' ? 'enable startup' : 'disable startup';
  showConfirmation('Startup setting', `Do you want to ${verb} for ${service.name}? This does not start or stop the service now.`, action, service.name);
});

document.querySelector('.detail-actions').addEventListener('click', (event) => {
  if (remoteSelected()) return;
  const button = event.target.closest('[data-action]');
  if (!button || !state.selected) return;
  const action = button.dataset.action;
  const verb = { start: 'start', stop: 'stop', restart: 'restart' }[action];
  showConfirmation('Service action', `Do you want to ${verb} ${state.selected}?`, action, state.selected);
});

document.getElementById('open-live-logs').addEventListener('click', startLiveLogs);
document.getElementById('live-button').addEventListener('click', () => {
  if (state.logLive) stopLiveLogs();
  else if (document.getElementById('history-range').value === 'live') startLiveLogs();
  else loadHistory(document.getElementById('history-range').value);
});
document.getElementById('history-range').addEventListener('change', (event) => {
  if (event.target.value !== 'live') loadHistory(event.target.value);
  else if (!state.logLive) document.getElementById('logs-status').textContent = 'Click Live to start streaming logs';
});
document.getElementById('pause-button').addEventListener('click', (event) => {
  state.logPaused = !state.logPaused;
  event.currentTarget.textContent = state.logPaused ? '▶  Resume' : 'Ⅱ  Pause';
  if (!state.logPaused) renderLogs();
});
document.getElementById('clear-logs-button').addEventListener('click', () => {
  state.logLines = [];
  renderLogs();
});
document.getElementById('log-search').addEventListener('input', renderLogs);
document.getElementById('severity-filter').addEventListener('change', renderLogs);
document.getElementById('export-logs-button').addEventListener('click', async () => {
  const text = state.logLines.map((line, index) => {
    const item = parseJournalLine(line);
    return `${item.time} [${item.level.toUpperCase()}] ${item.process}${item.process ? ': ' : ''}${item.message}`;
  }).join('\n');
  if (!text) return showToast('There are no logs to export.');
  try {
    const saved = await api.exportLogs(text);
    if (saved) showToast('Logs exported.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

document.getElementById('confirm-cancel').addEventListener('click', () => ui.dialog.close());
document.getElementById('confirm-accept').addEventListener('click', async () => {
  const pending = state.actionPending;
  ui.dialog.close();
  state.actionPending = null;
  if (pending?.action === 'delete') await performDelete(pending.unit);
  else if (pending) await performAction(pending.action, pending.unit);
});
ui.dialog.addEventListener('click', (event) => { if (event.target === ui.dialog) ui.dialog.close(); });

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    ui.search.focus();
    ui.search.select();
  }
});

api.onLogLine((line) => {
  if (!state.logLive) return;
  state.logLines.push(line);
  if (state.logLines.length > 20000) state.logLines.splice(0, 1000);
  if (!state.logPaused) renderLogs();
});
api.onLogsEnded(() => {
  if (!state.logLive) return;
  state.logLive = false;
  document.getElementById('live-button').classList.remove('is-live');
  document.getElementById('pause-button').disabled = true;
  document.getElementById('logs-status').textContent = 'Live log stream ended';
});

initialize().catch((error) => {
  document.getElementById('refresh-status').textContent = error.message;
  showToast(error.message, 'error');
});
