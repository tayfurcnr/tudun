const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const execFileAsync = promisify(execFile);
const PROPERTY_NAMES = [
  'Id', 'Description', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState',
  'MainPID', 'ActiveEnterTimestamp', 'MemoryCurrent', 'FragmentPath', 'Result', 'ExecMainStatus'
];
const METRIC_PROPERTIES = [
  'Id', 'ActiveState', 'MainPID', 'ControlGroup', 'CPUUsageNSec',
  'MemoryCurrent', 'MemoryPeak', 'TasksCurrent', 'ActiveEnterTimestamp'
];
const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart', 'enable', 'disable']);
const SERVICE_NAME = /^[A-Za-z0-9_.:@-]+\.service$/;
const UNIT_DIR = '/etc/systemd/system';

let knownUnits = new Set();
let logProcess = null;

async function run(file, args, options = {}) {
  try {
    const { stdout = '', stderr = '' } = await execFileAsync(file, args, {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: options.timeout || 30000
    });
    return { stdout, stderr };
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || '').trim();
    throw new Error(detail || `${file} command failed.`);
  }
}

function parseProperties(output) {
  const values = {};
  for (const block of output.trim().split(/\n\s*\n/)) {
    const item = {};
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf('=');
      if (separator > 0) item[line.slice(0, separator)] = line.slice(separator + 1);
    }
    if (item.Id) values[item.Id] = item;
  }
  return values;
}

async function listServices() {
  const { stdout } = await run('systemctl', ['list-unit-files', '--type=service', '--no-legend', '--no-pager']);
  const units = [];
  const fileStates = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const [name, state] = line.trim().split(/\s+/, 3);
    if (!name?.endsWith('.service') || !state || name.includes('@.') || state === 'alias') continue;
    if (!fileStates.has(name)) {
      units.push(name);
      fileStates.set(name, state);
    }
  }

  const services = [];
  for (let offset = 0; offset < units.length; offset += 100) {
    const batch = units.slice(offset, offset + 100);
    const { stdout: propertiesOutput } = await run('systemctl', [
      'show', '--no-pager', `--property=${PROPERTY_NAMES.join(',')}`, ...batch
    ]);
    const properties = parseProperties(propertiesOutput);
    for (const name of batch) {
      const item = properties[name] || {};
      services.push({
        name,
        description: item.Description || '',
        load: item.LoadState || 'not-found',
        active: item.ActiveState || 'unknown',
        sub: item.SubState || 'unknown',
        startup: item.UnitFileState || fileStates.get(name),
        pid: item.MainPID || '0',
        since: item.ActiveEnterTimestamp || '',
        memory: item.MemoryCurrent || '',
        file: item.FragmentPath || '',
        result: item.Result || '',
        exitCode: item.ExecMainStatus || ''
      });
    }
  }
  knownUnits = new Set(services.map((service) => service.name));
  return services;
}

function metricNumber(value) {
  const number = Number(value);
  return value && Number.isFinite(number) && number >= 0 ? number : null;
}

async function readCgroupValue(directory, name) {
  try { return (await fs.readFile(path.join(directory, name), 'utf8')).trim(); }
  catch { return null; }
}

async function serviceMetrics(unit) {
  assertKnownUnit(unit);
  const { stdout } = await run('systemctl', [
    'show', '--no-pager', `--property=${METRIC_PROPERTIES.join(',')}`, unit
  ]);
  const item = parseProperties(stdout)[unit] || {};
  let cpuUsageNs = /^\d+$/.test(item.CPUUsageNSec || '') ? item.CPUUsageNSec : null;
  let memoryBytes = metricNumber(item.MemoryCurrent);
  let peakBytes = metricNumber(item.MemoryPeak);
  let tasks = metricNumber(item.TasksCurrent);
  let source = 'systemd';
  const group = item.ControlGroup || '';
  if (group.startsWith('/') && group !== '/' && !group.split('/').includes('..')) {
    const directory = path.resolve('/sys/fs/cgroup', `.${group}`);
    if (directory.startsWith('/sys/fs/cgroup/')) {
      const [cpuStat, memory, peak, pids] = await Promise.all([
        readCgroupValue(directory, 'cpu.stat'),
        readCgroupValue(directory, 'memory.current'),
        readCgroupValue(directory, 'memory.peak'),
        readCgroupValue(directory, 'pids.current')
      ]);
      if (cpuStat) {
        const usage = cpuStat.match(/^usage_usec\s+(\d+)$/m);
        if (usage) {
          cpuUsageNs = (BigInt(usage[1]) * 1000n).toString();
          source = 'cgroup v2';
        }
      }
      if (memory !== null) memoryBytes = metricNumber(memory);
      if (peak !== null) peakBytes = metricNumber(peak);
      if (pids !== null) tasks = metricNumber(pids);
    }
  }
  return {
    unit, active: item.ActiveState || 'unknown', pid: metricNumber(item.MainPID),
    cpuUsageNs, memoryBytes, peakBytes, tasks, source,
    since: item.ActiveEnterTimestamp || '', sampledAtNs: process.hrtime.bigint().toString()
  };
}

function assertKnownUnit(unit) {
  if (typeof unit !== 'string' || !SERVICE_NAME.test(unit) || unit.includes('..') || !knownUnits.has(unit)) {
    throw new Error('Invalid service or service no longer in the list.');
  }
}

function assertUnitName(unit) {
  if (typeof unit !== 'string' || !SERVICE_NAME.test(unit) || unit.length > 200 || unit.includes('..')) {
    throw new Error('Use a valid .service name without path separators.');
  }
}

const digest = (content) => crypto.createHash('sha256').update(content).digest('hex');

async function readExistingFile(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unit file is not a regular file.');
    if (stat.size > 65536) throw new Error('Unit file is too large to edit here.');
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function getUnitDraft(unit) {
  assertKnownUnit(unit);
  const { stdout } = await run('systemctl', ['show', '--property=FragmentPath', '--value', unit]);
  const fragment = stdout.trim();
  const local = fragment === path.join(UNIT_DIR, unit);
  const mode = local ? 'local' : 'override';
  const file = local ? fragment : path.join(UNIT_DIR, `${unit}.d`, 'override.conf');
  const content = await readExistingFile(file);
  return {
    unit, mode, file, original: digest(content),
    content: content || (local ? '' : '[Service]\n# Add or replace service settings here.\n# To replace ExecStart, clear it first with ExecStart=\n')
  };
}

const WRITE_UNIT_SCRIPT = String.raw`
import hashlib, json, os, re, subprocess, sys, tempfile
base = '/etc/systemd/system'
data = json.load(sys.stdin)
unit = data.get('unit')
mode = data.get('mode')
content = data.get('content')
expected = data.get('original')
if not isinstance(unit, str) or not re.fullmatch(r'[A-Za-z0-9_.:@-]+\.service', unit) or len(unit) > 200 or '..' in unit:
    sys.exit('Invalid service name')
if mode not in ('create', 'local', 'override') or not isinstance(content, str) or len(content.encode()) > 65536 or '\x00' in content:
    sys.exit('Invalid unit content')
if not re.fullmatch(r'[0-9a-f]{64}', expected or ''):
    sys.exit('Invalid revision')
if mode == 'override':
    if not re.search(r'^\[(Unit|Service|Install)\]\s*$', content, re.M): sys.exit('Override needs a section header')
    parent = os.path.join(base, unit + '.d')
    target = os.path.join(parent, 'override.conf')
else:
    if not re.search(r'^\[Unit\]\s*$', content, re.M) or not re.search(r'^\[Service\]\s*$', content, re.M): sys.exit('Unit needs [Unit] and [Service] sections')
    parent = base
    target = os.path.join(base, unit)
if mode == 'create' and subprocess.run(['systemctl', 'list-unit-files', '--no-legend', '--no-pager', unit], capture_output=True, text=True).stdout.strip():
    sys.exit('Service already exists')
if os.path.lexists(parent):
    if not os.path.isdir(parent) or os.path.islink(parent): sys.exit('Unsafe unit directory')
else:
    if mode != 'override': sys.exit('Unit directory missing')
    os.mkdir(parent, 0o755)
exists = os.path.lexists(target)
if mode == 'create' and exists: sys.exit('Service already exists')
if mode == 'local' and not exists: sys.exit('Unit file no longer exists')
if exists:
    if not os.path.isfile(target) or os.path.islink(target): sys.exit('Unsafe unit file')
    with open(target, 'rb') as stream: previous = stream.read()
else:
    previous = b''
if hashlib.sha256(previous).hexdigest() != expected: sys.exit('Unit changed since opening it; reopen the editor')
encoded = content.encode('utf-8')
if not encoded.endswith(b'\n'): encoded += b'\n'
fd, temporary = tempfile.mkstemp(prefix='.tudun-', dir=parent)
try:
    os.fchmod(fd, 0o644)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, target)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
result = subprocess.run(['systemctl', 'daemon-reload'], capture_output=True, text=True)
if result.returncode: sys.exit(result.stderr.strip() or 'daemon-reload failed')
print('ok')
`;

async function saveUnitDraft(draft) {
  const { unit, mode, content, original } = draft || {};
  assertUnitName(unit);
  if (!['create', 'local', 'override'].includes(mode) || typeof content !== 'string' || Buffer.byteLength(content) > 65536 || content.includes('\0')) {
    throw new Error('Invalid unit content.');
  }
  if (mode !== 'create') {
    assertKnownUnit(unit);
    const current = await getUnitDraft(unit);
    if (current.mode !== mode || current.original !== original) throw new Error('Unit changed since opening it; reopen the editor.');
  } else if (knownUnits.has(unit)) {
    throw new Error('Service already exists.');
  }
  return new Promise((resolve, reject) => {
    const child = spawn('pkexec', ['/usr/bin/python3', '-c', WRITE_UNIT_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString().slice(0, 8192); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString().slice(0, 8192); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ unit, mode });
      else reject(new Error(stderr.trim() || stdout.trim() || 'Could not save the service.'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ unit, mode, content, original }));
  });
}

const DELETE_UNIT_SCRIPT = String.raw`
import hashlib, os, re, subprocess, sys
unit, expected = sys.argv[1:3]
base = '/etc/systemd/system'
if not re.fullmatch(r'[A-Za-z0-9_.:@-]+\.service', unit) or len(unit) > 200 or '..' in unit:
    sys.exit('Invalid service name')
if not re.fullmatch(r'[0-9a-f]{64}', expected): sys.exit('Invalid revision')
target = os.path.join(base, unit)
if not os.path.isfile(target) or os.path.islink(target): sys.exit('Only regular local service files can be deleted')
fragment = subprocess.run(['systemctl', 'show', '--property=FragmentPath', '--value', unit], capture_output=True, text=True)
if fragment.returncode or fragment.stdout.strip() != target: sys.exit('This service is not a local unit')
with open(target, 'rb') as stream: content = stream.read()
if hashlib.sha256(content).hexdigest() != expected: sys.exit('Unit changed since confirmation; try again')
result = subprocess.run(['systemctl', 'disable', '--now', unit], capture_output=True, text=True)
if result.returncode: sys.exit(result.stderr.strip() or 'Could not stop and disable the service')
with open(target, 'rb') as stream: current = stream.read()
if hashlib.sha256(current).hexdigest() != expected: sys.exit('Unit changed during deletion; file was kept')
os.unlink(target)
result = subprocess.run(['systemctl', 'daemon-reload'], capture_output=True, text=True)
if result.returncode: sys.exit(result.stderr.strip() or 'Service deleted, but daemon-reload failed')
print('ok')
`;

async function deleteService(unit) {
  assertKnownUnit(unit);
  const draft = await getUnitDraft(unit);
  if (draft.mode !== 'local') throw new Error('Only local services can be deleted.');
  return new Promise((resolve, reject) => {
    const child = spawn('pkexec', ['/usr/bin/python3', '-c', DELETE_UNIT_SCRIPT, unit, draft.original], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString().slice(0, 8192); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString().slice(0, 8192); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(true);
      else reject(new Error(stderr.trim() || stdout.trim() || 'Could not delete the service.'));
    });
  });
}

async function serviceAction(action, unit) {
  assertKnownUnit(unit);
  if (!ALLOWED_ACTIONS.has(action)) throw new Error('Service action is not allowed.');
  return run('pkexec', ['systemctl', action, unit], { timeout: 120000 });
}

async function readHistory(unit, range, limit = 500) {
  assertKnownUnit(unit);
  const sinceByRange = { hour: '1 hour ago', day: '24 hours ago', week: '7 days ago' };
  if (!sinceByRange[range]) throw new Error('Invalid log time range.');
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const { stdout, stderr } = await run('pkexec', [
    'journalctl', '--no-pager', `--lines=${boundedLimit}`,
    '--since', sinceByRange[range], '--output=json', '--unit', unit
  ], { timeout: 120000 });
  return stdout || stderr;
}

function stopLogs() {
  if (logProcess && !logProcess.killed) logProcess.kill('SIGTERM');
  logProcess = null;
}

function startLogs(unit, sender, limit = 500) {
  assertKnownUnit(unit);
  stopLogs();
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const child = spawn('pkexec', [
    'journalctl', '--follow', `--lines=${boundedLimit}`, '--no-pager', '--output=json', '--unit', unit
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  logProcess = child;
  let remainder = '';
  const deliver = (chunk) => {
    remainder += chunk;
    const lines = remainder.split(/\r?\n/);
    remainder = lines.pop() || '';
    for (const line of lines) {
      if (!sender.isDestroyed()) sender.send('logs:line', line);
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', deliver);
  child.stderr.on('data', deliver);
  child.on('error', (error) => {
    if (!sender.isDestroyed()) sender.send('logs:line', `Could not start log stream: ${error.message}`);
  });
  child.on('close', (code) => {
    if (remainder && !sender.isDestroyed()) sender.send('logs:line', remainder);
    if (!sender.isDestroyed()) sender.send('logs:ended', code);
    if (logProcess === child) {
      logProcess = null;
    }
  });
}

module.exports = { listServices, serviceMetrics, serviceAction, getUnitDraft, saveUnitDraft, deleteService, readHistory, startLogs, stopLogs, WRITE_UNIT_SCRIPT, DELETE_UNIT_SCRIPT };
