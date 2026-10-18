import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

import { check, fakeGh, pr, REPO_VIEW } from './fixtures/fake-gh'

const TOOL = 'mcp__ship-progress__ship_progress'
const BAND = { plugin: 'ship-progress', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const

/** The world beneath the plugin: a repo, registrations accepted, clock and store in memory. */
const world = (on: On, store: Record<string, unknown> = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, store)
  mock.env(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.repo', () => ({ value: { root: '/r', remote: 'git@github.com:o/r.git', internal: false, name: null } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__ship-progress__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  return clock
}

const start = ($: Engine) =>
  $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })

test('list_set draws a line above the prompt and status returns JSON', async ($, on) => {
  world(on)
  await start($)
  const r = await $.tool.call({ tool: TOOL, action: 'list_set', list: 'rel', title: 'Release', steps: [{ name: 'build', state: 'passed' }, { name: 'ship' }] } as never)
  expect(String(r.result)).toMatch(/^ok/)
  const bad = await $.tool.call({ tool: TOOL, action: 'list_set', list: 'rel' } as never)
  expect(String(bad.result)).toMatch(/needs: title, steps/)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Release ■□\s+ship waiting/ })).toBeDefined()
    await ui.unmount()
  }
  const status = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'status' } as never)).result))
  expect(status.repo).toBe('o/r')
  expect(status.lists[0].steps.length).toBe(2)
})

test('the bar is hidden when nothing is in flight', async ($, on) => {
  world(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: 'ENGINE' }))
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).toContain('ENGINE')
  expect(await ui.find({ type: 'Text', text: /■|□/ })).toBeUndefined()
})

test('a new session restores what the store holds for the repo', async ($, on) => {
  const list = { id: 'rel', title: 'Release', steps: [{ id: 'step:a', label: 'a', owner: 'agent', state: 'running', startedAt: 1_000_000 }], createdAt: 1, updatedAt: 1 }
  world(on, { 'repo:o/r': { version: 1, tracks: [], lists: [list], history: [], logShas: {}, contains: {}, alerts: [], trust: null } })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Release ▣\s+a running/ })).toBeDefined()
})


test('/track polls on the clock and draws the PR line; gh errors back off and show on the bar', async ($, on) => {
  const clock = world(on)
  let fail = false
  const gh = fakeGh([
    ['pr view 42', pr({ statusCheckRollup: [check(null)] })],
    REPO_VIEW,
  ])
  on('process.run', async ($, e) => (fail ? { value: { exitCode: 1, stdout: '', stderr: 'HTTP 502: bad gateway', isStdoutTruncated: false, isStderrTruncated: false } } : { value: await gh.run(e.argv) }))
  await start($)
  const out = await $.command.run({ command: 'track', args: '42' } as never)
  expect(out.text).toBe('tracking o/r#42')
  expect(gh.calls.length).toBe(0) // the hook only records; the clock polls
  await clock.advance(5_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /#42 ▣□□\s+PR CI running/ })).toBeDefined()
  expect(gh.calls.every(a => a[0] === 'gh')).toBe(true)

  fail = true
  await clock.advance(20_000)
  expect(await ui.find({ type: 'Text', text: /⚠ gh: HTTP 502: bad gateway/ })).toBeDefined()
  const before = gh.calls.length
  fail = false
  await clock.advance(20_000) // backed off to 40 s: no poll yet
  expect(gh.calls.length).toBe(before)
  await clock.advance(25_000)
  expect(gh.calls.length).toBeGreaterThan(before)
  expect(await ui.find({ type: 'Text', text: /⚠ gh:/ })).toBeUndefined()

  const listed = await $.command.run({ command: 'track', args: '' } as never)
  expect(listed.text).toMatch(/#42 /)
  expect((await $.command.run({ command: 'untrack', args: '#42' } as never)).text).toBe('stopped tracking o/r#42')
  expect((await $.command.run({ command: 'track', args: '' } as never)).text).toMatch(/recent:\n  o\/r#42 untracked/)
})
