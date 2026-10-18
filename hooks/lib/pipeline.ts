import type { Stage, StageState, Track } from '../../types'
import { runCheck } from './checks'
import type { Config, DeployConfig } from './config'
import { branchPrMerged, compareContains, defaultBranch, prView, runList, runLog, type PrInfo, type RollupItem, type Run, type Runner } from './gh'
import { currentStage, isSettled, moveStage } from './model'

/** What GitHub says about one stage, before it is folded into the track. */
export type StageFact = { state: StageState; note?: string; ref?: string; url?: string; deployedSha?: string }

export type Facts = {
  pr: PrInfo
  defaultBranch: string
  /** For a stacked PR: whether the PR its base branch belongs to has merged. */
  baseMerged: boolean
  prCi: StageFact
  /** Present once the PR has merged. */
  mainCi?: StageFact
  /** By deploy name; present once main CI has passed. */
  deploys: Record<string, StageFact>
  /** By check name; present for the checks run (or refused) on this poll. */
  checks: Record<string, StageFact>
}

export type Ctx = {
  run: Runner
  config: Config
  now: number
  /** Default branch by repo, filled on first use. */
  defaultBranches: Map<string, string>
  /** The session's repo: containment is asked of the local clone first for this one. */
  localRepo?: string | null
  /** Read and filled while gathering; the caller persists them. */
  cache: { logShas: Record<string, string>; contains: Record<string, boolean> }
  /** Custom checks: whether the person trusted this config's checks, where to run them, and when each last ran. */
  checks?: { isTrusted: boolean; cwd: string; lastRun: Record<string, number> }
}

/** How long after a merge, with no CI config and no push run, main CI counts as absent. */
const NO_MAIN_CI_MS = 10 * 60_000

type Phase = 'running' | 'passed' | 'skipped' | 'failed' | 'cancelled'
type Entry = { name: string; phase: Phase; url?: string; ref?: string }

const rollupEntry = (i: RollupItem): Entry => {
  const name = i.workflowName ? `${i.workflowName}${i.name ? ` / ${i.name}` : ''}` : (i.name ?? i.context ?? 'check')
  const url = i.detailsUrl ?? i.targetUrl
  if (i.__typename === 'StatusContext' || (i.state !== undefined && i.status === undefined)) {
    const s = (i.state ?? '').toUpperCase()
    return { name, url, phase: s === 'SUCCESS' ? 'passed' : s === 'PENDING' || s === 'EXPECTED' ? 'running' : 'failed' }
  }
  if ((i.status ?? '').toUpperCase() !== 'COMPLETED') return { name, url, phase: 'running' }
  const c = (i.conclusion ?? '').toUpperCase()
  return { name, url, phase: c === 'SUCCESS' || c === 'NEUTRAL' ? 'passed' : c === 'SKIPPED' ? 'skipped' : c === 'CANCELLED' ? 'cancelled' : 'failed' }
}

export const runPhase = (r: Pick<Run, 'status' | 'conclusion'>): Phase => {
  if (r.status !== 'completed') return 'running'
  const c = r.conclusion ?? ''
  return c === 'success' || c === 'neutral' ? 'passed' : c === 'skipped' ? 'skipped' : c === 'cancelled' ? 'cancelled' : 'failed'
}

const runEntry = (r: Run): Entry => ({ name: r.workflowName ?? 'run', phase: runPhase(r), url: r.url, ref: String(r.databaseId) })

/** Rollup items repeat across reruns: keep the newest per workflow and job. */
const latestRollup = (items: readonly RollupItem[]) => {
  const by = new Map<string, RollupItem>()
  for (const i of items) {
    const k = `${i.workflowName ?? ''}|${i.name ?? i.context ?? ''}`
    const prev = by.get(k)
    if (!prev || (i.startedAt ?? '') >= (prev.startedAt ?? '')) by.set(k, i)
  }
  return [...by.values()]
}

/** Runs come newest first: keep the newest per workflow. */
const latestRuns = (runs: readonly Run[]) => {
  const seen = new Set<string>()
  return runs.filter(r => {
    const k = r.workflowName ?? String(r.databaseId)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Folds CI entries into one stage: any failure fails it, anything running keeps it running. */
export const aggregate = (entries: readonly Entry[], ref?: string): StageFact => {
  if (entries.length === 0) return { state: 'pending', note: undefined, ref }
  const failed = entries.find(e => e.phase === 'failed')
  if (failed) return { state: 'failed', note: `${failed.name} failed`, url: failed.url, ref }
  const running = entries.find(e => e.phase === 'running')
  if (running) return { state: 'running', url: running.url, ref }
  const cancelled = entries.find(e => e.phase === 'cancelled')
  if (cancelled) return { state: 'superseded', note: `${cancelled.name} cancelled`, url: cancelled.url, ref }
  return { state: entries.some(e => e.phase === 'passed') ? 'passed' : 'skipped', ref }
}

const prCiFact = async (ctx: Ctx, repo: string, pr: PrInfo): Promise<StageFact> => {
  const rollup = latestRollup(pr.statusCheckRollup ?? [])
  const wf = ctx.config.ci?.workflow
  if (!wf) return aggregate(rollup.map(rollupEntry), pr.headRefOid)
  const named = rollup.filter(i => i.workflowName === wf)
  if (named.length) return aggregate(named.map(rollupEntry), pr.headRefOid)
  // A workflow given by file name, or not reported in the rollup: ask for its runs on the head SHA.
  const runs = await runList(ctx.run, repo, { workflow: wf, commit: pr.headRefOid, limit: 5 })
  return aggregate(runs.slice(0, 1).map(runEntry), pr.headRefOid)
}

const mainCiFact = async (ctx: Ctx, repo: string, pr: PrInfo, branch: string): Promise<StageFact> => {
  const sha = pr.mergeCommit!.oid
  const wf = ctx.config.ci?.workflow
  if (wf) {
    const runs = await runList(ctx.run, repo, { workflow: wf, commit: sha, limit: 5 })
    return aggregate(runs.slice(0, 1).map(runEntry), sha)
  }
  // No CI configured: every push-triggered workflow on the merge commit.
  const runs = latestRuns((await runList(ctx.run, repo, { commit: sha, branch, event: 'push', limit: 30 })).filter(r => r.event === 'push'))
  const mergedAt = pr.mergedAt ? Date.parse(pr.mergedAt) : ctx.now
  if (runs.length === 0 && ctx.now - mergedAt > NO_MAIN_CI_MS) return { state: 'skipped', note: `no CI ran on ${branch}`, ref: sha }
  return aggregate(runs.map(runEntry), sha)
}

/** The SHA a completed run deployed: its headSha, or the last pattern match in its log (read once, cached). */
const deployedShaOf = async (ctx: Ctx, repo: string, run: Run, d: DeployConfig) => {
  if (d.deployedSha.from === 'headSha') return run.headSha
  const id = String(run.databaseId)
  if (id in ctx.cache.logShas) return ctx.cache.logShas[id] || undefined
  const sha = lastMatch(await runLog(ctx.run, repo, id), d.deployedSha.pattern)
  ctx.cache.logShas[id] = sha ?? ''
  return sha
}

export const lastMatch = (log: string, pattern: string) => {
  const re = new RegExp(pattern, 'g')
  let sha: string | undefined
  for (const m of log.matchAll(re)) if (m[1] && /^[0-9a-f]{7,40}$/i.test(m[1])) sha = m[1].toLowerCase()
  return sha
}

/** Whether `deployed` contains `merge`: the local clone first, then the compare API. Cached. */
export const contains = async (ctx: Ctx, repo: string, merge: string, deployed: string) => {
  if (merge.startsWith(deployed) || deployed.startsWith(merge)) return true
  const key = `${merge}:${deployed}`
  if (key in ctx.cache.contains) return ctx.cache.contains[key]!
  let answer: boolean | undefined
  if (ctx.localRepo === repo) {
    const out = await ctx.run(['git', 'merge-base', '--is-ancestor', merge, deployed]).catch(() => undefined)
    // 0: ancestor; 1: not; anything else (a commit this clone has not fetched): ask GitHub.
    if (out?.exitCode === 0) answer = true
    else if (out?.exitCode === 1) answer = false
  }
  answer ??= await compareContains(ctx.run, repo, merge, deployed)
  ctx.cache.contains[key] = answer
  return answer
}

/** Slack between a merge and the deploy run it triggers, for clock skew. */
const RUN_SKEW_MS = 60_000

/**
 * One deploy stage. Runs since the merge, newest first: a success whose deployed
 * SHA contains the merge passes; a failure that contains it fails; a cancelled
 * run (a concurrency group dropped it) is superseded and the stage keeps waiting.
 */
export const deployFact = async (ctx: Ctx, repo: string, pr: PrInfo, branch: string, d: DeployConfig): Promise<StageFact> => {
  const merge = pr.mergeCommit!.oid
  const since = (pr.mergedAt ? Date.parse(pr.mergedAt) : 0) - RUN_SKEW_MS
  const runs = (await runList(ctx.run, repo, { workflow: d.workflow, branch: d.branch ?? branch, limit: 20 })).filter(r => Date.parse(r.createdAt) >= since)
  let running: Run | undefined
  let superseded: Run | undefined
  let unreadable: Run | undefined
  for (const r of runs) {
    const phase = runPhase(r)
    if (phase === 'running') {
      running ??= r
      continue
    }
    // A skipped run is usually a workflow_run trigger whose job `if` did not apply
    // (CI finishing on another branch): noise, not a deploy of anything.
    if (phase === 'skipped') continue
    if (phase === 'cancelled') {
      superseded ??= r
      continue
    }
    const sha = await deployedShaOf(ctx, repo, r, d)
    if (!sha) {
      if (phase === 'failed') unreadable ??= r
      continue
    }
    if (!(await contains(ctx, repo, merge, sha))) continue
    const ref = String(r.databaseId)
    if (phase === 'passed') return { state: 'passed', deployedSha: sha, ref, url: r.url }
    return { state: 'failed', note: `run ${ref} failed`, deployedSha: sha, ref, url: r.url }
  }
  if (running) return { state: 'running', ref: String(running.databaseId), url: running.url }
  if (superseded) return { state: 'superseded', note: `run ${superseded.databaseId} ${superseded.conclusion}; waiting for a later run`, ref: String(superseded.databaseId), url: superseded.url }
  if (unreadable) return { state: 'warning', note: `run ${unreadable.databaseId} failed before reporting a SHA`, ref: String(unreadable.databaseId), url: unreadable.url }
  return { state: 'pending' }
}

/** Runs the checks that are due, once main CI and every deploy have passed. */
const checkFacts = async (ctx: Ctx, track: Track, f: Facts): Promise<Record<string, StageFact>> => {
  const out: Record<string, StageFact> = {}
  if (ctx.config.checks.length === 0 || !ctx.checks) return out
  // The track as this poll leaves its deploys, so {deployedSha:<name>} resolves.
  const stages = track.stages.map(s => {
    const d = s.id.startsWith('deploy:') ? f.deploys[s.label] : undefined
    return d ? { ...s, state: d.state, sha: d.deployedSha } : s
  })
  if (!stages.filter(s => s.id.startsWith('deploy:')).every(s => s.state === 'passed')) return out
  const now = { ...track, stages, mergeSha: f.pr.mergeCommit?.oid }
  for (const c of ctx.config.checks) {
    const key = `${track.key}|${c.name}`
    if (stages.some(s => s.id === `check:${c.name}` && s.state === 'passed')) continue
    if (!ctx.checks.isTrusted) {
      out[c.name] = { state: 'warning', note: 'checks not trusted: type /ship-progress trust' }
      continue
    }
    if (ctx.now - (ctx.checks.lastRun[key] ?? 0) < c.intervalSeconds * 1000) continue
    ctx.checks.lastRun[key] = ctx.now
    out[c.name] = await runCheck(ctx.run, c, now, ctx.checks.cwd)
  }
  return out
}

/** Asks GitHub about one track. Throws GhError when gh fails; the caller backs off. */
export const gather = async (track: Track, ctx: Ctx): Promise<Facts> => {
  const pr = await prView(ctx.run, track.repo, track.number)
  let branch = ctx.defaultBranches.get(track.repo)
  if (!branch) {
    branch = await defaultBranch(ctx.run, track.repo)
    ctx.defaultBranches.set(track.repo, branch)
  }
  const baseMerged = pr.state === 'OPEN' && pr.baseRefName !== branch ? await branchPrMerged(ctx.run, track.repo, pr.baseRefName) : false
  const facts: Facts = { pr, defaultBranch: branch, baseMerged, prCi: await prCiFact(ctx, track.repo, pr), deploys: {}, checks: {} }
  if (pr.state === 'MERGED' && pr.mergeCommit) {
    facts.mainCi = await mainCiFact(ctx, track.repo, pr, branch)
    if (facts.mainCi.state === 'passed' || facts.mainCi.state === 'skipped') {
      for (const d of ctx.config.deploys) {
        // A deploy that passed stays passed: later runs ship later commits.
        if (track.stages.some(s => s.id === `deploy:${d.name}` && s.state === 'passed')) continue
        facts.deploys[d.name] = await deployFact(ctx, track.repo, pr, branch, d)
      }
      facts.checks = await checkFacts(ctx, track, facts)
    }
  }
  return facts
}

/** The mod's stages for a config, in pipeline order. */
export const modStages = (config: Config): Stage[] => [
  { id: 'pr-ci', label: 'PR CI', owner: 'mod', state: 'pending' },
  { id: 'merged', label: 'merged', owner: 'mod', state: 'pending' },
  { id: 'main-ci', label: 'main CI', owner: 'mod', state: 'pending' },
  ...config.deploys.map((d): Stage => ({ id: `deploy:${d.name}`, label: d.name, owner: 'mod', state: 'pending' })),
  ...config.checks.map((c): Stage => ({ id: `check:${c.name}`, label: c.name, owner: 'mod', state: 'pending' })),
]

/** Keeps agent steps where they are, drops mod stages the config no longer has, adds new ones in order. */
export const shapeStages = (stages: readonly Stage[], config: Config): Stage[] => {
  const want = modStages(config)
  const ids = new Set(want.map(s => s.id))
  const out = stages.filter(s => s.owner === 'agent' || ids.has(s.id))
  want.forEach((s, i) => {
    if (out.some(x => x.id === s.id)) return
    const prev = i === 0 ? -1 : out.findIndex(x => x.id === want[i - 1]!.id)
    out.splice(prev + 1, 0, s)
  })
  return out
}

const factFor = (stage: Stage, f: Facts, branch: string): StageFact | undefined => {
  const { pr } = f
  switch (stage.id) {
    case 'pr-ci': {
      const fact = f.prCi
      if (pr.state === 'MERGED' && !isSettled(fact.state)) return { ...fact, state: 'skipped', note: 'merged before PR CI passed' }
      if (pr.isDraft && fact.state !== 'failed') return { ...fact, state: 'warning', note: 'draft: full suite not run' }
      return fact
    }
    case 'merged':
      if (pr.state === 'MERGED') return { state: 'passed', ref: pr.mergeCommit?.oid }
      if (pr.state === 'CLOSED') return { state: 'failed', note: 'closed without merge' }
      if (f.baseMerged) return { state: 'warning', note: `base merged; retarget to ${branch}` }
      return { state: 'pending' }
    case 'main-ci':
      return f.mainCi ?? { state: 'pending' }
    default:
      if (stage.id.startsWith('deploy:')) {
        if (stage.state === 'passed') return undefined
        return f.deploys[stage.label] ?? { state: 'pending' }
      }
      // A check not run on this poll keeps its state; a passed one stays passed.
      if (stage.id.startsWith('check:') && stage.state !== 'passed') return f.checks[stage.label]
      return undefined
  }
}

/** A deploy or check that has waited past its timeout without passing fails. Untrusted checks wait for the person. */
const timedOut = (s: Stage, config: Config, now: number): Stage | undefined => {
  if (isSettled(s.state) || s.state === 'failed' || s.startedAt === undefined) return undefined
  const d = config.deploys.find(x => `deploy:${x.name}` === s.id)
  const c = config.checks.find(x => `check:${x.name}` === s.id)
  const minutes = d?.timeoutMinutes ?? c?.timeoutMinutes
  if (minutes === undefined || now - s.startedAt < minutes * 60_000) return undefined
  if (c && s.state === 'warning') return undefined
  const what = d ? `no deploy within ${minutes} min` : `still failing after ${minutes} min`
  return moveStage(s, 'failed', now, { note: `${what}${s.note ? ` (${s.note})` : ''}` })
}

/** Folds facts into a track: stage states, SHAs, and whether it is done or closed. Pure. */
export const apply = (track: Track, f: Facts, config: Config, now: number): Track => {
  const stages = shapeStages(track.stages, config).map(s => {
    if (s.owner !== 'mod') return s
    const fact = factFor(s, f, f.defaultBranch)
    let next = s
    if (fact) {
      const { state, deployedSha, ...extra } = fact
      next = moveStage(s, state, now, { note: undefined, ref: undefined, url: undefined, sha: deployedSha, ...extra })
    }
    return timedOut(next, config, now) ?? next
  })
  // The stage being waited on shows how long it has waited.
  const current = currentStage(stages)
  if (current && current.startedAt === undefined) stages[stages.indexOf(current)] = { ...current, startedAt: now }

  const deployed = stages.filter(s => s.id.startsWith('deploy:') && s.sha).at(-1)?.sha
  const next: Track = {
    ...track,
    title: f.pr.title,
    url: f.pr.url,
    headSha: f.pr.headRefOid,
    mergeSha: f.pr.mergeCommit?.oid ?? track.mergeSha,
    deployedSha: deployed ?? track.deployedSha,
    stages,
    updatedAt: JSON.stringify(stages) === JSON.stringify(track.stages) ? track.updatedAt : now,
  }
  if (f.pr.state === 'CLOSED') return { ...next, status: 'closed', endedAt: track.endedAt ?? now }
  if (stages.every(s => isSettled(s.state))) return { ...next, status: 'done', endedAt: track.endedAt ?? now }
  const { endedAt: _e, ...active } = next
  return { ...active, status: 'active' }
}
