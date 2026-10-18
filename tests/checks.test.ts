import { describe, expect, test } from 'claude-code/testing'

import { checksHash, substitute } from '../hooks/lib/checks'
import { parseConfig } from '../hooks/lib/config'
import { newTrack } from '../hooks/lib/ops'
import { apply, gather, shapeStages, type Ctx } from '../hooks/lib/pipeline'
import type { Track } from '../types'
import { check, fakeGh, pr, REPO_VIEW, run } from './fixtures/fake-gh'

const T0 = Date.parse('2026-10-18T10:30:00Z')
const MERGE = 'abc1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const CFG = parseConfig(JSON.stringify({
  version: 1,
  ci: { workflow: 'CI' },
  deploys: [{ name: 'web', workflow: 'Deploy web', deployedSha: { from: 'headSha' } }],
  checks: [{ name: 'drained', argv: ['./scripts/drained.sh', '{mergeSha}', '{deployedSha:web}', '--pr', '{prNumber}'], intervalSeconds: 60, timeoutMinutes: 20 }],
}))

const ROUTES: Array<[string, unknown]> = [
  ['pr view 42', pr({ state: 'MERGED', mergeCommit: { oid: MERGE }, mergedAt: '2026-10-18T10:00:00Z', statusCheckRollup: [check('SUCCESS')] })],
  REPO_VIEW,
  ['run list --workflow CI', [run(1, { headSha: MERGE })]],
  ['run list --workflow Deploy web', [run(2, { workflowName: 'Deploy web', headSha: MERGE })]],
]

/** A world where the check script exits with the codes given, in turn. */
const world = (exits: number[]) => {
  const gh = fakeGh(ROUTES)
  const scripts: string[][] = []
  const runner: Ctx['run'] = async (argv, opts) => {
    if (argv[0] !== './scripts/drained.sh') return gh.run(argv)
    scripts.push([...argv, `cwd=${opts?.cwd}`])
    const code = exits.shift() ?? 0
    return { exitCode: code, stdout: '', stderr: code ? 'queue not empty: 3 messages' : '' }
  }
  return { runner, scripts }
}

const poll = async (track: Track, w: ReturnType<typeof world>, now: number, isTrusted: boolean, lastRun: Record<string, number>) => {
  const ctx: Ctx = { run: w.runner, config: CFG, now, defaultBranches: new Map(), cache: { logShas: {}, contains: {} }, checks: { isTrusted, cwd: '/repo', lastRun } }
  return apply(track, await gather(track, ctx), CFG, now)
}

const fresh = () => {
  const t = newTrack('o/r', 42, T0)
  t.stages = shapeStages(t.stages, CFG)
  return t
}
const drained = (t: Track) => t.stages.find(s => s.id === 'check:drained')!

describe('custom checks (AC8)', () => {
  test('checks do not run before the person trusts them', async () => {
    const w = world([0])
    const t = await poll(fresh(), w, T0, false, {})
    expect(w.scripts.length).toBe(0)
    expect(drained(t)).toMatchObject({ state: 'warning', note: 'checks not trusted: type /ship-progress trust' })
    // Waiting on the person never times out.
    expect(drained(await poll(t, w, T0 + 60 * 60_000, false, {})).state).toBe('warning')
  })

  test('a failing check retries on its interval, then turns green on exit 0; placeholders fill whole elements', async () => {
    const w = world([1, 1, 0])
    const lastRun = {}
    let t = await poll(fresh(), w, T0, true, lastRun)
    expect(drained(t)).toMatchObject({ state: 'running', note: 'exit 1: queue not empty: 3 messages' })
    t = await poll(t, w, T0 + 20_000, true, lastRun) // not due: interval is 60 s
    expect(w.scripts.length).toBe(1)
    t = await poll(t, w, T0 + 60_000, true, lastRun)
    t = await poll(t, w, T0 + 120_000, true, lastRun)
    expect(drained(t).state).toBe('passed')
    expect(t.status).toBe('done')
    expect(w.scripts[0]).toEqual(['./scripts/drained.sh', MERGE, MERGE, '--pr', '42', 'cwd=/repo'])
  })

  test('a check still failing at its timeout turns red', async () => {
    const w = world(Array(100).fill(1))
    const lastRun = {}
    let t = await poll(fresh(), w, T0, true, lastRun)
    t = await poll(t, w, T0 + 21 * 60_000, true, lastRun)
    expect(drained(t)).toMatchObject({ state: 'failed', note: 'still failing after 20 min (exit 1: queue not empty: 3 messages)' })
  })

  test('substitution refuses unknown or unresolved placeholders', () => {
    const t = { ...newTrack('o/r', 7, 0), mergeSha: 'm1' }
    expect(substitute(['x', '{repo}', '{prNumber}', 'a{mergeSha}b'], t)).toEqual(['x', 'o/r', '7', 'a{mergeSha}b'])
    expect(() => substitute(['{nope}'], t)).toThrow('unknown placeholder {nope}')
    expect(() => substitute(['{deployedSha:web}'], t)).toThrow('{deployedSha:web} has no value yet')
  })

  test('the trust hash changes when the checks change', async () => {
    const a = await checksHash(CFG.checks)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await checksHash([{ ...CFG.checks[0]!, argv: ['other'] }])).not.toBe(a)
  })
})
