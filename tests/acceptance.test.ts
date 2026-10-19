import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { newTrack } from '../hooks/lib/ops'
import { check, fakeGh, pr, REPO_VIEW, run } from './fixtures/fake-gh'

const BAND = { plugin: 'ship-progress', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const
const T0 = Date.parse('2026-10-18T10:30:00Z')
const CONFIG = '{"version":1,"doneLingerMinutes":2}'

const world = (on: On, store: Record<string, unknown>, routes: Parameters<typeof fakeGh>[0]) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, store)
  mock.env(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.repo', () => ({ value: { root: '/r', remote: 'git@github.com:o/r.git', internal: false, name: null } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__ship-progress__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: CONFIG.length, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: CONFIG }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: 'ENGINE' }))
  const gh = fakeGh(routes)
  on('process.run', async ($, e) => ({ value: await gh.run(e.argv) }))
  return { clock, gh }
}

const MERGED = pr({ state: 'MERGED', mergeCommit: { oid: 'merge2222bbbb' }, mergedAt: '2026-10-18T10:20:00Z', statusCheckRollup: [check('SUCCESS')] })

test('a new session restores in-flight tracks and resumes polling (AC10)', async ($, on) => {
  const track = newTrack('o/r', 42, T0 - 60_000)
  const store = { 'repo:o/r': { version: 1, tracks: [track], lists: [], history: [], logShas: {}, contains: {}, alerts: [], trust: null } }
  const { clock, gh } = world(on, store, [['pr view 42', pr({ statusCheckRollup: [check(null)] })], REPO_VIEW])
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /#42 □□□/ })).toBeDefined()
  await clock.advance(5_000)
  expect(gh.calls.some(a => a.join(' ').includes('pr view 42'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /#42 ▣□□\s+PR CI running/ })).toBeDefined()
})

test('hooks and renders run no process and finish well under a second (AC11)', async ($, on) => {
  const { gh } = world(on, {}, [])
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  const started = Date.now()
  await $.command.run({ command: 'track', args: '42' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git status' } as never)
  await $.tool.call({ tool: 'mcp__ship-progress__ship_progress', action: 'status' } as never)
  for (const surface of ['terminal', 'desktop'] as const) await (await $.ui.mount({ ...BAND, surface })).unmount()
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(gh.calls).toEqual([])
})

test('a done track lingers for doneLingerMinutes, then the bar is hidden (AC13)', async ($, on) => {
  const { clock } = world(on, {}, [['pr view 42', MERGED], REPO_VIEW, ['run list', [run(7)]]])
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'track', args: '42' } as never)
  await clock.advance(5_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /#42 ■■■\s+live merge222/ })).toBeDefined()
  await clock.advance(60_000)
  expect(await ui.find({ type: 'Text', text: /#42/ })).toBeDefined()
  await clock.advance(65_000)
  expect(await ui.find({ type: 'Text', text: /#42/ })).toBeUndefined()
  expect(JSON.stringify(await ui.drawn())).toContain('ENGINE')
  expect((await $.command.run({ command: 'track', args: '' } as never)).text).toMatch(/recent:\n  o\/r#42 done merge222/)
})

test('a trusted check runs through $.process.run with the repo root as cwd and its env (review fix)', async ($, on) => {
  const config = JSON.stringify({ version: 1, checks: [{ name: 'drained', argv: ['./scripts/drained.sh', '{prNumber}'], env: { STAGE: 'staging' }, intervalSeconds: 10 }] })
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.repo', () => ({ value: { root: '/r', remote: 'git@github.com:o/r.git', internal: false, name: null } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__ship-progress__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: config.length, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: config }))
  const gh = fakeGh([['pr view 42', MERGED], REPO_VIEW, ['run list', [run(7)]]])
  const scripts: unknown[] = []
  on('process.run', async ($, e) => {
    if (e.argv[0] === './scripts/drained.sh') {
      scripts.push({ argv: e.argv, cwd: e.init?.cwd, env: e.init?.env })
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: await gh.run(e.argv) }
  })
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  // The tool's track action (a review fix too): the agent can add a PR.
  const tracked = await $.tool.call({ tool: 'mcp__ship-progress__ship_progress', action: 'track', pr: '42' } as never)
  expect(String(tracked.result)).toBe('tracking o/r#42')
  await clock.advance(5_000)
  expect(scripts).toEqual([]) // not trusted yet
  await $.command.run({ command: 'ship-progress', args: 'trust', origin: { kind: 'composer' } } as never)
  await clock.advance(5_000)
  expect(scripts).toEqual([{ argv: ['./scripts/drained.sh', '42'], cwd: '/r', env: { STAGE: 'staging' } }])
  expect((await $.command.run({ command: 'track', args: '' } as never)).text).toMatch(/recent:|#42 ■■■■\s+live/)
})

test('a broken config edit keeps the last good config, so deploy stages stay (review fix)', async ($, on) => {
  const good = JSON.stringify({ version: 1, deploys: [{ name: 'web', workflow: 'Deploy web' }] })
  let text = good
  let mtime = 1
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.repo', () => ({ value: { root: '/r', remote: 'git@github.com:o/r.git', internal: false, name: null } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__ship-progress__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: text.length, mtimeMs: mtime, isLink: false } }))
  on('fs.read', () => ({ value: text }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: 'ENGINE' }))
  const gh = fakeGh([['pr view 42', MERGED], REPO_VIEW, ['run list --workflow Deploy web', []], ['run list', [run(7)]]])
  on('process.run', async ($, e) => ({ value: await gh.run(e.argv) }))
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'track', args: '42' } as never)
  await clock.advance(5_000)
  text = '{"version":1,"deploys":[{"name":"web"'
  mtime = 2
  await clock.advance(65_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /#42 ■■■□\s+web waiting/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⚠ \.claude\/ship-progress\.json: not valid JSON/ })).toBeDefined()
})

test('alert preferences come from the session config, also for a PR in another repo', async ($, on) => {
  const quiet = '{"version":1,"notify":{"macos":false,"wakeAgent":false}}'
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.repo', () => ({ value: { root: '/r', remote: 'git@github.com:o/r.git', internal: false, name: null } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__ship-progress__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: quiet.length, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: quiet }))
  const prompts: string[] = []
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  const gh = fakeGh([['pr view 5 --repo other/x', MERGED], ['repo view other/x', { defaultBranchRef: { name: 'main' } }], ['run list', [run(7)]]])
  const spawned: string[] = []
  on('process.run', async ($, e) => {
    spawned.push(e.argv[0]!)
    return { value: await gh.run(e.argv) }
  })
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'track', args: 'other/x#5' } as never)
  await clock.advance(5_000)
  await clock.settle()
  expect((await $.command.run({ command: 'track', args: '' } as never)).text).toMatch(/other\/x#5 ■■■\s+live/)
  expect(prompts).toEqual([])
  expect(spawned.filter(c => c === 'osascript' || c === 'uname')).toEqual([])
})
