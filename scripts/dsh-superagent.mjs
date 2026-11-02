#!/usr/bin/env node
/**
 * Manage a local dsh-superagent service (one DSH profile, default `superagent`) on Windows, Linux, or macOS.
 *
 * `status`, `start`, and `restart` exit 0 while the service runs normally; 1 when it is stopped, duplicated,
 * unreachable, or reporting a runtime error, which `restart` may fix; 2 when it runs while a component such as a
 * Source reports an error; and 3 when it runs and waits for setup. A restart fixes neither 2 nor 3: they need a person.
 *
 * The service runs as a detached background process. On Windows, `start` installs a small stop hook through
 * NODE_OPTIONS, because Windows cannot deliver SIGINT to another process; `stop` asks the hook to raise it inside
 * the service, so Executors still finish gracefully.
 */
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { delimiter, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

export const ROOT = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '..')
export const ARTIFACTS = join(ROOT, '.artifacts')
export const CONTROL = join(ARTIFACTS, 'control')
export const KEEP_LOGS = 20
const WINDOWS = process.platform === 'win32'

/** The control directory for `profile`, created if needed. */
export function control(profile) {
  const directory = join(CONTROL, 'profiles', profile)
  mkdirSync(directory, { recursive: true })
  return directory
}

/** Whether `profile` was intentionally stopped. */
export function stopped(profile) {
  return existsSync(join(control(profile), 'manually-stopped'))
}

/**
 * Whether one process command line belongs to the main DSH service for `profile`. `ps` and PowerShell both show
 * paths split on whitespace, so only `--profile` and the `plugin` subcommand are inspected.
 */
export function serves(args, profile) {
  const words = []
  let matched = false, value = false
  for (const word of args.slice(1)) {
    if (value) { matched = matched || word === profile; value = false }
    else if (word === '--profile') value = true
    else if (word === `--profile=${profile}`) matched = true
    else if (!word.startsWith('-')) words.push(word)
  }
  return matched && !words.includes('plugin')
}

/** Resolve a command to an executable file the way the platform shell would. */
export function which(name) {
  const extensions = WINDOWS && extname(name) === '' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = join(directory, name + extension)
      try {
        if (!statSync(candidate).isFile()) continue
        if (!WINDOWS) accessSync(candidate, constants.X_OK)
        return candidate
      } catch { /* Try the next candidate. */ }
    }
  }
  return undefined
}

/** The PowerShell that lists processes and runs prepare commands on Windows. */
function powerShell() {
  return which('pwsh') ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

let windowsScanDisabled = false
/** List `(pid, program, args)` tuples for every process the platform lets this user inspect. */
export function scanProcesses() {
  if (!WINDOWS) {
    const result = spawnSync('ps', ['-ww', '-ax', '-o', 'pid=,ucomm=,args='], { encoding: 'utf8' })
    if (result.status !== 0 || !result.stdout) return []
    return result.stdout.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
      return match ? [{ pid: Number(match[1]), program: match[2], args: match[3].split(/\s+/) }] : []
    })
  }
  // `Get-CimInstance` is the only built-in way to read a command line; some machines deny it to ordinary users.
  // Once that happens, the PID file the service writes is the source of truth, and the scan is not retried.
  if (windowsScanDisabled) return []
  const command = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); '
    + "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','dsh.exe') } | "
    + 'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
  const result = spawnSync(powerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  if (result.status !== 0) { windowsScanDisabled = true; return [] }
  if (!result.stdout?.trim()) return []
  let parsed
  try { parsed = JSON.parse(result.stdout) } catch { return [] }
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((entry) => {
    if (typeof entry?.CommandLine !== 'string' || !Number.isInteger(entry.ProcessId)) return []
    return [{ pid: entry.ProcessId, program: 'node', args: entry.CommandLine.split(/\s+/) }]
  })
}

/** PIDs of every running DSH service process for `profile`, including instances started outside this script when the platform lets us read command lines. */
export async function processes(profile) {
  const found = scanProcesses().filter(process_ => {
    if (process_.pid === process.pid) return false
    const line = process_.args.join(' ')
    // The manager is itself a `node ...dsh-superagent.mjs ... --profile <profile>` process, and a package manager parent
    // may carry the same arguments; neither is the service.
    if (/dsh-superagent\.mjs|(?:^|[\\/])pnpm(?:\.cjs)?\b|npm-cli\.js/i.test(line)) return false
    return /(?:^|[\\/])(?:node|dsh)(?:\.exe)?$/i.test(process_.program) && serves(process_.args, profile)
  }).map(process_ => process_.pid)
  // Windows may deny WMI (Get-CimInstance) to an ordinary user; the PID file the service writes is then the only record.
  const recorded = readPid(profile)
  if (WINDOWS && recorded && alive(recorded) && !found.includes(recorded)) found.push(recorded)
  return found
}

/** Whether `pid` is currently running. */
export function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

function readPid(profile) {
  try {
    const pid = Number(readFileSync(join(control(profile), 'service.pid'), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch { return undefined }
}

function writePid(profile, pid) {
  writeFileSync(join(control(profile), 'service.pid'), `${pid}\n`, { mode: 0o600 })
}

/** Fetch health and setup status from the management API, or return null if unreachable. */
export async function state(url) {
  try {
    const response = await fetch(url.replace(/\/+$/, '') + '/orchestrator/api/state',
      { headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(2000) })
    if (!response.ok) return null
    const value = await response.json()
    // Keys omitted by another version read as empty so the service is not mistaken for unreachable.
    const health = value.health ?? {}, setup = value.setup ?? {}
    const entries = Object.fromEntries(Object.entries(health).map(([name, entry]) => [name, entry && typeof entry === 'object' ? entry : {}]))
    return { health: Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, entry.state])),
      errors: Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.state === 'error').map(([name, entry]) => [name, String(entry.detail ?? '')])),
      setup: setup.problem ?? null, feishu: setup.feishuProblem ?? null }
  } catch { return null }
}

export const PART_ERROR = 2
export const SETUP_WAITS = 3

/** Whether the runtime is ready or paused awaiting operator action. */
export function runtimeUp(current) {
  return current !== null && ['ready', 'paused'].includes(current.health.runtime)
}

/** Non-runtime components that are in an error state. */
export function partErrors(current) {
  return Object.fromEntries(Object.entries(current.errors).filter(([name]) => name !== 'runtime').sort(([a], [b]) => a.localeCompare(b)))
}

/** Compute the CLI exit code from running PIDs and management API state. */
export function outcome(pids, current) {
  if (pids.length !== 1 || !runtimeUp(current)) return 1
  if (current.setup) return SETUP_WAITS
  return Object.keys(partErrors(current)).length ? PART_ERROR : 0
}

/** Print the JSON status document and return its exit code. */
export async function status(args) {
  const pids = await processes(args.profile)
  const current = pids.length ? await state(args.url) : null
  console.log(JSON.stringify({ pids, cwd: ROOT, url: args.url, manually_stopped: stopped(args.profile),
    health: current?.health ?? null, errors: current?.errors ?? null, setup: current?.setup ?? null, feishu: current?.feishu ?? null }, null, 2))
  return outcome(pids, current)
}

/** Write the stop request a Windows service's hook watches, or deliver SIGINT on POSIX. */
function requestStop(profile, pid) {
  if (WINDOWS) {
    writeFileSync(join(control(profile), 'stop-request'), `${new Date().toISOString()}\n`, { mode: 0o600 })
    return
  }
  process.kill(pid, 'SIGINT')
}

/** Stop the service gracefully, recording a manual stop marker when `intentional` is true. */
export async function stop(args, intentional = true) {
  const pids = await processes(args.profile)
  if (pids.length > 1) throw new Error('Multiple dsh-superagent processes found; refusing to choose one.')
  // An instance started outside the script has no PID file on Windows; do not claim to have stopped it.
  if (!pids.length && WINDOWS && await state(args.url) !== null) {
    throw new Error('The service answers but was not started by this script; stop it from its own window.')
  }
  // Write the stop marker before waiting so monitors respect the intentional stop even if graceful shutdown times out.
  if (intentional) writeFileSync(join(control(args.profile), 'manually-stopped'), `${new Date().toISOString()}\n`, { mode: 0o600 })
  for (const pid of pids) requestStop(args.profile, pid)
  const deadline = Date.now() + args.stopTimeout * 1000
  while (pids.some(alive)) {
    if (Date.now() >= deadline) throw new Error('Graceful stop timed out; no forced kill was sent. Check status.')
    await delay(500)
  }
  try { unlinkSync(join(control(args.profile), 'service.pid')) } catch { /* Already gone. */ }
  try { unlinkSync(join(control(args.profile), 'stop-request')) } catch { /* Already consumed. */ }
  console.log(intentional ? 'dsh-superagent stopped. Automatic recovery is paused until start/restart.' : 'dsh-superagent stopped.')
}

/** Retain only the newest `KEEP_LOGS` log files for `profile`. */
export function pruneLogs(profile, directory = ARTIFACTS) {
  const name = new RegExp(`^dsh-superagent-${profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}-\\d{6}-\\d+\\.log$`)
  let names = []
  try { names = readdirSync(directory).filter(file => name.test(file)) } catch { return }
  const logs = names.flatMap(file => {
    try { return [{ file, at: statSync(join(directory, file)).mtimeMs }] } catch { return [] }
  }).sort((a, b) => a.at - b.at)
  for (const { file } of logs.slice(0, Math.max(0, logs.length - KEEP_LOGS))) {
    try { unlinkSync(join(directory, file)) } catch { /* Another process pruned it. */ }
  }
}

/** The environment that starts a Windows service with the graceful-stop hook installed. */
export function serviceEnvironment(profile) {
  const stopFile = join(control(profile), 'stop-request')
  const pidFile = join(control(profile), 'service.pid')
  const hook = join(ROOT, 'scripts', 'dsh-superagent-stop-hook.cjs').replaceAll('\\', '/')
  const previous = process.env.NODE_OPTIONS ?? ''
  return { ...process.env, NODE_OPTIONS: `${previous} --require "${hook}"`.trim(), DSH_SUPERAGENT_NODE_OPTIONS: previous,
    DSH_SUPERAGENT_STOP_FILE: stopFile, DSH_SUPERAGENT_SERVICE_PID: pidFile }
}

/** Spawn the detached service. Windows launches it through cmd.exe so its output can be redirected without inherited handles. */
export function spawnService(args, log) {
  const dsh = which('dsh')
  if (!dsh) throw new Error('dsh must be on PATH.')
  if (WINDOWS) {
    try { unlinkSync(join(control(args.profile), 'stop-request')) } catch { /* No stale request. */ }
    const line = `""${dsh}" --profile ${args.profile} --no-open >> "${log}" 2>&1"`
    const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], { cwd: ROOT, detached: true, stdio: 'ignore',
      windowsHide: true, windowsVerbatimArguments: true, env: serviceEnvironment(args.profile) })
    child.unref()
    if (child.pid === undefined) throw new Error('The service process did not start; inspect PATH and the log.')
    return child.pid
  }
  const fd = openSync(log, 'a', 0o600)
  try {
    const child = spawn(dsh, ['--profile', args.profile, '--no-open'], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd], env: process.env })
    child.unref()
    if (child.pid === undefined) throw new Error('The service process did not start; inspect PATH and the log.')
    return child.pid
  } finally { closeSync(fd) }
}

export async function waitForPid(profile, fallback) {
  if (!WINDOWS) { writePid(profile, fallback); return fallback }
  const pidFile = join(control(profile), 'service.pid')
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const pid = readPid(profile)
    if (pid) return pid
    await delay(100)
  }
  // The hook did not report its PID; find the process by its command line so status still works, but stop will not be graceful.
  const found = await processes(profile)
  if (found.length === 1 && found[0] !== fallback) { writePid(profile, found[0]); return found[0] }
  return undefined
}

/** Start the service unless it already runs, then wait for its runtime to become ready. */
export async function start(args) {
  const pids = await processes(args.profile)
  if (pids.length > 1) throw new Error('Multiple dsh-superagent processes found; refusing to start another.')
  if (pids.length) {
    writePid(args.profile, pids[0])
    try { unlinkSync(join(control(args.profile), 'stop-request')) } catch { /* No stale request. */ }
    console.log(`dsh-superagent already running (PID ${pids[0]}); no duplicate started.`)
  } else {
    if (await state(args.url) !== null) throw new Error('An existing orchestrator answers at this URL; refusing duplicate startup.')
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const log = join(ARTIFACTS, `dsh-superagent-${args.profile}-${stamp}-${process.pid}.log`)
    mkdirSync(ARTIFACTS, { recursive: true })
    closeSync(openSync(log, 'a', 0o600))
    pruneLogs(args.profile)
    const childPid = spawnService(args, log)
    const pid = await waitForPid(args.profile, childPid)
    if (!pid) throw new Error('The service did not report its process ID; inspect the log.')
    console.log('Log: ' + log)
  }
  try { unlinkSync(join(control(args.profile), 'manually-stopped')) } catch { /* No marker. */ }
  const deadline = Date.now() + args.timeout * 1000
  while (Date.now() < deadline) {
    const current = await state(args.url)
    const pid = readPid(args.profile)
    if (runtimeUp(current) && pid && alive(pid)) {
      const code = await status(args)
      if (current.setup) {
        console.log('dsh-superagent is waiting for setup: ' + String(current.setup.detail ?? ''))
        console.log('Open the URL DSH printed in the log, then the dsh-superagent overview.')
      }
      if (current.feishu) {
        console.log('dsh-superagent runs without Feishu: ' + String(current.feishu.detail ?? ''))
        console.log('Fix it on the Feishu card of the Source settings.')
      }
      for (const [name, detail] of Object.entries(partErrors(current))) console.log(`${name} reports an error, which a restart does not fix: ${detail}`)
      return code
    }
    await delay(1000)
  }
  await status(args)
  throw new Error('Startup health check timed out; inspect the log. Any running process was left intact.')
}

/** Parse command-line arguments, applying the environment defaults the POSIX script used. */
export function parseArguments(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    profile: { type: 'string' }, url: { type: 'string' }, timeout: { type: 'string' }, 'stop-timeout': { type: 'string' },
    'respect-stop': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } })
  if (values.help) return { help: true }
  const action = positionals[0]
  if (!action || !['start', 'stop', 'restart', 'status'].includes(action)) throw new Error('usage: dsh-superagent <start|stop|restart|status>')
  if (positionals.length > 1) throw new Error('unexpected arguments: ' + positionals.slice(1).join(' '))
  const profile = values.profile || process.env.DSH_SUPERAGENT_PROFILE || 'superagent'
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(profile)) throw new Error('--profile must be a DSH profile name')
  const timeout = Number(values.timeout ?? 60), stopTimeout = Number(values['stop-timeout'] ?? 300)
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(stopTimeout) || stopTimeout <= 0) {
    throw new Error('--timeout and --stop-timeout must be positive')
  }
  return { action, profile, url: values.url || process.env.DSH_SUPERAGENT_URL || 'http://127.0.0.1:3082',
    timeout, stopTimeout, respectStop: values['respect-stop'] === true }
}

/** Acquire the per-profile control lock; the lock file is removed on release and after a crash once its PID is gone. */
function acquireLock(profile) {
  const file = join(control(profile), 'operation.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600)
      writeFileSync(fd, `${process.pid}\n${Date.now()}\n`)
      closeSync(fd)
      return () => { try { unlinkSync(file) } catch { /* Already released. */ } }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let pid = 0, at = 0
      try { [pid, at] = readFileSync(file, 'utf8').split('\n').map(Number) } catch { /* A half-written lock is stale. */ }
      if (pid && alive(pid) && Date.now() - at < 15 * 60_000) throw new Error('Another dsh-superagent control operation is in progress.')
      try { unlinkSync(file) } catch { /* Another process removed it. */ }
    }
  }
  throw new Error('Another dsh-superagent control operation is in progress.')
}

/** Run one action; returns the process exit code. */
export async function main(argv) {
  const args = parseArguments(argv)
  if (args.help) { console.log('usage: dsh-superagent <start|stop|restart|status> [--profile <name>] [--url <url>] [--timeout <seconds>] [--stop-timeout <seconds>] [--respect-stop]'); return 0 }
  if (!WINDOWS) process.umask(0o077)
  const release = acquireLock(args.profile)
  try {
    if (args.respectStop && (args.action === 'start' || args.action === 'restart') && stopped(args.profile)) {
      console.log('Intentional stop is active; automatic recovery skipped.')
      return 0
    }
    if (args.action === 'status') return await status(args)
    if (args.action === 'stop' || args.action === 'restart') await stop(args, args.action === 'stop')
    if (args.action === 'start' || args.action === 'restart') return await start(args)
    return 0
  } finally { release() }
}

const entry = process.argv[1] ? realpathSync(resolve(process.argv[1])) : ''
if (entry && entry.toLowerCase() === realpathSync(fileURLToPath(import.meta.url)).toLowerCase()) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
