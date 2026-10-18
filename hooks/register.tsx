import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Meta, TaskList, Track } from '../types'
import { INPUT_SCHEMA, parseInput, type ToolInput } from './lib/input'
import { isShown, joinSegments, listLine, parsePr, plainLine, repoFromRemote, trackLine, type Segment } from './lib/model'
import { addTrackStep, annotate, emptyPersisted, listSet, migrate, setListStep, setTrackStep, sweep, type Persisted } from './lib/ops'

const tracksAtom = atom({ plugin: 'ship-progress', key: 'tracks' } as const, [])
const listsAtom = atom({ plugin: 'ship-progress', key: 'lists' } as const, [])
const metaAtom = atom({ plugin: 'ship-progress', key: 'meta' } as const, { repo: null, ghError: null, now: 0 })

const TOOL = 'mcp__ship-progress__ship_progress'
const MAX_LINES = 5
const TICK_MS = 5_000

type $ = EngineInterface

// The source of truth for this session's repo; mirrored to $.state for drawing
// and to $.store for the next session. Reloaded from the store on every load.
let p: Persisted = emptyPersisted()
let storeKey = 'repo:-'
let repo: string | null = null

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
    repo = repoFromRemote((await $.session.repo())?.remote)
    storeKey = `repo:${repo ?? '-'}`
    p = sweep(migrate(await $.store.get(storeKey)), await now($))
    await commit($, x => x)
    await setMeta($, { repo, ghError: null, now: await now($) })

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
    await $.command.register({ name: 'ship-progress', description: 'ship-progress: show status, or clear task lists', argumentHint: '[status|clear]' })

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

  on('command.run', { command: 'ship-progress' }, async ($, e) => {
    const [sub = 'status'] = e.args.trim().split(/\s+/).filter(Boolean)
    if (sub === 'clear') {
      const n = p.lists.length
      await commit($, x => ({ ...x, lists: [] }))
      return { text: `ship-progress: cleared ${n} task list(s); PR tracks are kept (use /untrack)` }
    }
    if (sub !== 'status') return { text: `ship-progress: unknown subcommand "${sub}" (status, clear)` }
    const t = await now($)
    const lines = [...p.tracks.map(x => trackLine(x, t, repo)), ...p.lists.map(x => listLine(x, t))]
    return { text: lines.length ? lines.map(plainLine).join('\n') : 'ship-progress: nothing tracked' }
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
