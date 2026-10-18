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
