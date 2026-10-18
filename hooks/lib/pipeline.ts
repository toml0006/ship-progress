import type { Stage, StageState, Track } from '../../types'
import type { Config } from './config'
import { branchPrMerged, defaultBranch, prView, runList, type PrInfo, type RollupItem, type Run, type Runner } from './gh'
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
}

export type Ctx = {
  run: Runner
  config: Config
  now: number
  /** Default branch by repo, filled on first use. */
  defaultBranches: Map<string, string>
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

/** Asks GitHub about one track. Throws GhError when gh fails; the caller backs off. */
export const gather = async (track: Track, ctx: Ctx, deploys?: (pr: PrInfo, branch: string) => Promise<Record<string, StageFact>>): Promise<Facts> => {
  const pr = await prView(ctx.run, track.repo, track.number)
  let branch = ctx.defaultBranches.get(track.repo)
  if (!branch) {
    branch = await defaultBranch(ctx.run, track.repo)
    ctx.defaultBranches.set(track.repo, branch)
  }
  const baseMerged = pr.state === 'OPEN' && pr.baseRefName !== branch ? await branchPrMerged(ctx.run, track.repo, pr.baseRefName) : false
  const facts: Facts = { pr, defaultBranch: branch, baseMerged, prCi: await prCiFact(ctx, track.repo, pr), deploys: {} }
  if (pr.state === 'MERGED' && pr.mergeCommit) {
    facts.mainCi = await mainCiFact(ctx, track.repo, pr, branch)
    if (facts.mainCi.state === 'passed' || facts.mainCi.state === 'skipped') facts.deploys = (await deploys?.(pr, branch)) ?? {}
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
      if (stage.id.startsWith('deploy:')) return f.deploys[stage.label] ?? { state: 'pending' }
      return undefined
  }
}

/** Folds facts into a track: stage states, SHAs, and whether it is done or closed. Pure. */
export const apply = (track: Track, f: Facts, config: Config, now: number): Track => {
  const stages = shapeStages(track.stages, config).map(s => {
    const fact = s.owner === 'mod' ? factFor(s, f, f.defaultBranch) : undefined
    if (!fact) return s
    const { state, deployedSha: _, ...extra } = fact
    return moveStage(s, state, now, { note: undefined, ref: undefined, url: undefined, ...extra })
  })
  // The stage being waited on shows how long it has waited.
  const current = currentStage(stages)
  if (current && current.startedAt === undefined) stages[stages.indexOf(current)] = { ...current, startedAt: now }

  const deployed = config.deploys.map(d => f.deploys[d.name]?.deployedSha).filter(Boolean).at(-1)
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
