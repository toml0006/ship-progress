import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Meta, TaskList, Track } from '../types'
import { INPUT_SCHEMA, parseInput, type ToolInput } from './lib/input'
import { isShown, joinSegments, listLine, parsePr, plainLine, repoFromRemote, trackLine, type Segment } from './lib/model'
import { checksHash } from './lib/checks'
import { DEFAULT_CONFIG, parseConfig, type Config } from './lib/config'
import { GhError, type Runner } from './lib/gh'
import { addTrackStep, annotate, emptyPersisted, listSet, migrate, newTrack, setListStep, setTrackStep, sweep, type Persisted } from './lib/ops'
import { apply, gather, shapeStages } from './lib/pipeline'

const tracksAtom = atom({ plugin: 'ship-progress', key: 'tracks' } as const, [])
const listsAtom = atom({ plugin: 'ship-progress', key: 'lists' } as const, [])
const metaAtom = atom({ plugin: 'ship-progress', key: 'meta' } as const, { repo: null, ghError: null, configError: null, now: 0 })

const TOOL = 'mcp__ship-progress__ship_progress'
const MAX_LINES = 5
const TICK_MS = 5_000
const RUNNING_MS = 20_000
const PENDING_MS = 60_000
const MAX_BACKOFF_MS = 5 * 60_000
const TRACKS_PER_TICK = 4
const GH_TIMEOUT_MS = 8_000

type $ = EngineInterface

// The source of truth for this session's repo; mirrored to $.state for drawing
// and to $.store for the next session. Reloaded from the store on every load.
let p: Persisted = emptyPersisted()
let storeKey = 'repo:-'
let repo: string | null = null
let config: Config = DEFAULT_CONFIG
let configPath: string | null = null
let configMtime = -1
/** The hash of the config's checks; matches p.trust once the person ran /ship-progress trust. */
let checksDigest = ''
let repoRoot: string | null = null
const checkLastRun: Record<string, number> = {}

// Polling: when the next poll is due, the interval after a gh error, and the round-robin cursor.
let nextPollAt = 0
let backoffMs = 0
let cursor = 0
let isPolling = false
const defaultBranches = new Map<string, string>()

/** Config applies to the session's own repo; tracks in other repos get the defaults. */
const configFor = (r: string) => (r === repo ? config : DEFAULT_CONFIG)

function runner($: $): Runner {
  return (argv, opts) => $.process.run(argv, { timeoutMs: opts?.timeoutMs ?? GH_TIMEOUT_MS })
}

/** Reads `.claude/ship-progress.json` when its mtime changed; a bad file falls back to the defaults and says why. */
async function loadConfig($: $) {
  if (!configPath) return
  const stat = await $.fs.stat(configPath).catch(() => undefined)
  const mtime = stat?.mtimeMs ?? 0
  if (mtime === configMtime) return
  configMtime = mtime
  let error: string | null = null
  try {
    config = stat ? parseConfig(await $.fs.read(configPath)) : DEFAULT_CONFIG
    checksDigest = await checksHash(config.checks)
  } catch (err) {
    config = DEFAULT_CONFIG
    error = `${configPath.split('/').slice(-2).join('/')}: ${err instanceof Error ? err.message : String(err)}`
  }
  await setMeta($, { configError: error })
  nextPollAt = 0
}

function now($: $) {
  return $.clock.now()
}

/** Applies `fn` to the persisted state, then mirrors it to $.state and $.store. */
const commit = async ($: $, fn: (p: Persisted) => Persisted) => {
  p = fn(p)
  const snapshot = p
  await Promise.all([
    update($, tracksAtom, () => snapshot.tracks),
    update($, listsAtom, () => snapshot.lists),
    $.store.set(storeKey, snapshot),
  ])
}

function setMeta($: $, patch: Partial<Meta>) {
  return update($, metaAtom, m => ({ ...m, ...patch }))
}

async function tick($: $) {
  const t = await now($)
  const shown = p.tracks.some(x => isShown(x, t)) || p.lists.some(x => isShown(x, t))
  const swept = sweep(p, t)
  if (swept.tracks.length !== p.tracks.length || swept.lists.length !== p.lists.length) await commit($, () => swept)
  // Redraw elapsed times only while something is on the bar.
  if (shown) await setMeta($, { now: t })
  await loadConfig($)
  if (t >= nextPollAt && !isPolling) {
    isPolling = true
    try {
      await poll($, t)
    } finally {
      isPolling = false
    }
  }
}

/** Polls up to TRACKS_PER_TICK active tracks, round-robin, then schedules the next poll. */
async function poll($: $, t: number) {
  const active = p.tracks.filter(x => x.status === 'active')
  if (active.length === 0) {
    nextPollAt = Number.POSITIVE_INFINITY
    return
  }
  const batch = Array.from({ length: Math.min(TRACKS_PER_TICK, active.length) }, (_, i) => active[(cursor + i) % active.length]!)
  cursor = (cursor + batch.length) % Math.max(1, active.length)
  const run = runner($)
  const cache = { logShas: { ...p.logShas }, contains: { ...p.contains } }
  try {
    for (const track of batch) {
      const cfg = configFor(track.repo)
      const checks = track.repo === repo && repoRoot ? { isTrusted: p.trust === checksDigest, cwd: repoRoot, lastRun: checkLastRun } : undefined
      const facts = await gather(track, { run, config: cfg, now: t, defaultBranches, localRepo: repo, cache, checks })
      await commit($, x => ({ ...x, logShas: cache.logShas, contains: cache.contains, tracks: x.tracks.map(y => (y.key === track.key ? apply(y, facts, cfg, t) : y)) }))
    }
    backoffMs = 0
    await setMeta($, { ghError: null })
  } catch (err) {
    if (!(err instanceof GhError)) throw err
    backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(RUNNING_MS, backoffMs) * 2)
    await setMeta($, { ghError: err.message })
  }
  const isRunning = p.tracks.some(x => x.status === 'active' && x.stages.some(s => s.state === 'running'))
  nextPollAt = t + (backoffMs || (isRunning ? RUNNING_MS : PENDING_MS))
}

/** Starts following a PR; the next tick polls it. */
async function startTrack($: $, ref: string) {
  const r = parsePr(ref, repo)
  if ('error' in r) throw new Error(r.error)
  const key = `${r.repo}#${r.number}`
  if (p.tracks.some(x => x.key === key)) return `${key} is already tracked`
  const t = await now($)
  const track = { ...newTrack(r.repo, r.number, t) }
  track.stages = shapeStages(track.stages, configFor(r.repo))
  await commit($, x => ({ ...x, tracks: [...x.tracks, track] }))
  nextPollAt = 0
  return `tracking ${key}`
}

async function stopTrack($: $, ref: string) {
  const r = parsePr(ref, repo)
  if ('error' in r) throw new Error(r.error)
  const key = `${r.repo}#${r.number}`
  const track = p.tracks.find(x => x.key === key)
  if (!track) return `${key} is not tracked`
  const t = await now($)
  await commit($, x => ({
    ...x,
    tracks: x.tracks.filter(y => y.key !== key),
    history: [...x.history, { key, title: track.title, status: 'untracked', sha: track.mergeSha, endedAt: t }],
  }))
  return `stopped tracking ${key}`
}

/** `/track` with no argument: what is tracked now, and what shipped in the last 7 days. */
async function listing($: $) {
  const t = await now($)
  const lines = p.tracks.map(x => plainLine(trackLine(x, t, repo)))
  const recent = [...p.history].reverse().slice(0, 10).map(h => `  ${h.key} ${h.status}${h.sha ? ` ${h.sha.slice(0, 8)}` : ''}${h.title ? `  ${h.title}` : ''}`)
  return [
    lines.length ? lines.join('\n') : 'no PRs tracked (/track <PR#>)',
    ...(recent.length ? ['recent:', ...recent] : []),
  ].join('\n')
}

async function runTool($: $, input: ToolInput): Promise<string> {
  const t = await now($)
  const pr = (raw: string) => {
    const r = parsePr(raw, repo)
    if ('error' in r) throw new Error(r.error)
    return `${r.repo}#${r.number}`
  }
  switch (input.action) {
    case 'list_set':
      await commit($, x => ({ ...x, lists: listSet(x.lists, input.list, input.title, input.steps, t) }))
      return `ok: list "${input.list}" has ${input.steps.length} steps`
    case 'set_step':
      if (input.list !== undefined) {
        const list = input.list
        await commit($, x => ({ ...x, lists: setListStep(x.lists, list, input.name, input.state, input.note, t) }))
      } else {
        const key = pr(input.pr!)
        await commit($, x => ({ ...x, tracks: setTrackStep(x.tracks, key, input.name, input.state, input.note, t) }))
      }
      return `ok: ${input.name} → ${input.state}`
    case 'add_step': {
      const key = pr(input.pr)
      await commit($, x => ({ ...x, tracks: addTrackStep(x.tracks, key, input.name, input.after, t) }))
      return `ok: added step "${input.name}" to ${key}`
    }
    case 'annotate': {
      const key = pr(input.pr)
      await commit($, x => ({ ...x, tracks: annotate(x.tracks, key, input.stage, input.note, t) }))
      return `ok: noted on ${key}${input.stage ? ` (${input.stage})` : ''}`
    }
    case 'status':
      return JSON.stringify({ repo, tracks: p.tracks, lists: p.lists, history: p.history }, null, 1)
    case 'track':
    case 'untrack':
      throw new Error(`"${input.action}" is not available yet`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const r = await $.session.repo()
    repo = repoFromRemote(r?.remote)
    repoRoot = r?.root ?? null
    // SHIP_PROGRESS_CONFIG points at a config outside the repo, to try one before committing it.
    configPath = (await $.env.get('SHIP_PROGRESS_CONFIG')) || (r ? `${r.root}/.claude/ship-progress.json` : null)
    configMtime = -1
    config = DEFAULT_CONFIG
    storeKey = `repo:${repo ?? '-'}`
    p = sweep(migrate(await $.store.get(storeKey)), await now($))
    nextPollAt = 0
    await commit($, x => x)
    await setMeta($, { repo, ghError: null, configError: null, now: await now($) })
    await loadConfig($)

    await $.tool.register({
      name: 'ship_progress',
      description:
        'Track pull requests to production and show task progress in the bar above the prompt. ' +
        'The mod polls GitHub itself (PR CI → merged → main CI → deploys → checks) and wakes you when a stage fails or a PR goes live, ' +
        'so do not poll gh yourself for tracked PRs: call action "status" instead. ' +
        'Actions: track {pr}; untrack {pr}; annotate {pr, stage?, note}; add_step {pr, name, after?} adds a step you own to a PR; ' +
        'set_step {pr|list, name, state, note?} sets one of your steps; list_set {list, title, steps:[{name, state?, after?}]} declares a task list with no GitHub involvement; ' +
        'status {} returns every track and list as JSON. Watch only: it never merges, reruns or edits anything.',
      inputSchema: INPUT_SCHEMA,
    })
    await $.command.register({ name: 'track', description: 'ship-progress: follow a PR to production, or list tracked PRs', argumentHint: '[PR#|url]' })
    await $.command.register({ name: 'untrack', description: 'ship-progress: stop following a PR', argumentHint: '<PR#>' })
    await $.command.register({ name: 'ship-progress', description: 'ship-progress: show status, trust this repo\'s checks, or clear task lists', argumentHint: '[status|trust|clear]' })

    $.clock.every(TICK_MS, () => void tick($).catch(err => $.ui.log(`ship-progress tick failed: ${String(err)}`, { to: 'debug' })))
    return started
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    try {
      return { result: await runTool($, parseInput(e)) }
    } catch (err) {
      return { result: `error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('command.run', { command: 'track' }, async ($, e) => {
    const arg = e.args.trim()
    try {
      return { text: arg ? await startTrack($, arg) : await listing($) }
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err) }
    }
  })

  on('command.run', { command: 'untrack' }, async ($, e) => {
    try {
      return { text: await stopTrack($, e.args.trim()) }
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err) }
    }
  })

  on('command.run', { command: 'ship-progress' }, async ($, e) => {
    const [sub = 'status'] = e.args.trim().split(/\s+/).filter(Boolean)
    if (sub === 'trust') {
      // Checks run commands from a committed file: only the person, typing at their own prompt, approves them.
      const who = e.origin?.kind
      if (who !== 'composer' && who !== 'bridge') return { text: 'only the person at the prompt can trust checks: type /ship-progress trust' }
      if (config.checks.length === 0) return { text: 'this repo configures no checks' }
      await commit($, x => ({ ...x, trust: checksDigest }))
      nextPollAt = 0
      const list = config.checks.map(c => `  ${c.name}: ${JSON.stringify(c.argv)}${c.env ? ` env ${JSON.stringify(Object.keys(c.env))}` : ''}`)
      return { text: [`trusted ${config.checks.length} check(s) for ${repo ?? 'this repo'}; any change to them asks again:`, ...list].join('\n') }
    }
    if (sub === 'clear') {
      const n = p.lists.length
      await commit($, x => ({ ...x, lists: [] }))
      return { text: `cleared ${n} task list(s); PR tracks are kept (use /untrack)` }
    }
    if (sub !== 'status') return { text: `unknown subcommand "${sub}" (status, trust, clear)` }
    const t = await now($)
    const lines = [...p.tracks.map(x => trackLine(x, t, repo)), ...p.lists.map(x => listLine(x, t))]
    return { text: lines.length ? lines.map(plainLine).join('\n') : 'nothing tracked' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [tracks, lists, meta] = await Promise.all([read($, tracksAtom), read($, listsAtom), read($, metaAtom)])
    if (e.props.hasSurvey) return next(e)
    const t = meta.now
    const items: { at: number; line: Segment[] }[] = [
      ...tracks.filter((x: Track) => isShown(x, t)).map((x: Track) => ({ at: x.updatedAt, line: trackLine(x, t, meta.repo) })),
      ...lists.filter((x: TaskList) => isShown(x, t)).map((x: TaskList) => ({ at: x.updatedAt, line: listLine(x, t) })),
    ].sort((a, b) => b.at - a.at)
    if (items.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const rows = items.slice(0, MAX_LINES).map(i => i.line)
    if (meta.ghError) rows.push([{ text: `⚠ gh: ${meta.ghError}`, color: 'warning' }])
    if (meta.configError) rows.push([{ text: `⚠ ${meta.configError}`, color: 'warning' }])
    return (
      <Box flexDirection="column">
        {rows.map((line, r) => (
          <Text key={`l${r}`} wrap="truncate-end">
            {joinSegments(line).map((s, i) => (
              <Text key={`s${i}`} color={s.color} dimColor={s.dim} bold={s.bold}>
                {s.text}
              </Text>
            ))}
          </Text>
        ))}
        {items.length > MAX_LINES && <Text dimColor>+{items.length - MAX_LINES} more</Text>}
      </Box>
    )
  })
}
