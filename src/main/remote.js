const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('ssh2');
const { WRITE_UNIT_SCRIPT, DELETE_UNIT_SCRIPT } = require('./systemd');

const execFileAsync = promisify(execFile);
const HOST_PATTERN = /^[a-z_][a-z0-9_-]*@[a-z0-9][a-z0-9.-]*$/i;
const UNIT_PATTERN = /^[A-Za-z0-9_.:@-]+\.service$/;
const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart', 'enable', 'disable']);
const PROPERTIES = 'Id,Description,LoadState,ActiveState,SubState,UnitFileState,MainPID,ActiveEnterTimestamp,MemoryCurrent,FragmentPath,Result,ExecMainStatus';
const SSH_KEY = path.join(os.homedir(), '.ssh', 'tudun_ed25519');
const KNOWN_HOSTS = path.join(os.homedir(), '.ssh', 'known_hosts');
const SSH_OPTIONS = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`, '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=1', '-i', SSH_KEY];
const knownUnits = new Map();
const pendingHosts = new Map();
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

function fingerprint(key) {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

async function inspectHost(host) {
  validateHost(host);
  for (const [token, pending] of pendingHosts) if (pending.expires < Date.now()) pendingHosts.delete(token);
  try {
    await checkHost(host);
    return { ready: true, host };
  } catch { /* Password setup or first-time trust may be needed. */ }
  const address = host.split('@')[1];
  let scan;
  try {
    scan = (await execFileAsync('ssh-keyscan', ['-T', '8', '-t', 'ed25519,ecdsa,rsa', address], {
      encoding: 'utf8', timeout: 12000, maxBuffer: 65536
    })).stdout;
  } catch (error) {
    throw new Error(`Could not read the SSH host key from ${address}: ${String(error.stderr || error.message).trim()}`);
  }
  const keys = scan.split(/\r?\n/).filter((line) => !line.startsWith('#')).map((line) => {
    const [name, type, encoded] = line.trim().split(/\s+/, 3);
    if (name !== address || !/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa)$/.test(type || '') || !/^[A-Za-z0-9+/]+=*$/.test(encoded || '')) return null;
    const raw = Buffer.from(encoded, 'base64');
    return raw.length >= 32 && raw.length <= 8192 ? { line: `${address} ${type} ${encoded}`, type, encoded, raw } : null;
  }).filter(Boolean);
  if (!keys.length) throw new Error('The computer did not provide a supported SSH host key. Check its address and SSH server.');
  let saved = '';
  try {
    await fs.access(KNOWN_HOSTS);
    try { saved = (await execFileAsync('ssh-keygen', ['-F', address, '-f', KNOWN_HOSTS], { encoding: 'utf8', timeout: 5000 })).stdout; }
    catch (error) { if (error.code !== 1) throw new Error(`Could not read trusted SSH hosts: ${error.message}`); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const trusted = saved.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => line.trim().split(/\s+/));
  const selected = trusted.length
    ? keys.find((key) => trusted.some(([, type, encoded]) => type === key.type && encoded === key.encoded))
    : keys.find((key) => key.type === 'ssh-ed25519') || keys[0];
  if (!selected) throw new Error('The SSH host key differs from the key already trusted on this computer. Check the remote computer before reconnecting.');
  const token = crypto.randomBytes(24).toString('hex');
  pendingHosts.set(token, { host, key: selected, alreadyTrusted: trusted.length > 0, expires: Date.now() + 180000 });
  return { ready: false, host, token, fingerprint: fingerprint(selected.raw), keyType: selected.type, alreadyTrusted: trusted.length > 0 };
}

async function ensureAppKey() {
  const directory = path.dirname(SSH_KEY);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const publicKey = (await fs.readFile(`${SSH_KEY}.pub`, 'utf8')).trim();
    await fs.access(SSH_KEY);
    if (/^ssh-ed25519 [A-Za-z0-9+/]+=*(?: .*)?$/.test(publicKey)) return publicKey;
    throw new Error('Tudun SSH public key is invalid.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try { await fs.access(SSH_KEY); throw new Error('Tudun SSH private key exists without its public key. Restore the public key before continuing.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', SSH_KEY, '-C', 'tudun'], { timeout: 15000 });
  return (await fs.readFile(`${SSH_KEY}.pub`, 'utf8')).trim();
}

function installPublicKey(host, pinnedKey, password, publicKey) {
  const [username, address] = host.split('@');
  const algorithms = pinnedKey.type === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [pinnedKey.type];
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+=* tudun$/.test(publicKey)) throw new Error('Invalid Tudun SSH public key.');
  const command = `umask 077; key='${publicKey}'; mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" && touch "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys" && { grep -qxF "$key" "$HOME/.ssh/authorized_keys" || printf "%s\\n" "$key" >> "$HOME/.ssh/authorized_keys"; }`;
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const timer = setTimeout(() => finish(new Error('SSH key setup timed out.')), 30000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      if (error) reject(error); else resolve();
    };
    client.on('keyboard-interactive', (_name, _instructions, _language, prompts, respond) => {
      respond(prompts.map((prompt) => prompt.echo ? '' : password));
    });
    client.on('ready', () => client.exec(command, (error, stream) => {
      if (error) return finish(error);
      let stderr = '';
      stream.stderr.on('data', (chunk) => { stderr += chunk.toString().slice(0, 2048); });
      stream.on('exit', (code) => finish(code === 0 ? null : new Error(stderr.trim() || 'Could not install the SSH key on the remote computer.')));
      stream.on('close', (code) => finish(code === 0 ? null : new Error(stderr.trim() || 'Could not install the SSH key on the remote computer.')));
      stream.end();
    }));
    client.on('error', (error) => finish(new Error(error.level === 'client-authentication' ? 'SSH password was rejected or password login is disabled on the remote computer.' : error.message)));
    client.connect({ host: address, port: 22, username, password, tryKeyboard: true, readyTimeout: 15000,
      algorithms: { serverHostKey: algorithms },
      hostVerifier: (key) => Buffer.isBuffer(key) && key.length === pinnedKey.raw.length && crypto.timingSafeEqual(key, pinnedKey.raw)
    });
  });
}

async function setupHost(token, password) {
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token) || typeof password !== 'string' || !password || password.length > 1024) throw new Error('Invalid connection setup request.');
  const pending = pendingHosts.get(token);
  if (!pending || pending.expires < Date.now()) throw new Error('Connection check expired. Check the address again.');
  const publicKey = await ensureAppKey();
  await installPublicKey(pending.host, pending.key, password, publicKey);
  if (!pending.alreadyTrusted) {
    await fs.mkdir(path.dirname(KNOWN_HOSTS), { recursive: true, mode: 0o700 });
    await fs.appendFile(KNOWN_HOSTS, `\n${pending.key.line}\n`, { mode: 0o600 });
  }
  pendingHosts.delete(token);
  await checkHost(pending.host);
  return { host: pending.host };
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

const METRICS_SCRIPT = String.raw`
import json, os, re, subprocess, sys, time
unit = sys.argv[1]
if not re.fullmatch(r'[A-Za-z0-9_.:@-]+\.service', unit) or len(unit) > 200 or '..' in unit:
    sys.exit('Invalid service name')
properties = 'Id,ActiveState,MainPID,ControlGroup,CPUUsageNSec,MemoryCurrent,MemoryPeak,TasksCurrent,ActiveEnterTimestamp'
result = subprocess.run(['systemctl', 'show', '--no-pager', '--property=' + properties, '--', unit], capture_output=True, text=True, timeout=15)
if result.returncode:
    sys.exit(result.stderr.strip() or 'Could not read service metrics')
item = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
def number(value):
    return int(value) if value and value.isdecimal() else None
metrics = {
    'unit': unit, 'active': item.get('ActiveState') or 'unknown',
    'pid': number(item.get('MainPID')), 'cpuUsageNs': item.get('CPUUsageNSec') if (item.get('CPUUsageNSec') or '').isdecimal() else None,
    'memoryBytes': number(item.get('MemoryCurrent')), 'peakBytes': number(item.get('MemoryPeak')),
    'tasks': number(item.get('TasksCurrent')), 'source': 'systemd',
    'since': item.get('ActiveEnterTimestamp') or '', 'sampledAtNs': str(time.monotonic_ns())
}
group = item.get('ControlGroup') or ''
if group.startswith('/') and group != '/' and '..' not in group.split('/'):
    base = '/sys/fs/cgroup'
    directory = os.path.realpath(os.path.join(base, group.lstrip('/')))
    if directory.startswith(base + '/'):
        def read(name):
            try:
                with open(os.path.join(directory, name), encoding='utf-8') as stream:
                    return stream.read(8192).strip()
            except (OSError, UnicodeError):
                return None
        cpu_stat = read('cpu.stat')
        if cpu_stat:
            match = re.search(r'^usage_usec\s+(\d+)$', cpu_stat, re.M)
            if match:
                metrics['cpuUsageNs'] = str(int(match.group(1)) * 1000)
                metrics['source'] = 'cgroup v2'
        for field, name in [('memoryBytes', 'memory.current'), ('peakBytes', 'memory.peak'), ('tasks', 'pids.current')]:
            value = read(name)
            if value is not None:
                metrics[field] = number(value)
print(json.dumps(metrics, separators=(',', ':')))
`;
const METRICS_COMMAND = `/usr/bin/python3 -c 'import base64;exec(base64.b64decode("${Buffer.from(METRICS_SCRIPT).toString('base64')}"))'`;

async function serviceMetrics(host, unit) {
  assertUnit(host, unit);
  const output = await run(host, `${METRICS_COMMAND} ${unit}`, 25000);
  try {
    const metrics = JSON.parse(output);
    if (metrics.unit !== unit || !/^[0-9]+$/.test(metrics.sampledAtNs || '') ||
        (metrics.cpuUsageNs !== null && !/^[0-9]+$/.test(metrics.cpuUsageNs || ''))) throw new Error('Invalid metrics response.');
    return metrics;
  } catch (error) {
    throw new Error(`Could not read remote service metrics: ${error.message}`);
  }
}

async function readHistory(host, unit, range, limit = 500, password = null) {
  assertUnit(host, unit);
  const since = { hour: '1 hour ago', day: '24 hours ago', week: '7 days ago' }[range];
  if (!since) throw new Error('Invalid log time range.');
  const lines = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const command = `journalctl --no-pager --lines=${lines} --since='${since}' --output=json --unit=${unit}`;
  return password === null ? run(host, command, 60000) : privilegedCommand(host, command, password, 60000, 8 * 1024 * 1024);
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

function validatePassword(password) {
  if (typeof password !== 'string' || password.length > 1024 || password.includes('\n') || password.includes('\r')) {
    throw new Error('Invalid remote administrator password.');
  }
}

function privilegedCommand(host, command, password, timeout = 120000, maxOutput = 8192) {
  validateHost(host);
  validatePassword(password);
  const sudo = password ? `sudo -S -p '' ${command}` : `sudo -n ${command}`;
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...SSH_OPTIONS, host, sudo], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(stdout);
    };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('Remote operation timed out.')); }, timeout);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > maxOutput) { child.kill('SIGTERM'); finish(new Error('Remote output exceeded the allowed size.')); }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString().slice(0, Math.max(0, 8192 - stderr.length)); });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => finish(code === 0 ? null : new Error(stderr.trim() || stdout.trim() || 'Remote operation failed.')));
    child.stdin.on('error', () => {});
    child.stdin.end(password ? `${password}\n` : '');
  });
}

async function serviceAction(host, action, unit, password) {
  assertUnit(host, unit);
  if (!ALLOWED_ACTIONS.has(action)) throw new Error('Service action is not allowed.');
  return privilegedCommand(host, `systemctl ${action} -- ${unit}`, password);
}

async function deleteService(host, unit, password) {
  assertUnit(host, unit);
  const draft = await getUnitDraft(host, unit);
  if (draft.mode !== 'local') throw new Error('Only local service files can be deleted.');
  const script = Buffer.from(DELETE_UNIT_SCRIPT).toString('base64');
  const command = `/usr/bin/python3 -c 'import base64;exec(base64.b64decode("${script}"))' ${unit} ${draft.original}`;
  await privilegedCommand(host, command, password);
  knownUnits.get(host)?.delete(unit);
  return true;
}

function stopLogs() {
  if (logProcess && !logProcess.killed) logProcess.kill('SIGTERM');
  logProcess = null;
}

function startLogs(host, unit, sender, limit = 500, password = null) {
  assertUnit(host, unit);
  if (password !== null) validatePassword(password);
  stopLogs();
  const lines = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const command = `journalctl --follow --lines=${lines} --no-pager --output=json --unit=${unit}`;
  const remoteCommand = password === null ? command : (password ? `sudo -S -p '' ${command}` : `sudo -n ${command}`);
  const child = spawn('ssh', [...SSH_OPTIONS, host,
    remoteCommand
  ], { stdio: [password ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  if (password) {
    child.stdin.on('error', () => {});
    child.stdin.end(`${password}\n`);
  }
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

module.exports = { validateHost, checkHost, inspectHost, setupHost, listServices, serviceMetrics, serviceAction, getUnitDraft, saveUnitDraft, deleteService, readHistory, startLogs, stopLogs };
