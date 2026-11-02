'use strict'
/**
 * Preloaded into the dsh process on Windows only (`NODE_OPTIONS=--require ...`).
 *
 * Windows cannot deliver SIGINT to another process, so `scripts/dsh-superagent.mjs stop` writes a stop-request file
 * instead. This hook watches that file, removes itself from NODE_OPTIONS so shell jobs do not inherit it, reports the
 * service's real Node PID (the launcher may be cmd.exe), and raises SIGINT inside DSH, whose own handler disposes the
 * profile and lets Executors finish.
 */
const fs = require('node:fs')

const stopFile = process.env.DSH_SUPERAGENT_STOP_FILE
const pidFile = process.env.DSH_SUPERAGENT_SERVICE_PID
const previousOptions = process.env.DSH_SUPERAGENT_NODE_OPTIONS

// Do not leak the preload into the shells and CLIs DSH starts.
if (previousOptions === undefined) delete process.env.NODE_OPTIONS
else if (previousOptions === '') delete process.env.NODE_OPTIONS
else process.env.NODE_OPTIONS = previousOptions

if (stopFile && pidFile) {
  try { fs.writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 }) } catch { /* The service script reports a start failure. */ }
  const removePid = () => { try { fs.unlinkSync(pidFile) } catch { /* Already gone. */ } }
  process.on('exit', removePid)

  const timer = setInterval(() => {
    let requested = false
    try { requested = fs.existsSync(stopFile) } catch { /* Keep watching. */ }
    if (!requested) return
    clearInterval(timer)
    try { fs.unlinkSync(stopFile) } catch { /* Another stop consumed it. */ }
    // DSH registers its SIGINT handler while the profile boots; retry if the request arrived before it did.
    const interrupt = () => { if (!process.emit('SIGINT', 'SIGINT')) setTimeout(interrupt, 200).unref() }
    interrupt()
  }, 200)
  // The timer must not keep a service that is otherwise exiting alive.
  timer.unref()
}
