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
