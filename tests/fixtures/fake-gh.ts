import type { Runner } from '../../hooks/lib/gh'

/** A gh that answers from fixtures: the first route whose words all appear in argv, in order. */
export const fakeGh = (routes: Array<[match: string, reply: unknown]>) => {
  const calls: string[][] = []
  const run = async (argv: readonly string[]) => ({ ...(await answer(argv)), isStdoutTruncated: false, isStderrTruncated: false })
  const answer: Runner = async argv => {
    calls.push([...argv])
    const line = argv.join(' ')
    for (const [match, reply] of routes) {
      const words = match.split(' ')
      let at = 0
      if (words.every(w => (at = line.indexOf(w, at)) >= 0 && (at += w.length) > 0)) {
        if (reply instanceof Error) return { exitCode: 1, stdout: '', stderr: reply.message }
        return { exitCode: 0, stdout: typeof reply === 'string' ? reply : JSON.stringify(reply), stderr: '' }
      }
    }
    return { exitCode: 1, stdout: '', stderr: `no fixture for: ${line}` }
  }
  return { run, calls }
}

export const pr = (over: Record<string, unknown> = {}) => ({
  number: 42,
  title: 'Add thing',
  url: 'https://github.com/o/r/pull/42',
  state: 'OPEN',
  isDraft: false,
  headRefOid: 'head1111aaaa',
  baseRefName: 'main',
  mergeCommit: null,
  mergedAt: null,
  statusCheckRollup: [],
  ...over,
})

export const check = (conclusion: string | null, name = 'test', workflowName = 'CI') => ({
  __typename: 'CheckRun',
  name,
  workflowName,
  status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
  conclusion,
  detailsUrl: `https://github.com/o/r/actions/runs/1/job/${name}`,
  startedAt: '2026-10-18T10:00:00Z',
})

export const run = (id: number, over: Record<string, unknown> = {}) => ({
  databaseId: id,
  workflowName: 'CI',
  status: 'completed',
  conclusion: 'success',
  headSha: 'merge2222bbbb',
  event: 'push',
  createdAt: '2026-10-18T10:05:00Z',
  url: `https://github.com/o/r/actions/runs/${id}`,
  ...over,
})

export const REPO_VIEW: [string, unknown] = ['repo view o/r', { defaultBranchRef: { name: 'main' } }]
