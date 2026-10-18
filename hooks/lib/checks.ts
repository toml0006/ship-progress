import type { Track } from '../../types'
import type { CheckConfig } from './config'
import type { Runner } from './gh'
import type { StageFact } from './pipeline'

/** The most a single check run may take; its interval and timeout bound it further. */
const CHECK_RUN_MAX_MS = 60_000

/** Fills whole-element placeholders. Unknown or unresolved placeholders are an error, never passed through. */
export const substitute = (argv: readonly string[], track: Track): string[] => {
  const deployed = Object.fromEntries(track.stages.filter(s => s.id.startsWith('deploy:') && s.sha).map(s => [s.label, s.sha!]))
  return argv.map(arg => {
    const m = /^\{(mergeSha|prNumber|repo|deployedSha:([\w .:-]+))\}$/.exec(arg)
    if (!m) {
      if (/^\{[^}]*\}$/.test(arg)) throw new Error(`unknown placeholder ${arg}`)
      return arg
    }
    const value = m[2] !== undefined ? deployed[m[2]] : m[1] === 'mergeSha' ? track.mergeSha : m[1] === 'prNumber' ? String(track.number) : track.repo
    if (!value) throw new Error(`${arg} has no value yet`)
    return value
  })
}

/** SHA-256 of the checks array: what `/ship-progress trust` approves. */
export const checksHash = async (checks: readonly CheckConfig[]) => {
  const bytes = new TextEncoder().encode(JSON.stringify(checks))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

const lastLine = (text: string) => text.trim().split('\n').at(-1)?.trim().slice(0, 80) ?? ''

/** Runs one check once: exit 0 passes; anything else keeps it running with the output's last line. */
export const runCheck = async (run: Runner, check: CheckConfig, track: Track, cwd: string): Promise<StageFact> => {
  let argv: string[]
  try {
    argv = substitute(check.argv, track)
  } catch (err) {
    return { state: 'failed', note: err instanceof Error ? err.message : String(err) }
  }
  const timeoutMs = Math.min(CHECK_RUN_MAX_MS, check.intervalSeconds * 1000)
  try {
    const out = await run(argv, { cwd, timeoutMs, ...(check.env && { env: check.env }) })
    if (out.exitCode === 0) return { state: 'passed' }
    return { state: 'running', note: `exit ${out.exitCode}${lastLine(out.stderr || out.stdout) ? `: ${lastLine(out.stderr || out.stdout)}` : ''}` }
  } catch (err) {
    return { state: 'running', note: /time/i.test(String(err)) ? `no answer within ${timeoutMs / 1000}s` : `could not run: ${lastLine(String(err))}` }
  }
}
