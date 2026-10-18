import type { Stage, StageState, TaskList, Track } from '../../types'
import type { StepSpec } from './input'
import { DEFAULT_LINGER_MS, insertAfter, isSettled, moveStage, trackKey } from './model'

export const HISTORY_MS = 7 * 24 * 3_600_000
export const STORE_VERSION = 1

export type HistoryEntry = {
  key: string
  title?: string
  status: 'done' | 'closed' | 'untracked'
  sha?: string
  endedAt: number
}

/** Everything kept per repo in `$.store`, under `repo:<owner/repo>`. */
export type Persisted = {
  version: typeof STORE_VERSION
  tracks: Track[]
  lists: TaskList[]
  history: HistoryEntry[]
  /** Deployed SHA read from a deploy run's log, by run id; a run's log is read once. */
  logShas: Record<string, string>
  /** Whether `<merge>..<deployed>` holds the merge commit, by `merge:deployed`. */
  contains: Record<string, boolean>
  /** Alert dedupe keys already sent. */
  alerts: string[]
  /** Content hash of the `checks` array the person trusted, or null. */
  trust: string | null
}

export const emptyPersisted = (): Persisted => ({
  version: STORE_VERSION,
  tracks: [],
  lists: [],
  history: [],
  logShas: {},
  contains: {},
  alerts: [],
  trust: null,
})

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads a stored value: version 1 as is (fields defaulted), anything else as empty. */
export const migrate = (raw: unknown): Persisted => {
  if (!isObj(raw) || raw.version !== STORE_VERSION) return emptyPersisted()
  const base = emptyPersisted()
  return {
    version: STORE_VERSION,
    tracks: Array.isArray(raw.tracks) ? (raw.tracks as Track[]).filter(t => isObj(t) && typeof t.key === 'string') : base.tracks,
    lists: Array.isArray(raw.lists) ? (raw.lists as TaskList[]).filter(l => isObj(l) && typeof l.id === 'string') : base.lists,
    history: Array.isArray(raw.history) ? (raw.history as HistoryEntry[]) : base.history,
    logShas: isObj(raw.logShas) ? (raw.logShas as Record<string, string>) : base.logShas,
    contains: isObj(raw.contains) ? (raw.contains as Record<string, boolean>) : base.contains,
    alerts: Array.isArray(raw.alerts) ? (raw.alerts as string[]) : base.alerts,
    trust: typeof raw.trust === 'string' ? raw.trust : null,
  }
}

/** Keeps a record bounded: the newest `max` entries by insertion order. */
export const capRecord = <T>(rec: Record<string, T>, max: number) => {
  const keys = Object.keys(rec)
  return keys.length <= max ? rec : Object.fromEntries(keys.slice(-max).map(k => [k, rec[k] as T]))
}

/** Moves tracks that lingered past `lingerMs` into history and drops history older than 7 days. */
export const sweep = (p: Persisted, now: number, lingerMs = DEFAULT_LINGER_MS): Persisted => {
  const gone = p.tracks.filter(t => t.endedAt !== undefined && now - t.endedAt >= lingerMs)
  const history = [
    ...p.history,
    ...gone.map(t => ({ key: t.key, title: t.title, status: t.status === 'closed' ? 'closed' : 'done', sha: t.deployedSha ?? t.mergeSha, endedAt: t.endedAt! }) as HistoryEntry),
  ].filter(h => now - h.endedAt < HISTORY_MS)
  return {
    ...p,
    tracks: p.tracks.filter(t => !gone.includes(t)),
    lists: p.lists.filter(l => l.endedAt === undefined || now - l.endedAt < lingerMs),
    history,
    logShas: capRecord(p.logShas, 500),
    contains: capRecord(p.contains, 500),
    alerts: p.alerts.slice(-500),
  }
}

const step = (name: string, state: StageState, now: number): Stage =>
  moveStage({ id: `step:${name}`, label: name, owner: 'agent', state: 'pending' }, state, now)

const listEnd = (steps: readonly Stage[], now: number, prev?: number) =>
  steps.length > 0 && steps.every(s => isSettled(s.state)) ? (prev ?? now) : undefined

export const listSet = (lists: readonly TaskList[], id: string, title: string, specs: readonly StepSpec[], now: number): TaskList[] => {
  const prev = lists.find(l => l.id === id)
  let steps: Stage[] = []
  for (const spec of specs) {
    const old = prev?.steps.find(s => s.label === spec.name)
    const base = old ?? step(spec.name, 'pending', now)
    steps = insertAfter(steps, spec.state ? moveStage(base, spec.state, now) : base, spec.after)
  }
  const list: TaskList = { id, title, steps, createdAt: prev?.createdAt ?? now, updatedAt: now }
  const endedAt = listEnd(steps, now)
  if (endedAt !== undefined) list.endedAt = endedAt
  return [...lists.filter(l => l.id !== id), list]
}

/** Sets an agent-owned step's state; throws when the step or its owner is unknown. */
export const setListStep = (lists: readonly TaskList[], id: string, name: string, state: StageState, note: string | undefined, now: number): TaskList[] => {
  const list = lists.find(l => l.id === id)
  if (!list) throw new Error(`no task list "${id}"; declare it with list_set first`)
  if (!list.steps.some(s => s.label === name)) throw new Error(`list "${id}" has no step "${name}" (steps: ${list.steps.map(s => s.label).join(', ')})`)
  const steps = list.steps.map(s => (s.label === name ? moveStage(s, state, now, note === undefined ? {} : { note }) : s))
  const next: TaskList = { ...list, steps, updatedAt: now }
  const endedAt = listEnd(steps, now, list.endedAt)
  if (endedAt === undefined) delete next.endedAt
  else next.endedAt = endedAt
  return lists.map(l => (l.id === id ? next : l))
}

export const newTrack = (repo: string, number: number, now: number): Track => ({
  key: trackKey(repo, number),
  repo,
  number,
  stages: [
    { id: 'pr-ci', label: 'PR CI', owner: 'mod', state: 'pending', startedAt: now },
    { id: 'merged', label: 'merged', owner: 'mod', state: 'pending' },
    { id: 'main-ci', label: 'main CI', owner: 'mod', state: 'pending' },
  ],
  notes: [],
  status: 'active',
  createdAt: now,
  updatedAt: now,
})

const findTrack = (tracks: readonly Track[], key: string) => {
  const t = tracks.find(x => x.key === key)
  if (!t) throw new Error(`${key} is not tracked; track it first`)
  return t
}

const stageOf = (track: Track, ref: string) =>
  track.stages.find(s => s.id === ref || s.label === ref || s.id === `step:${ref}`)

const replaceTrack = (tracks: readonly Track[], next: Track) => tracks.map(t => (t.key === next.key ? next : t))

export const addTrackStep = (tracks: readonly Track[], key: string, name: string, after: string | undefined, now: number): Track[] => {
  const t = findTrack(tracks, key)
  if (stageOf(t, name)) throw new Error(`${key} already has a stage "${name}"`)
  if (after !== undefined && !stageOf(t, after)) throw new Error(`${key} has no stage "${after}" (stages: ${t.stages.map(s => s.id).join(', ')})`)
  const stages = insertAfter(t.stages, step(name, 'pending', now), after)
  return replaceTrack(tracks, { ...t, stages, status: t.status === 'done' ? 'active' : t.status, endedAt: undefined, updatedAt: now })
}

export const setTrackStep = (tracks: readonly Track[], key: string, name: string, state: StageState, note: string | undefined, now: number): Track[] => {
  const t = findTrack(tracks, key)
  const s = stageOf(t, name)
  if (!s) throw new Error(`${key} has no step "${name}"; add it with add_step first`)
  if (s.owner !== 'agent') throw new Error(`"${s.id}" is computed from GitHub; only steps added with add_step can be set`)
  const stages = t.stages.map(x => (x === s ? moveStage(x, state, now, note === undefined ? {} : { note }) : x))
  return replaceTrack(tracks, { ...t, stages, updatedAt: now })
}

export const annotate = (tracks: readonly Track[], key: string, stage: string | undefined, note: string, now: number): Track[] => {
  const t = findTrack(tracks, key)
  if (stage === undefined) return replaceTrack(tracks, { ...t, notes: [...t.notes, note].slice(-5), updatedAt: now })
  const s = stageOf(t, stage)
  if (!s) throw new Error(`${key} has no stage "${stage}" (stages: ${t.stages.map(x => x.id).join(', ')})`)
  return replaceTrack(tracks, { ...t, stages: t.stages.map(x => (x === s ? { ...x, annotation: note } : x)), updatedAt: now })
}
