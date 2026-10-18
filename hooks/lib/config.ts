import type { StageState } from '../../types'

export type DeployConfig = {
  name: string
  workflow: string
  branch?: string
  deployedSha: { from: 'headSha' } | { from: 'log'; pattern: string }
  timeoutMinutes: number
}

export type CheckConfig = {
  name: string
  argv: string[]
  intervalSeconds: number
  timeoutMinutes: number
  env?: Record<string, string>
}

export type Config = {
  version: 1
  ci?: { workflow: string }
  deploys: DeployConfig[]
  checks: CheckConfig[]
  notify: {
    macos: boolean
    slack?: { webhookEnv: string }
    wakeAgent: boolean
    on: Array<StageState | 'done'>
  }
  doneLingerMinutes: number
}

export const DEFAULT_CONFIG: Config = {
  version: 1,
  deploys: [],
  checks: [],
  notify: { macos: true, wakeAgent: true, on: ['failed', 'warning', 'done'] },
  doneLingerMinutes: 10,
}

const STATES: readonly string[] = ['pending', 'running', 'passed', 'failed', 'skipped', 'superseded', 'warning', 'done']
const NAME = /^[\w .:-]{1,40}$/

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const closed = (o: Obj, at: string, allowed: readonly string[]) => {
  const extra = Object.keys(o).filter(k => !allowed.includes(k))
  if (extra.length) throw new Error(`${at}: unknown field(s) ${extra.join(', ')}`)
}
const str = (v: unknown, at: string) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${at} must be a non-empty string`)
  return v
}
const name = (v: unknown, at: string) => {
  const s = str(v, at)
  if (!NAME.test(s)) throw new Error(`${at} "${s}" may hold only letters, digits, spaces and _ . : - (40 at most)`)
  return s
}
const num = (v: unknown, at: string, fallback: number, min: number, max: number) => {
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${at} must be a number from ${min} to ${max}`)
  return v
}
const unique = (names: string[], at: string) => {
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup) throw new Error(`${at}: "${dup}" is listed twice`)
}

const deploy = (v: unknown, i: number): DeployConfig => {
  const at = `deploys[${i}]`
  if (!isObj(v)) throw new Error(`${at} must be an object`)
  closed(v, at, ['name', 'workflow', 'branch', 'deployedSha', 'timeoutMinutes'])
  let deployedSha: DeployConfig['deployedSha'] = { from: 'headSha' }
  if (v.deployedSha !== undefined) {
    const d = v.deployedSha
    if (!isObj(d)) throw new Error(`${at}.deployedSha must be an object`)
    closed(d, `${at}.deployedSha`, ['from', 'pattern'])
    if (d.from === 'headSha') deployedSha = { from: 'headSha' }
    else if (d.from === 'log') {
      const pattern = str(d.pattern, `${at}.deployedSha.pattern`)
      try {
        new RegExp(pattern)
      } catch {
        throw new Error(`${at}.deployedSha.pattern is not a valid regular expression`)
      }
      if (!/\((?!\?)/.test(pattern)) throw new Error(`${at}.deployedSha.pattern needs a capture group for the SHA`)
      deployedSha = { from: 'log', pattern }
    } else throw new Error(`${at}.deployedSha.from must be "headSha" or "log"`)
  }
  return {
    name: name(v.name, `${at}.name`),
    workflow: str(v.workflow, `${at}.workflow`),
    ...(v.branch !== undefined && { branch: str(v.branch, `${at}.branch`) }),
    deployedSha,
    timeoutMinutes: num(v.timeoutMinutes, `${at}.timeoutMinutes`, 45, 1, 24 * 60),
  }
}

const check = (v: unknown, i: number): CheckConfig => {
  const at = `checks[${i}]`
  if (!isObj(v)) throw new Error(`${at} must be an object`)
  closed(v, at, ['name', 'argv', 'intervalSeconds', 'timeoutMinutes', 'env'])
  if (!Array.isArray(v.argv) || v.argv.length === 0 || !v.argv.every(a => typeof a === 'string')) throw new Error(`${at}.argv must be a non-empty array of strings`)
  let env: Record<string, string> | undefined
  if (v.env !== undefined) {
    if (!isObj(v.env) || !Object.values(v.env).every(x => typeof x === 'string')) throw new Error(`${at}.env must map names to strings`)
    env = v.env as Record<string, string>
  }
  return {
    name: name(v.name, `${at}.name`),
    argv: v.argv as string[],
    intervalSeconds: num(v.intervalSeconds, `${at}.intervalSeconds`, 60, 10, 3600),
    timeoutMinutes: num(v.timeoutMinutes, `${at}.timeoutMinutes`, 20, 1, 24 * 60),
    ...(env && { env }),
  }
}

/** Parses `.claude/ship-progress.json` against its closed schema; throws a message naming the field. */
export const parseConfig = (text: string): Config => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`not valid JSON (${err instanceof Error ? err.message : String(err)})`)
  }
  if (!isObj(raw)) throw new Error('must be a JSON object')
  closed(raw, 'config', ['$schema', 'version', 'ci', 'deploys', 'checks', 'notify', 'doneLingerMinutes'])
  if (raw.version !== 1) throw new Error('version must be 1')
  const out: Config = { ...DEFAULT_CONFIG, notify: { ...DEFAULT_CONFIG.notify } }
  if (raw.ci !== undefined) {
    if (!isObj(raw.ci)) throw new Error('ci must be an object')
    closed(raw.ci, 'ci', ['workflow'])
    out.ci = { workflow: str(raw.ci.workflow, 'ci.workflow') }
  }
  if (raw.deploys !== undefined) {
    if (!Array.isArray(raw.deploys)) throw new Error('deploys must be an array')
    out.deploys = raw.deploys.map(deploy)
    unique(out.deploys.map(d => d.name), 'deploys')
  }
  if (raw.checks !== undefined) {
    if (!Array.isArray(raw.checks)) throw new Error('checks must be an array')
    out.checks = raw.checks.map(check)
    unique(out.checks.map(c => c.name), 'checks')
  }
  if (raw.notify !== undefined) {
    const n = raw.notify
    if (!isObj(n)) throw new Error('notify must be an object')
    closed(n, 'notify', ['macos', 'slack', 'wakeAgent', 'on'])
    for (const k of ['macos', 'wakeAgent'] as const) {
      if (n[k] !== undefined && typeof n[k] !== 'boolean') throw new Error(`notify.${k} must be true or false`)
      if (typeof n[k] === 'boolean') out.notify[k] = n[k]
    }
    if (n.slack !== undefined) {
      if (!isObj(n.slack)) throw new Error('notify.slack must be an object')
      closed(n.slack, 'notify.slack', ['webhookEnv'])
      const env = str(n.slack.webhookEnv, 'notify.slack.webhookEnv')
      if (!/^[A-Z_][A-Z0-9_]*$/.test(env)) throw new Error('notify.slack.webhookEnv must be an environment variable NAME (A-Z, 0-9, _), never the URL')
      out.notify.slack = { webhookEnv: env }
    }
    if (n.on !== undefined) {
      if (!Array.isArray(n.on) || !n.on.every(s => STATES.includes(s as string))) throw new Error(`notify.on must list states from: ${STATES.join(', ')}`)
      out.notify.on = n.on as Config['notify']['on']
    }
  }
  out.doneLingerMinutes = num(raw.doneLingerMinutes, 'doneLingerMinutes', 10, 0, 24 * 60)
  return out
}
