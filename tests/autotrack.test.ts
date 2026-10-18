import { describe, expect, mock, test } from 'claude-code/testing'

import { matchCommand } from '../hooks/lib/autotrack'

describe('matchCommand', () => {
  test('reads the PR from the output, the argument, or the branch', () => {
    expect(matchCommand('gh pr create --fill', 'https://github.com/o/r/pull/12\n')).toEqual({ kind: 'pr', ref: 'https://github.com/o/r/pull/12' })
    expect(matchCommand('gh pr create --web', '')).toEqual({ kind: 'branch' })
    expect(matchCommand('gh pr merge 608 --squash', '✓ Squashed and merged pull request o/r#608 (title)')).toEqual({ kind: 'pr', ref: 'o/r#608' })
    expect(matchCommand('gh pr merge 608 --squash --delete-branch', '')).toEqual({ kind: 'pr', ref: '608' })
    expect(matchCommand('gh pr merge --repo a/b 7 --squash', '')).toEqual({ kind: 'pr', ref: 'a/b#7' })
    expect(matchCommand('gh pr ready', '')).toEqual({ kind: 'branch' })
    expect(matchCommand('cd web && git push -u origin feat', '')).toEqual({ kind: 'branch' })
    expect(matchCommand('git -C ../x push', '')).toEqual({ kind: 'branch' })
  })
  test('ignores what does not touch a PR', () => {
    expect(matchCommand('gh pr view 12', 'https://github.com/o/r/pull/12')).toBeUndefined()
    expect(matchCommand('gh pr merge --help', '')).toBeUndefined()
    expect(matchCommand('git push --tags', '')).toBeUndefined()
    expect(matchCommand('git status', '')).toBeUndefined()
    expect(matchCommand('echo "gh pr merge 3"', '')).toBeUndefined()
  })
})

test('a PR merged during the session is tracked with no /track; a push is looked up on a tick (AC2)', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.repo', () => ({ value: { root: '/r', remote: 'git@github.com:o/r.git', internal: false, name: null } }))
  on('session.cwd', () => ({ value: '/r/web' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__ship-progress__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const runs: string[] = []
  on('process.run', ($, e) => {
    runs.push(`${e.argv.join(' ')} @${e.init?.cwd ?? ''}`)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv.join(' ') === 'gh pr view --json url,state') return ok('{"url":"https://github.com/o/r/pull/77","state":"OPEN"}')
    return { value: { exitCode: 1, stdout: '', stderr: 'offline', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // The Bash tool itself, beneath the plugin.
  on('tool.call', { tool: 'Bash' }, ($, e) => ({
    result: { stdout: e.command.includes('merge') ? '✓ Merged pull request o/r#76' : '', stderr: '', interrupted: false },
    text: e.command.includes('merge') ? '✓ Merged pull request o/r#76' : '',
  }) as never)

  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'gh pr merge 76 --squash' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  expect(runs).toEqual([]) // the hook ran no process: lookups wait for the clock
  let listed = await $.command.run({ command: 'track', args: '' } as never)
  expect(listed.text).toMatch(/#76/)
  await clock.advance(5_000)
  expect(runs[0]).toBe('gh pr view --json url,state @/r/web')
  listed = await $.command.run({ command: 'track', args: '' } as never)
  expect(listed.text).toMatch(/#77/)
})
