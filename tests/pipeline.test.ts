import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG, type Config } from '../hooks/lib/config'
import { newTrack } from '../hooks/lib/ops'
import { apply, gather, shapeStages, type Ctx } from '../hooks/lib/pipeline'
import { check, fakeGh, pr, REPO_VIEW, run } from './fixtures/fake-gh'

const NOW = Date.parse('2026-10-18T10:30:00Z')
const ctx = (r: ReturnType<typeof fakeGh>, config: Config = DEFAULT_CONFIG, now = NOW): Ctx => ({ run: r.run, config, now, defaultBranches: new Map(), cache: { logShas: {}, contains: {} } })
const states = (t: { stages: { id: string; state: string }[] }) => t.stages.map(s => `${s.id}:${s.state}`)
const step = async (routes: Array<[string, unknown]>, track = newTrack('o/r', 42, NOW - 60_000), config = DEFAULT_CONFIG) => {
  const gh = fakeGh(routes)
  const facts = await gather(track, ctx(gh, config))
  return { track: apply(track, facts, config, NOW), gh }
}

const MERGED = pr({ state: 'MERGED', mergeCommit: { oid: 'merge2222bbbb' }, mergedAt: '2026-10-18T10:04:00Z', statusCheckRollup: [check('SUCCESS')] })

describe('pr pipeline', () => {
  test('a merged PR whose main CI passed is done within one poll (AC1, no deploys)', async () => {
    const { track } = await step([['pr view 42', MERGED], REPO_VIEW, ['run list --commit merge2222bbbb --branch main --event push', [run(7)]]])
    expect(states(track)).toEqual(['pr-ci:passed', 'merged:passed', 'main-ci:passed'])
    expect(track.status).toBe('done')
    expect(track.endedAt).toBe(NOW)
    expect(track.mergeSha).toBe('merge2222bbbb')
  })

  test('a draft PR with green CI warns that the full suite did not run (AC5)', async () => {
    const { track } = await step([['pr view 42', pr({ isDraft: true, statusCheckRollup: [check('SUCCESS')] })], REPO_VIEW])
    expect(track.stages[0]).toMatchObject({ state: 'warning', note: 'draft: full suite not run' })
    expect(track.status).toBe('active')
  })

  test('a stacked PR whose base merged warns to retarget and runs no gh pr edit (AC6)', async () => {
    const { track, gh } = await step([
      ['pr view 42', pr({ baseRefName: 'feature-a', statusCheckRollup: [check('SUCCESS')] })],
      REPO_VIEW,
      ['pr list --head feature-a --state merged', [{ number: 41 }]],
    ])
    expect(track.stages[1]).toMatchObject({ state: 'warning', note: 'base merged; retarget to main' })
    expect(gh.calls.some(a => a.includes('edit'))).toBe(false)
  })

  test('a push that replaces the PR CI run is followed on the next poll (AC7)', async () => {
    const first = await step([['pr view 42', pr({ statusCheckRollup: [check('FAILURE', 'unit')] })], REPO_VIEW])
    expect(first.track.stages[0]).toMatchObject({ state: 'failed', note: 'CI / unit failed', ref: 'head1111aaaa' })
    const second = await step([['pr view 42', pr({ headRefOid: 'head3333cccc', statusCheckRollup: [check(null, 'unit')] })], REPO_VIEW], first.track)
    expect(second.track.stages[0]).toMatchObject({ state: 'running', ref: 'head3333cccc' })
    expect(second.track.stages[0]!.note).toBeUndefined()
    expect(second.track.headSha).toBe('head3333cccc')
  })

  test('rollup duplicates from reruns keep only the newest attempt', async () => {
    const old = { ...check('FAILURE', 'unit'), startedAt: '2026-10-18T09:00:00Z' }
    const { track } = await step([['pr view 42', pr({ statusCheckRollup: [old, check('SUCCESS', 'unit')] })], REPO_VIEW])
    expect(track.stages[0]!.state).toBe('passed')
  })

  test('a closed, unmerged PR ends the track', async () => {
    const { track } = await step([['pr view 42', pr({ state: 'CLOSED', statusCheckRollup: [check('SUCCESS')] })], REPO_VIEW])
    expect(track.status).toBe('closed')
    expect(track.stages[1]).toMatchObject({ state: 'failed', note: 'closed without merge' })
  })

  test('a configured CI workflow is read by name, and main CI by that workflow on the merge SHA', async () => {
    const cfg: Config = { ...DEFAULT_CONFIG, ci: { workflow: 'CI' } }
    const { track, gh } = await step(
      [['pr view 42', { ...MERGED, statusCheckRollup: [check('SUCCESS'), check('FAILURE', 'lint', 'Other')] }], REPO_VIEW, ['run list --workflow CI --commit merge2222bbbb', [run(8, { status: 'in_progress', conclusion: null })]]],
      newTrack('o/r', 42, NOW),
      cfg,
    )
    expect(states(track)).toEqual(['pr-ci:passed', 'merged:passed', 'main-ci:running'])
    expect(gh.calls.find(a => a.includes('run'))).toContain('--workflow')
  })

  test('a merged PR with failing PR CI skips that stage instead of blocking', async () => {
    const { track } = await step([['pr view 42', { ...MERGED, statusCheckRollup: [check(null)] }], REPO_VIEW, ['run list', [run(7)]]])
    expect(track.stages[0]).toMatchObject({ state: 'skipped', note: 'merged before PR CI passed' })
  })

  test('with no CI config and no push run ten minutes after merge, main CI is skipped', async () => {
    const { track } = await step([['pr view 42', MERGED], REPO_VIEW, ['run list', [run(9, { event: 'workflow_run' })]]])
    expect(track.stages[2]).toMatchObject({ state: 'skipped', note: 'no CI ran on main' })
  })

  test('a configured workflow GitHub lacks is a warning on that stage, not a gh outage', async () => {
    const cfg: Config = { ...DEFAULT_CONFIG, ci: { workflow: 'CI' } }
    const { track } = await step([['pr view 42', MERGED], REPO_VIEW, ['run list --workflow CI', new Error('could not find any workflows named CI')]], newTrack('o/r', 42, NOW), cfg)
    expect(track.stages[0]!.state).toBe('passed') // PR CI by name comes from the rollup, with no run list
    expect(track.stages[2]).toMatchObject({ state: 'warning', note: 'no workflow "CI" on GitHub' })
  })

  test('gh failures surface as a short GhError', async () => {
    const gh = fakeGh([['pr view', new Error('HTTP 403: API rate limit exceeded for user\nmore')]])
    await expect(gather(newTrack('o/r', 42, NOW), ctx(gh))).rejects.toThrow('HTTP 403: API rate limit exceeded for user')
  })

  test('agent steps keep their place when the config changes', () => {
    const t = newTrack('o/r', 1, 0)
    t.stages.splice(2, 0, { id: 'step:smoke', label: 'smoke', owner: 'agent', state: 'pending' })
    const cfg: Config = { ...DEFAULT_CONFIG, deploys: [{ name: 'web', workflow: 'D', deployedSha: { from: 'headSha' }, timeoutMinutes: 45 }] }
    expect(shapeStages(t.stages, cfg).map(s => s.id)).toEqual(['pr-ci', 'merged', 'step:smoke', 'main-ci', 'deploy:web'])
  })
})
