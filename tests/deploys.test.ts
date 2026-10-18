import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG, parseConfig, type Config } from '../hooks/lib/config'
import { newTrack } from '../hooks/lib/ops'
import { apply, gather, lastMatch, shapeStages, type Ctx } from '../hooks/lib/pipeline'
import type { Track } from '../types'
import { check, fakeGh, pr, REPO_VIEW, run } from './fixtures/fake-gh'
import { DEPLOY_WEB_LOG, LOG_WITHOUT_SHA } from './fixtures/logs'

const NOW = Date.parse('2026-10-18T10:30:00Z')
const MERGE = 'abc1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const MERGED = pr({ state: 'MERGED', mergeCommit: { oid: MERGE }, mergedAt: '2026-10-18T10:00:00Z', statusCheckRollup: [check('SUCCESS')] })

/** The spec's worked example (§6): CI, then two workflow_run deploys read from their logs. */
const WORKED = parseConfig(JSON.stringify({
  version: 1,
  ci: { workflow: 'CI' },
  deploys: [
    { name: 'web', workflow: 'Deploy web (staging)', deployedSha: { from: 'log', pattern: 'HEAD is now at (\\w+)' } },
    { name: 'infra', workflow: 'Deploy infra (staging)', deployedSha: { from: 'log', pattern: 'HEAD is now at (\\w+)' } },
  ],
}))

const deployRun = (id: number, over: Record<string, unknown> = {}) =>
  run(id, { workflowName: 'Deploy web (staging)', event: 'workflow_run', headSha: 'tip9999', createdAt: '2026-10-18T10:10:00Z', ...over })

const ctxOf = (gh: ReturnType<typeof fakeGh>, config: Config, cache = { logShas: {} as Record<string, string>, contains: {} as Record<string, boolean> }, now = NOW): Ctx =>
  ({ run: gh.run, config, now, defaultBranches: new Map(), cache, localRepo: null })

const poll = async (track: Track, routes: Array<[string, unknown]>, config = WORKED, cache?: Ctx['cache'], now = NOW) => {
  const gh = fakeGh(routes)
  const ctx = ctxOf(gh, config, cache, now)
  return { track: apply(track, await gather(track, ctx), config, now), gh, cache: ctx.cache }
}

const fresh = (config = WORKED) => {
  const t = newTrack('o/r', 42, NOW - 30 * 60_000)
  t.stages = shapeStages(t.stages, config)
  return t
}

const base: Array<[string, unknown]> = [['pr view 42', MERGED], REPO_VIEW, ['run list --workflow CI --commit', [run(1, { headSha: MERGE })]]]

describe('deploy stages', () => {
  test('a cancelled run is superseded; the later run whose log SHA contains the merge passes (AC3)', async () => {
    const first = await poll(fresh(), [
      ...base,
      ['run list --workflow Deploy web (staging)', [deployRun(10, { conclusion: 'cancelled' })]],
      ['run list --workflow Deploy infra (staging)', []],
    ])
    expect(first.track.stages.find(s => s.id === 'deploy:web')).toMatchObject({ state: 'superseded', note: 'run 10 cancelled; waiting for a later run' })

    const second = await poll(first.track, [
      ...base,
      ['run list --workflow Deploy web (staging)', [deployRun(11), deployRun(10, { conclusion: 'cancelled' })]],
      ['run view 11 --repo o/r --log', DEPLOY_WEB_LOG],
      ['api repos/o/r/compare/' + MERGE + '...def5678', 'ahead\n'],
      ['run list --workflow Deploy infra (staging)', []],
    ])
    expect(second.track.stages.find(s => s.id === 'deploy:web')).toMatchObject({ state: 'passed', sha: 'def5678', ref: '11' })
    expect(second.track.deployedSha).toBe('def5678')
  })

  test('a workflow_run deploy is judged by its log SHA, not its headSha (AC4)', async () => {
    const { track, gh } = await poll(fresh(), [
      ...base,
      // headSha tip9999 would not contain the merge; the log says def5678, which does.
      ['run list --workflow Deploy web (staging)', [deployRun(11)]],
      ['run view 11 --repo o/r --log', DEPLOY_WEB_LOG],
      ['api repos/o/r/compare/' + MERGE + '...def5678', 'ahead'],
      ['api repos/o/r/compare/' + MERGE + '...tip9999', 'behind'],
      ['run list --workflow Deploy infra (staging)', []],
    ])
    expect(track.stages.find(s => s.id === 'deploy:web')).toMatchObject({ state: 'passed', sha: 'def5678' })
    expect(gh.calls.some(a => a.join(' ').includes('tip9999'))).toBe(false)
    expect(lastMatch(DEPLOY_WEB_LOG, 'HEAD is now at (\\w+)')).toBe('def5678')
  })

  test('a run log is read once; its SHA is cached by run id', async () => {
    const routes: Array<[string, unknown]> = [
      ...base,
      ['run list --workflow Deploy web (staging)', [deployRun(12, { status: 'in_progress', conclusion: null }), deployRun(11)]],
      ['run view 11 --repo o/r --log', DEPLOY_WEB_LOG],
      ['api repos/o/r/compare', 'behind'],
      ['run list --workflow Deploy infra (staging)', []],
    ]
    const first = await poll(fresh(), routes)
    expect(first.track.stages.find(s => s.id === 'deploy:web')!.state).toBe('running')
    expect(first.cache.logShas).toEqual({ '11': 'def5678' })
    const second = await poll(first.track, routes, WORKED, first.cache)
    expect(second.gh.calls.some(a => a.includes('--log'))).toBe(false)
    expect(second.gh.calls.some(a => a[1]?.startsWith('repos/'))).toBe(false)
  })

  test('only a failure whose deployed SHA contains the merge fails the stage', async () => {
    const older = await poll(fresh(), [
      ...base,
      ['run list --workflow Deploy web (staging)', [deployRun(13, { conclusion: 'failure' })]],
      ['run view 13', DEPLOY_WEB_LOG],
      ['api repos/o/r/compare', 'behind'],
      ['run list --workflow Deploy infra (staging)', []],
    ])
    expect(older.track.stages.find(s => s.id === 'deploy:web')!.state).toBe('pending')

    const ours = await poll(fresh(), [
      ...base,
      ['run list --workflow Deploy web (staging)', [deployRun(13, { conclusion: 'failure' })]],
      ['run view 13', DEPLOY_WEB_LOG],
      ['api repos/o/r/compare', 'identical'],
      ['run list --workflow Deploy infra (staging)', []],
    ])
    expect(ours.track.stages.find(s => s.id === 'deploy:web')).toMatchObject({ state: 'failed', note: 'run 13 failed' })

    const blind = await poll(fresh(), [
      ...base,
      ['run list --workflow Deploy web (staging)', [deployRun(14, { conclusion: 'failure' })]],
      ['run view 14', LOG_WITHOUT_SHA],
      ['run list --workflow Deploy infra (staging)', []],
    ])
    expect(blind.track.stages.find(s => s.id === 'deploy:web')).toMatchObject({ state: 'warning', note: 'run 14 failed before reporting a SHA' })
  })

  test('skipped runs (a workflow_run whose job did not apply) are ignored, not superseded', async () => {
    const { track } = await poll(fresh(), [
      ...base,
      ['run list --workflow Deploy web (staging)', [deployRun(15, { conclusion: 'skipped' })]],
      ['run list --workflow Deploy infra (staging)', []],
    ])
    expect(track.stages.find(s => s.id === 'deploy:web')!.state).toBe('pending')
  })

  test('runs created before the merge are ignored, and a passed deploy is not asked again', async () => {
    const t = fresh()
    t.stages = t.stages.map(s => (s.id === 'deploy:web' ? { ...s, state: 'passed', sha: 'def5678' } : s))
    const { track, gh } = await poll(t, [
      ...base,
      ['run list --workflow Deploy infra (staging)', [run(20, { workflowName: 'Deploy infra (staging)', createdAt: '2026-10-18T09:00:00Z' })]],
    ])
    expect(gh.calls.some(a => a.includes('Deploy web (staging)'))).toBe(false)
    expect(track.stages.find(s => s.id === 'deploy:infra')!.state).toBe('pending')
    expect(track.stages.find(s => s.id === 'deploy:web')!.state).toBe('passed')
  })

  test('a deploy that never arrives fails after its timeout', async () => {
    const t = fresh()
    const routes: Array<[string, unknown]> = [...base, ['run list --workflow Deploy', []]]
    const first = await poll(t, routes)
    const later = await poll(first.track, routes, WORKED, undefined, NOW + 46 * 60_000)
    expect(later.track.stages.find(s => s.id === 'deploy:web')).toMatchObject({ state: 'failed', note: 'no deploy within 45 min' })
  })

  test('the worked example runs to done with both deploys (spec §6)', async () => {
    const { track } = await poll(fresh(), [
      ...base,
      ['run list --workflow Deploy web (staging)', [deployRun(11), deployRun(10, { conclusion: 'cancelled' })]],
      ['run view 11', DEPLOY_WEB_LOG],
      ['run list --workflow Deploy infra (staging)', [deployRun(21, { workflowName: 'Deploy infra (staging)' })]],
      ['run view 21', DEPLOY_WEB_LOG],
      ['api repos/o/r/compare', 'ahead'],
    ])
    expect(track.stages.map(s => `${s.id}:${s.state}`)).toEqual(['pr-ci:passed', 'merged:passed', 'main-ci:passed', 'deploy:web:passed', 'deploy:infra:passed'])
    expect(track.status).toBe('done')
  })

  test('containment asks the local clone first for the session repo', async () => {
    const gh = fakeGh([
      ...base,
      ['git merge-base --is-ancestor', ''],
      ['run list --workflow Deploy web (staging)', [deployRun(11)]],
      ['run view 11', DEPLOY_WEB_LOG],
      ['run list --workflow Deploy infra (staging)', []],
    ])
    const ctx = { ...ctxOf(gh, WORKED), localRepo: 'o/r' }
    const track = apply(fresh(), await gather(fresh(), ctx), WORKED, NOW)
    expect(track.stages.find(s => s.id === 'deploy:web')!.state).toBe('passed')
    expect(gh.calls.some(a => a[1]?.startsWith('repos/'))).toBe(false)
  })
})

describe('repo config', () => {
  test('defaults fill in, and the closed schema names the bad field', () => {
    expect(WORKED.deploys[0]!.timeoutMinutes).toBe(45)
    expect(parseConfig('{"version":1}')).toEqual(DEFAULT_CONFIG)
    expect(() => parseConfig('{"version":1,"deploy":[]}')).toThrow('config: unknown field(s) deploy')
    expect(() => parseConfig('{"version":2}')).toThrow('version must be 1')
    expect(() => parseConfig('{"version":1,"notify":{"slack":{"webhookEnv":"https://example.com/hook"}}}')).toThrow(/NAME .* never the URL/)
    expect(() => parseConfig('{"version":1,"deploys":[{"name":"w","workflow":"D","deployedSha":{"from":"log","pattern":"HEAD (\\\\w+"}}]}')).toThrow('not a valid regular expression')
    expect(() => parseConfig('{"version":1,"deploys":[{"name":"w","workflow":"D","deployedSha":{"from":"log","pattern":"HEAD \\\\w+"}}]}')).toThrow('needs a capture group')
    expect(() => parseConfig('{"version":1,"checks":[{"name":"a","argv":["x"]},{"name":"a","argv":["y"]}]}')).toThrow('"a" is listed twice')
    expect(() => parseConfig('{nope')).toThrow(/not valid JSON/)
  })
})
