/** Tests for the cross-platform service manager: argument parsing, process matching, exit codes, and management API reads. */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error - the service manager is a plain Node script shared with the shell entry points.
import { KEEP_LOGS, outcome, parseArguments, pruneLogs, serves, state } from '../scripts/dsh-superagent.mjs'

let server: Server | undefined
afterEach(() => { server?.close(); server = undefined })

/** Start a local management API whose answer is `body`, or 503 until `ready`. */
async function answering(body: unknown, status = 200): Promise<string> {
  server = createServer((_request, response) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)))
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server!.address()
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
}

describe('process matching', () => {
  it('finds the service in `--profile` and `--profile=`, and never a plugin command', () => {
    expect(serves(['node', '/opt/dsh/bin.js', '--profile', 'superagent', '--no-open'], 'superagent')).toBe(true)
    expect(serves(['node', '/opt/dsh/bin.js', '--profile=superagent'], 'superagent')).toBe(true)
    expect(serves(['node', '/opt/dsh/bin.js', '--profile', 'other'], 'superagent')).toBe(false)
    // `dsh plugin --profile superagent ...` manages plugins; it is not the long-running service.
    expect(serves(['node', '/opt/dsh/bin.js', 'plugin', '--profile', 'superagent', 'add', 'x'], 'superagent')).toBe(false)
  })
})

describe('exit codes', () => {
  const ready = (extra: Record<string, unknown> = {}) => ({ health: { runtime: 'ready' }, errors: {}, setup: null, feishu: null, ...extra })
  it('is 0 only for one running process whose runtime is ready', () => {
    expect(outcome([1], ready())).toBe(0)
    expect(outcome([], ready())).toBe(1)
    expect(outcome([1, 2], ready())).toBe(1)
    expect(outcome([1], ready({ health: { runtime: 'starting' } }))).toBe(1)
    expect(outcome([1], null)).toBe(1)
  })
  it('is 3 while setup waits and 2 for a failing part other than the runtime', () => {
    expect(outcome([1], ready({ setup: { detail: 'The GitHub Source names no repository.' } }))).toBe(3)
    expect(outcome([1], ready({ health: { runtime: 'ready', github: 'error' }, errors: { github: 'bad token' } }))).toBe(2)
    expect(outcome([1], ready({ errors: { runtime: 'still fine' } }))).toBe(0)
  })
})

describe('management API', () => {
  it('reads health, setup, and Feishu problems, and keeps missing keys empty', async () => {
    const url = await answering({ health: { runtime: { state: 'ready' }, github: { state: 'error', detail: 'bad token' } },
      setup: { problem: { detail: 'needs a repository' }, feishuProblem: { detail: 'no bot' } } })
    expect(await state(url)).toEqual({ health: { runtime: 'ready', github: 'error' }, errors: { github: 'bad token' },
      setup: { detail: 'needs a repository' }, feishu: { detail: 'no bot' } })
    server!.close(); server = undefined
    const partial = await answering({ health: { runtime: { state: 'ready' } } })
    expect(await state(partial)).toEqual({ health: { runtime: 'ready' }, errors: {}, setup: null, feishu: null })
  })
  it('returns null while the service does not answer', async () => {
    expect(await state('http://127.0.0.1:9')).toBeNull()
    const url = await answering({ error: 'not ready' }, 503)
    expect(await state(url)).toBeNull()
  })
})

describe('arguments', () => {
  it('defaults the profile and URL, and accepts the monitoring flags', () => {
    vi.stubEnv('DSH_SUPERAGENT_PROFILE', ''); vi.stubEnv('DSH_SUPERAGENT_URL', '')
    expect(parseArguments(['status'])).toMatchObject({ action: 'status', profile: 'superagent', url: 'http://127.0.0.1:3082', respectStop: false })
    expect(parseArguments(['--respect-stop', 'restart', '--profile', 'work', '--url', 'http://127.0.0.1:1', '--timeout', '5', '--stop-timeout', '7']))
      .toMatchObject({ action: 'restart', profile: 'work', url: 'http://127.0.0.1:1', timeout: 5, stopTimeout: 7, respectStop: true })
    vi.unstubAllEnvs()
  })
  it('rejects an unknown action, a bad profile, and non-positive timeouts', () => {
    expect(() => parseArguments(['bounce'])).toThrow('usage')
    expect(() => parseArguments(['status', '--profile', '../work'])).toThrow('profile')
    expect(() => parseArguments(['status', '--timeout', '0'])).toThrow('positive')
    expect(() => parseArguments(['status', '--stop-timeout', 'nope'])).toThrow('positive')
  })
})

it('keeps only the newest logs of one profile', () => {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-logs-'))
  try {
    for (let index = 0; index < KEEP_LOGS + 5; index++) {
      const file = join(directory, `dsh-superagent-superagent-20260101-0000${String(index).padStart(2, '0')}-1.log`)
      writeFileSync(file, '')
      utimesSync(file, 1_700_000_000 + index, 1_700_000_000 + index)
    }
    writeFileSync(join(directory, 'dsh-superagent-other-20260101-000000-1.log'), '')
    writeFileSync(join(directory, 'dsh-superagent-superagent-notes.log'), '')
    pruneLogs('superagent', directory)
    const left = readdirSync(directory)
    expect(left.filter(name => name.startsWith('dsh-superagent-superagent-20260101-'))).toHaveLength(KEEP_LOGS)
    expect(left).toContain('dsh-superagent-other-20260101-000000-1.log')
    expect(left).toContain('dsh-superagent-superagent-notes.log')
    // The oldest five went.
    expect(left).not.toContain('dsh-superagent-superagent-20260101-000000-1.log')
    expect(left).toContain('dsh-superagent-superagent-20260101-000005-1.log')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
