import { describe, expect, mock, test } from 'claude-code/testing'

import { appleScriptString, osascriptArgv, transitions } from '../hooks/lib/alerts'
import { DEFAULT_CONFIG } from '../hooks/lib/config'
import { newTrack } from '../hooks/lib/ops'
import type { Track } from '../types'
import { check, fakeGh, pr, REPO_VIEW, run } from './fixtures/fake-gh'

const FAKE_WEBHOOK = 'https://hooks.example.test/services/T0/B0/not-a-real-secret'
const CONFIG = JSON.stringify({ version: 1, notify: { macos: true, wakeAgent: true, slack: { webhookEnv: 'SHIP_PROGRESS_SLACK_WEBHOOK' } } })

describe('transitions', () => {
  test('alert once per state, again for a new run, and once when live', () => {
    const t0 = newTrack('o/r', 42, 0)
    const failed: Track = { ...t0, stages: t0.stages.map(s => (s.id === 'pr-ci' ? { ...s, state: 'failed', note: 'CI / unit failed', ref: 'h1' } : s)) }
    const [a] = transitions(t0, failed, DEFAULT_CONFIG.notify, 'o/r')
    expect(a).toEqual({ key: 'o/r#42|pr-ci|failed|h1', text: '#42 pr-ci failed: CI / unit failed', url: undefined })
    expect(transitions(failed, failed, DEFAULT_CONFIG.notify, 'o/r')).toEqual([])
    const done: Track = { ...failed, status: 'done', mergeSha: 'abcdef1234', title: 'Add thing', stages: failed.stages.map(s => ({ ...s, state: 'passed' })) }
    expect(transitions(failed, done, DEFAULT_CONFIG.notify, 'x/y').map(x => x.text)).toEqual(['o/r#42 live (abcdef12): Add thing'])
  })
  test('AppleScript text is escaped', () => {
    expect(appleScriptString('say "hi" \\ bye\nnow')).toBe('"say \\"hi\\" \\\\ bye now"')
    expect(osascriptArgv('x')[2]).toBe('display notification "x" with title "ship-progress"')
  })
})

test('a failure and a done fire once each on every channel; the webhook URL is never stored or logged (AC9)', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-18T10:30:00Z') })
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  mock.env(on, { SHIP_PROGRESS_SLACK_WEBHOOK: FAKE_WEBHOOK })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.repo', () => ({ value: { root: '/r', remote: 'https://github.com/o/r.git', internal: false, name: null } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__ship-progress__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: CONFIG.length, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: CONFIG }))

  const prompts: string[] = []
  const banners: string[] = []
  const posts: { url: string; body?: string }[] = []
  const logs: string[] = []
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('http.fetch', ($, e) => {
    posts.push({ url: e.url, body: e.init?.body })
    return { value: { status: 200, ok: true, headers: {}, text: 'ok' } }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })

  let state: 'failing' | 'merged' = 'failing'
  const gh = fakeGh([])
  on('process.run', async ($, e) => {
    const argv = e.argv
    const reply = (stdout: unknown) => ({ value: { exitCode: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'uname') return reply('Darwin\n')
    if (argv[0] === 'osascript') {
      banners.push(argv[2]!)
      return reply('')
    }
    gh.calls.push([...argv])
    const line = argv.join(' ')
    if (line.includes('repo view')) return reply(REPO_VIEW[1])
    if (line.includes('pr view')) {
      return reply(state === 'failing'
        ? pr({ statusCheckRollup: [check('FAILURE', 'unit')] })
        : pr({ state: 'MERGED', mergeCommit: { oid: 'merge2222bbbb' }, mergedAt: '2026-10-18T10:20:00Z', statusCheckRollup: [check('SUCCESS')] }))
    }
    if (line.includes('run list')) return reply([run(7)])
    return { value: { exitCode: 1, stdout: '', stderr: 'unexpected', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'track', args: '42' } as never)
  await clock.advance(5_000)
  await clock.advance(60_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toMatch(/^ship-progress: #42 pr-ci failed: CI \/ unit failed/)
  expect(banners).toEqual(['display notification "#42 pr-ci failed: CI / unit failed" with title "ship-progress"'])
  expect(posts.length).toBe(1)
  expect(posts[0]!.url).toBe(FAKE_WEBHOOK)
  expect(JSON.parse(posts[0]!.body!).text).toMatch(/^ship-progress: #42 pr-ci failed/)

  state = 'merged'
  await clock.advance(60_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(prompts.length).toBe(2)
  expect(prompts[1]).toMatch(/^ship-progress: #42 live \(merge222\): Add thing/)
  expect(banners.length).toBe(2)
  expect(posts.length).toBe(2)

  const stored = JSON.stringify([...store.entries()])
  expect(stored).toContain('o/r#42|done')
  expect(stored).not.toContain('hooks.example.test')
  expect(logs.join('\n')).not.toContain('hooks.example.test')
})
