/**
 * Platform differences the application must handle to run on Windows and POSIX systems: executable lookup,
 * path comparison, and the shell that runs a prepare command.
 *
 * dsh-superagent runs on Windows without WSL, Git Bash, Python, or tmux. Where POSIX relies on a shell, a
 * command lookup, or a case-sensitive path, this module supplies the Windows equivalent.
 */
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path'

/** True on Windows, where command names resolve through `PATHEXT` and paths compare case-insensitively. */
export const isWindows = process.platform === 'win32'

/** True when two paths name the same directory; Windows path comparison ignores case. */
export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  const left = real(a), right = real(b)
  return isWindows ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Every `PATH` entry except `dir`, joined with the platform delimiter. */
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * Resolve a command name or absolute path to an executable file, or `undefined` when there is none.
 * On Windows a bare name also tries each `PATHEXT` suffix, so `gh` finds `gh.exe` as the shell would.
 * @param exclude - a directory left out of the search, such as dsh-superagent's own shim directory.
 */
export function findExecutable(name: string, path: string, exclude?: string): string | undefined {
  const absolute = isAbsolute(name)
  if (!absolute && (name.includes('/') || name.includes('\\'))) return undefined
  // Prefer a native executable, then the npm `.ps1` shim (which passes arguments safely), then the `.cmd` fallback.
  const preferred = ['.exe', '.com', '.ps1', '.cmd', '.bat']
  const fromPath = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const extensions = isWindows && extname(name) === ''
    ? [...preferred, ...fromPath].filter((extension, index, all) => all.indexOf(extension) === index)
    : ['']
  const directories = absolute ? [''] : path.split(delimiter).filter(directory => isAbsolute(directory) && !(exclude && sameDirectory(directory, exclude)))
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = absolute ? name + extension : join(directory, name + extension)
      try {
        if (!statSync(candidate).isFile()) continue
        // Windows has no executable bit; the file extension is what matters there.
        if (!isWindows) accessSync(candidate, constants.X_OK)
        return candidate
      } catch { /* Not here, or not executable; try the next candidate. */ }
    }
  }
  return undefined
}

/** A command line after platform adaptation: the program to spawn and the arguments to pass it. */
export interface Invocation { file: string; args: string[] }
/** Quote one argument for `cmd.exe /c`; used only for the `.cmd` shim fallback that npm installs beside `.ps1`. */
const cmdLine = (parts: readonly string[]): string => parts.map(part => `"${part.replaceAll('"', '\\"')}"`).join(' ')
/**
 * Adapt a CLI path to the way the platform starts it. On Windows an npm-installed CLI is a `.ps1` shim, which is
 * run through PowerShell so its arguments keep their quoting; a `.cmd` shim falls back to `cmd.exe /c`.
 */
export function invocation(program: string, args: string[]): Invocation {
  if (!isWindows) return { file: program, args }
  const extension = extname(program).toLowerCase()
  if (extension === '.ps1') {
    return { file: powerShell(), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', program, ...args] }
  }
  if (extension === '.cmd' || extension === '.bat') return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', cmdLine([program, ...args])] }
  return { file: program, args }
}
let resolvedPowerShell: string | undefined
/** The PowerShell that runs a prepare command: PowerShell 7 when installed, otherwise Windows PowerShell 5.1. */
export function powerShell(): string {
  if (resolvedPowerShell) return resolvedPowerShell
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const pwsh7 = join(programFiles, 'PowerShell', '7', 'pwsh.exe')
  const detected = existsSync(pwsh7) ? pwsh7 : findExecutable('pwsh', process.env.PATH ?? '')
  const windowsPowerShell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return resolvedPowerShell = detected ?? (existsSync(windowsPowerShell) ? windowsPowerShell : 'powershell.exe')
}

/** The argv that runs one shell command: `sh -c` on POSIX and PowerShell `-Command` on Windows. */
export function shellArgv(command: string): string[] {
  return isWindows
    ? [powerShell(), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    : ['sh', '-c', command]
}
