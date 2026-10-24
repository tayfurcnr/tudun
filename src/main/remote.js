const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const { WRITE_UNIT_SCRIPT } = require('./systemd');

const execFileAsync = promisify(execFile);
const HOST_PATTERN = /^[a-z_][a-z0-9_-]*@[a-z0-9][a-z0-9.-]*$/i;
const UNIT_PATTERN = /^[A-Za-z0-9_.:@-]+\.service$/;
const PROPERTIES = 'Id,Description,LoadState,ActiveState,SubState,UnitFileState,MainPID,ActiveEnterTimestamp,MemoryCurrent,FragmentPath,Result,ExecMainStatus';
const SSH_OPTIONS = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=1'];
const knownUnits = new Map();
let logProcess = null;

function validateHost(host) {
  if (typeof host !== 'string' || host.length > 160 || !HOST_PATTERN.test(host) || host.includes('..')) {
    throw new Error('Use an SSH destination such as user@192.168.1.20.');
  }
  return host;
}

function assertUnit(host, unit) {
  validateHost(host);
  if (typeof unit !== 'string' || unit.length > 200 || !UNIT_PATTERN.test(unit) || unit.includes('..') || !knownUnits.get(host)?.has(unit)) {
    throw new Error('Service is not in the selected remote host list. Refresh the list.');
  }
}

async function run(host, command, timeout = 30000) {
  validateHost(host);
  try {
    const { stdout } = await execFileAsync('ssh', [...SSH_OPTIONS, host, command], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout
    });
    return stdout;
  } catch (error) {
    throw new Error(String(error.stderr || error.message || 'SSH command failed.').trim());
  }
}

function parseProperties(output) {
  const entries = new Map();
  for (const block of output.trim().split(/\n\s*\n/)) {
    const item = {};
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf('=');
      if (separator > 0) item[line.slice(0, separator)] = line.slice(separator + 1);
    }
    if (item.Id) entries.set(item.Id, item);
  }
  return entries;
}

async function checkHost(host) {
  await run(host, 'systemctl --version', 15000);
  return true;
}

async function listServices(host) {
  validateHost(host);
  const output = await run(host, 'systemctl list-unit-files --type=service --no-legend --no-pager');
  const units = [];
  const fileStates = new Map();
  for (const line of output.split(/\r?\n/)) {
    const [name, state] = line.trim().split(/\s+/, 3);
    if (!name?.endsWith('.service') || !state || name.includes('@.') || state === 'alias' || !UNIT_PATTERN.test(name) || name.includes('..')) continue;
    if (!fileStates.has(name)) {
      units.push(name);
      fileStates.set(name, state);
    }
  }
  const services = [];
  for (let offset = 0; offset < units.length; offset += 100) {
    const batch = units.slice(offset, offset + 100);
    const properties = parseProperties(await run(host, `systemctl show --no-pager --property=${PROPERTIES} -- ${batch.join(' ')}`));
    for (const name of batch) {
      const item = properties.get(name) || {};
      services.push({
        name, description: item.Description || '', load: item.LoadState || 'not-found',
        active: item.ActiveState || 'unknown', sub: item.SubState || 'unknown',
        startup: item.UnitFileState || fileStates.get(name), pid: item.MainPID || '0',
        since: item.ActiveEnterTimestamp || '', memory: item.MemoryCurrent || '',
        file: item.FragmentPath || '', result: item.Result || '', exitCode: item.ExecMainStatus || ''
      });
    }
  }
  knownUnits.set(host, new Set(services.map((service) => service.name)));
  return services;
}

async function readHistory(host, unit, range, limit = 500) {
  assertUnit(host, unit);
  const since = { hour: '1 hour ago', day: '24 hours ago', week: '7 days ago' }[range];
  if (!since) throw new Error('Invalid log time range.');
  const lines = Math.max(1, Math.min(Number(limit) || 500, 2000));
  return run(host, `journalctl --no-pager --lines=${lines} --since='${since}' --output=json --unit=${unit}`, 60000);
}

const digest = (content) => crypto.createHash('sha256').update(content).digest('hex');
const emptyRevision = digest('');

async function getUnitDraft(host, unit) {
  assertUnit(host, unit);
  const fragment = (await run(host, `systemctl show --property=FragmentPath --value -- ${unit}`)).trim();
  const local = fragment === `/etc/systemd/system/${unit}`;
  const mode = local ? 'local' : 'override';
  const file = local ? fragment : `/etc/systemd/system/${unit}.d/override.conf`;
  const content = await run(host, `if [ -f ${file} ]; then cat ${file}; fi`);
  if (Buffer.byteLength(content) > 65536) throw new Error('Unit file is too large to edit here.');
  return {
    unit, mode, file, original: digest(content),
    content: content || (local ? '' : '[Service]\n# Add or replace service settings here.\n# To replace ExecStart, clear it first with ExecStart=\n')
  };
}

const WRITE_WRAPPER = `import sys\nwhile True:\n    line = sys.stdin.readline()\n    if not line: sys.exit('Missing draft input')\n    if line == 'TUDUN-DRAFT\\n': break\n` + WRITE_UNIT_SCRIPT;
const WRITE_COMMAND = `sudo -S -p '' /usr/bin/python3 -c 'import base64;exec(base64.b64decode("${Buffer.from(WRITE_WRAPPER).toString('base64')}"))'`;

async function saveUnitDraft(host, draft, password) {
  validateHost(host);
  const { unit, mode, content, original } = draft || {};
  if (typeof unit !== 'string' || unit.length > 200 || !UNIT_PATTERN.test(unit) || unit.includes('..') ||
      !['create', 'local', 'override'].includes(mode) || typeof content !== 'string' ||
      Buffer.byteLength(content) > 65536 || content.includes('\0') || typeof password !== 'string' || password.length > 1024 || password.includes('\n') || password.includes('\r')) {
    throw new Error('Invalid unit draft or administrator password.');
  }
  if (mode === 'create') {
    if (knownUnits.get(host)?.has(unit) || original !== emptyRevision) throw new Error('Service already exists or draft is stale.');
  } else {
    assertUnit(host, unit);
    const current = await getUnitDraft(host, unit);
    if (current.mode !== mode || current.original !== original) throw new Error('Unit changed since opening it; reopen the editor.');
  }
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...SSH_OPTIONS, host, WRITE_COMMAND], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk.slice(0, 8192); });
    child.stderr.on('data', (chunk) => { stderr += chunk.slice(0, 8192); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ unit, mode });
      else reject(new Error(stderr.trim() || stdout.trim() || 'Could not save the remote service.'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(`${password}\nTUDUN-DRAFT\n${JSON.stringify({ unit, mode, content, original })}`);
  });
}

function stopLogs() {
  if (logProcess && !logProcess.killed) logProcess.kill('SIGTERM');
  logProcess = null;
}

function startLogs(host, unit, sender, limit = 500) {
  assertUnit(host, unit);
  stopLogs();
  const lines = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const child = spawn('ssh', [...SSH_OPTIONS, host,
    `journalctl --follow --lines=${lines} --no-pager --output=json --unit=${unit}`
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  logProcess = child;
  let remainder = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    remainder += chunk;
    const entries = remainder.split(/\r?\n/);
    remainder = entries.pop() || '';
    for (const entry of entries) if (!sender.isDestroyed()) sender.send('logs:line', entry);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (!sender.isDestroyed()) sender.send('logs:line', `Remote log error: ${chunk.trim()}`);
  });
  child.on('error', (error) => {
    if (!sender.isDestroyed()) sender.send('logs:line', `SSH error: ${error.message}`);
  });
  child.on('close', (code) => {
    if (remainder && !sender.isDestroyed()) sender.send('logs:line', remainder);
    if (!sender.isDestroyed()) sender.send('logs:ended', code);
    if (logProcess === child) logProcess = null;
  });
}

module.exports = { validateHost, checkHost, listServices, getUnitDraft, saveUnitDraft, readHistory, startLogs, stopLogs };
