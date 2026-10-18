import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

const TOOL = 'mcp__ship-progress__ship_progress'
const BAND = { plugin: 'ship-progress', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const

/** The world beneath the plugin: a repo, registrations accepted, clock and store in memory. */
const world = (on: On, store: Record<string, unknown> = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, store)
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
