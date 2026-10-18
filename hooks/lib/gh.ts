/** Runs a command by argv (no shell). The mod's runner is `$.process.run`; tests pass fixtures. */
export type Runner = (argv: readonly string[], opts?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/** A run's log can be large; it gets longer than an ordinary gh call. */
export const LOG_TIMEOUT_MS = 20_000

/** A `gh` failure, with a message short enough for the bar. */
export class GhError extends Error {}

const firstLine = (text: string) => (text.split('\n').find(l => l.trim()) ?? '').trim().slice(0, 80)

export const gh = async (run: Runner, args: readonly string[], opts?: { timeoutMs?: number }): Promise<string> => {
  let out
  try {
    out = await run(['gh', ...args], opts)
  } catch (err) {
    throw new GhError(/time/i.test(String(err)) ? 'timed out' : firstLine(String(err)) || 'could not run gh')
  }
  if (out.exitCode !== 0) throw new GhError(firstLine(out.stderr) || `exit ${out.exitCode}`)
  return out.stdout
}

const json = async <T>(run: Runner, args: readonly string[]): Promise<T> => {
  const text = await gh(run, args)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new GhError(`unreadable output from gh ${args[0]} ${args[1] ?? ''}`.trim())
  }
}

export type RollupItem = {
  __typename?: string
  name?: string
  context?: string
  workflowName?: string
  status?: string
  conclusion?: string | null
  state?: string
  detailsUrl?: string
  targetUrl?: string
  startedAt?: string
}

export type PrInfo = {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  headRefOid: string
  baseRefName: string
  mergeCommit: { oid: string } | null
  mergedAt: string | null
  statusCheckRollup: RollupItem[] | null
}

export type Run = {
  databaseId: number
  workflowName?: string
  status: string
  conclusion: string | null
  headSha: string
  event: string
  createdAt: string
  url: string
}

const PR_FIELDS = 'number,title,url,state,isDraft,headRefOid,baseRefName,mergeCommit,mergedAt,statusCheckRollup'
const RUN_FIELDS = 'databaseId,workflowName,status,conclusion,headSha,event,createdAt,url'

export const prView = (run: Runner, repo: string, number: number) =>
  json<PrInfo>(run, ['pr', 'view', String(number), '--repo', repo, '--json', PR_FIELDS])

/** Runs, newest first, filtered by `--workflow`, `--commit`, `--branch`, `--event` as given. */
export const runList = (run: Runner, repo: string, filter: { workflow?: string; commit?: string; branch?: string; event?: string; limit?: number }) =>
  json<Run[]>(run, [
    'run', 'list', '--repo', repo, '--json', RUN_FIELDS, '--limit', String(filter.limit ?? 20),
    ...(filter.workflow ? ['--workflow', filter.workflow] : []),
    ...(filter.commit ? ['--commit', filter.commit] : []),
    ...(filter.branch ? ['--branch', filter.branch] : []),
    ...(filter.event ? ['--event', filter.event] : []),
  ])

export const defaultBranch = async (run: Runner, repo: string) =>
  (await json<{ defaultBranchRef: { name: string } }>(run, ['repo', 'view', repo, '--json', 'defaultBranchRef'])).defaultBranchRef.name

/** Whether a PR whose head is `branch` has merged: the base of a stacked PR. */
export const branchPrMerged = async (run: Runner, repo: string, branch: string) =>
  (await json<unknown[]>(run, ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'merged', '--json', 'number', '--limit', '1'])).length > 0

/** The text of a completed run's log. Large; read once per run and cache what it yields. */
export const runLog = (run: Runner, repo: string, id: string) => gh(run, ['run', 'view', id, '--repo', repo, '--log'], { timeoutMs: LOG_TIMEOUT_MS })

/** Whether `ancestor` is contained in `sha`, by the compare API (`ahead` or `identical`). */
export const compareContains = async (run: Runner, repo: string, ancestor: string, sha: string) => {
  const status = (await gh(run, ['api', `repos/${repo}/compare/${ancestor}...${sha}`, '--jq', '.status'])).trim()
  return status === 'ahead' || status === 'identical'
}
