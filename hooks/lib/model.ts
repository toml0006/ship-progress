import type { Stage, StageState, TaskList, Track } from '../../types'

export const PLUGIN = 'ship-progress'
export const DEFAULT_LINGER_MS = 10 * 60_000

export const isSettled = (state: StageState) => state === 'passed' || state === 'skipped'

/** The stage the track is waiting on: the first one that has not passed. */
export const currentStage = (stages: readonly Stage[]): Stage | undefined =>
  stages.find(s => !isSettled(s.state))

export const PIPS: Record<StageState, string> = {
  passed: '■',
  skipped: '↷',
  running: '▣',
  pending: '□',
  warning: '▣',
  failed: '✕',
  superseded: '↷',
}

/** Theme keys, so the bar follows the person's theme. Undefined means dim. */
export const COLORS: Record<StageState, 'success' | 'warning' | 'error' | undefined> = {
  passed: 'success',
  skipped: 'success',
  running: 'warning',
  warning: 'warning',
  failed: 'error',
  pending: undefined,
  superseded: undefined,
}

export const shortSha = (sha: string | undefined) => (sha ? sha.slice(0, 8) : '')

export const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${String(m % 60).padStart(2, '0')}`
}

/** A piece of a bar line: text, and the theme color it is drawn in (none = plain, dim = dimmed). */
export type Segment = { text: string; color?: 'success' | 'warning' | 'error'; dim?: boolean; bold?: boolean }

const VERB: Partial<Record<StageState, string>> = {
  running: 'running',
  pending: 'waiting',
  failed: 'failed',
  warning: '',
  superseded: 'superseded',
}

const stageWords = (stage: Stage) => {
  if (stage.id === 'merged') return stage.state === 'pending' ? 'awaiting merge' : `merge ${VERB[stage.state] ?? ''}`.trim()
  if (stage.id.startsWith('deploy:') && stage.state === 'running') return `deploying (${stage.label})`
  const verb = VERB[stage.state]
  return verb ? `${stage.label} ${verb}` : stage.label
}

const pips = (stages: readonly Stage[]): Segment[] =>
  stages.map(s => ({ text: PIPS[s.state], color: COLORS[s.state], dim: COLORS[s.state] === undefined }))

/** The status words of a track or list whose stages are `stages`, and their color. */
const status = (stages: readonly Stage[], isClosed: boolean, now: number): Segment[] => {
  if (isClosed) return [{ text: 'closed', color: 'error' }]
  const stage = currentStage(stages)
  if (!stage) return [{ text: 'live', color: 'success', bold: true }]
  const out: Segment[] = [{ text: stageWords(stage), color: COLORS[stage.state], dim: COLORS[stage.state] === undefined }]
  if (stage.startedAt !== undefined && (stage.state === 'running' || stage.state === 'pending')) {
    out.push({ text: elapsed(now - stage.startedAt), dim: true })
  }
  return out
}

/** The first warning or failure note among the stages, for the ` ⚠ <warning>` suffix. */
const warningOf = (stages: readonly Stage[]) =>
  stages.find(s => (s.state === 'warning' || s.state === 'failed') && s.note)?.note

export const trackLine = (track: Track, now: number, repo: string | null): Segment[] => {
  const name = track.repo === repo ? `#${track.number}` : `${track.repo}#${track.number}`
  const out: Segment[] = [{ text: name, bold: true }, ...pips(track.stages)]
  out.push(...status(track.stages, track.status === 'closed', now))
  const sha = track.deployedSha ?? track.mergeSha ?? track.headSha
  if (sha) out.push({ text: shortSha(sha), dim: true })
  if (track.status === 'done' && track.stages.some(s => s.id.startsWith('check:'))) out.splice(out.length - 1, 0, { text: 'checks ✓', color: 'success' })
  const warning = warningOf(track.stages)
  if (warning) out.push({ text: `⚠ ${warning}`, color: 'warning' })
  return out
}

export const listLine = (list: TaskList, now: number): Segment[] => {
  const done = list.steps.filter(s => isSettled(s.state)).length
  const out: Segment[] = [{ text: list.title, bold: true }, ...pips(list.steps)]
  out.push(...status(list.steps, false, now))
  out.push({ text: `${done}/${list.steps.length}`, dim: true })
  const warning = warningOf(list.steps)
  if (warning) out.push({ text: `⚠ ${warning}`, color: 'warning' })
  return out
}

/** Pips are one glyph each and sit together; every other segment is space-separated. */
export const joinSegments = (segments: readonly Segment[]): Segment[] => {
  const out: Segment[] = []
  segments.forEach((seg, i) => {
    const prev = segments[i - 1]
    const isPip = seg.text.length === 1 && Object.values(PIPS).includes(seg.text)
    const prevIsPip = prev !== undefined && prev.text.length === 1 && Object.values(PIPS).includes(prev.text)
    if (i > 0 && !(isPip && prevIsPip)) out.push({ text: isPip ? ' ' : prevIsPip ? '  ' : ' ' })
    out.push(seg)
  })
  return out
}

export const plainLine = (segments: readonly Segment[]) => joinSegments(segments).map(s => s.text).join('')

/** `608`, `#608`, `owner/repo#608` or a PR URL, read against the session's repo. */
export const parsePr = (raw: unknown, repo: string | null): { repo: string; number: number } | { error: string } => {
  const text = String(raw ?? '').trim()
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(text)
  if (url) return { repo: url[1]!, number: Number(url[2]) }
  const full = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text)
  if (full) return { repo: full[1]!, number: Number(full[2]) }
  const bare = /^#?(\d+)$/.exec(text)
  if (bare) {
    if (!repo) return { error: `can't tell which repo PR ${text} is in; use owner/repo#${bare[1]}` }
    return { repo, number: Number(bare[1]) }
  }
  return { error: `not a PR reference: "${text}" (use 608, #608, owner/repo#608 or a PR URL)` }
}

export const trackKey = (repo: string, number: number) => `${repo}#${number}`

/** `owner/repo` from a GitHub remote URL (ssh or https), or null. */
export const repoFromRemote = (remote: string | null | undefined) => {
  const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote ?? '')
  return m ? m[1]! : null
}

/** Inserts `stage` after the stage whose id or label is `after`, or at the end. */
export const insertAfter = (stages: readonly Stage[], stage: Stage, after?: string) => {
  const i = after === undefined ? -1 : stages.findIndex(s => s.id === after || s.label === after || s.id === `step:${after}`)
  return i < 0 ? [...stages, stage] : [...stages.slice(0, i + 1), stage, ...stages.slice(i + 1)]
}

/** Stamps start and end times on a stage moving to `state`. */
export const moveStage = (stage: Stage, state: StageState, now: number, extra: Partial<Stage> = {}): Stage => {
  const next: Stage = { ...stage, ...extra, state }
  if (state !== stage.state) {
    if (state === 'running' || (stage.startedAt === undefined && state !== 'pending')) next.startedAt ??= now
    if (isSettled(state) || state === 'failed') next.endedAt = now
    else delete next.endedAt
  }
  return next
}
