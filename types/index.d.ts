/** A stage's state. `warning` blocks the pipeline like `pending` but is shown in yellow. */
export type StageState = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'superseded' | 'warning'

/** One stage of a PR track, or one step of a task list. */
export type Stage = {
  /** `pr-ci`, `merged`, `main-ci`, `deploy:<name>`, `check:<name>` or `step:<name>`. */
  id: string
  label: string
  /** `mod` stages are computed from GitHub; `agent` stages are set through the tool. */
  owner: 'mod' | 'agent'
  state: StageState
  note?: string
  /** What the state is about (a run id), so a repeat failure on a new run alerts again. */
  ref?: string
  url?: string
  startedAt?: number
  endedAt?: number
}

export type Track = {
  /** `owner/repo#number`. */
  key: string
  repo: string
  number: number
  title?: string
  url?: string
  headSha?: string
  mergeSha?: string
  deployedSha?: string
  stages: Stage[]
  notes: string[]
  /** `active` is polled; `done` and `closed` linger, then move to history. */
  status: 'active' | 'done' | 'closed'
  createdAt: number
  updatedAt: number
  endedAt?: number
}

export type TaskList = {
  id: string
  title: string
  steps: Stage[]
  createdAt: number
  updatedAt: number
  endedAt?: number
}

export type Meta = {
  /** `owner/repo` of the session's repository, or null outside one. */
  repo: string | null
  /** Short text of the last `gh` failure, shown on the bar; null when healthy. */
  ghError: string | null
  /** The clock, ticked while something is in flight so elapsed times redraw. */
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    'ship-progress': {
      tracks: Track[]
      lists: TaskList[]
      meta: Meta
    }
  }
}
