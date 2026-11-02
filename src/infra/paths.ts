/** Resolves packaged asset paths from either the source tree or the compiled lib/ output. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | undefined
export function packageRoot(): string {
  if (cached) return cached
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try { if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === 'dsh-superagent') return cached = directory }
      catch { /* A foreign package.json on the way up is not this package. */ }
    }
    directory = dirname(directory)
  }
  throw new Error('dsh-superagent package root not found')
}
/** A packaged asset's path, or an absolute path as given (a caller may name a file outside the package). */
export const packagePath = (...parts: string[]): string => {
  const [first, ...rest] = parts
  return first !== undefined && isAbsolute(first) ? join(first, ...rest) : join(packageRoot(), ...parts)
}
