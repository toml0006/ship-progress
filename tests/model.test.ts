import { describe, expect, test } from 'claude-code/testing'

import { parseInput } from '../hooks/lib/input'
import { parsePr, plainLine, repoFromRemote, trackLine } from '../hooks/lib/model'
import { listSet, migrate, newTrack, setListStep, sweep, emptyPersisted } from '../hooks/lib/ops'

describe('parsePr', () => {
  test('reads every spelling', () => {
    expect(parsePr('608', 'o/r')).toEqual({ repo: 'o/r', number: 608 })
    expect(parsePr('#608', 'o/r')).toEqual({ repo: 'o/r', number: 608 })
    expect(parsePr('a/b#7', 'o/r')).toEqual({ repo: 'a/b', number: 7 })
    expect(parsePr('https://github.com/a/b/pull/9/files', null)).toEqual({ repo: 'a/b', number: 9 })
    expect('error' in parsePr('12', null)).toBe(true)
    expect('error' in parsePr('nope', 'o/r')).toBe(true)
  })
  test('reads remotes', () => {
    expect(repoFromRemote('git@github.com:toml0006/ship-progress.git')).toBe('toml0006/ship-progress')
    expect(repoFromRemote('https://github.com/a/b')).toBe('a/b')
    expect(repoFromRemote(null)).toBe(null)
  })
})

describe('parseInput', () => {
  test('rejects unknown fields with a clear error', () => {
    expect(() => parseInput({ action: 'status', bogus: 1 })).toThrow(/unknown field\(s\) for "status": bogus/)
    expect(() => parseInput({ action: 'nope' })).toThrow(/"action" must be one of/)
    expect(() => parseInput({ action: 'set_step', name: 'x', state: 'passed' })).toThrow(/exactly one of "pr" or "list"/)
  })
  test('ignores the engine envelope and accepts JSON-string nesting', () => {
    const got = parseInput({ tool: 't', tool_use_id: 'u', action: 'list_set', list: 'l', title: 'T', steps: '[{"name":"a"},{"name":"b","state":"running"}]' })
    expect(got).toEqual({ action: 'list_set', list: 'l', title: 'T', steps: [{ name: 'a' }, { name: 'b', state: 'running' }] })
    expect(parseInput('{"action":"status"}')).toEqual({ action: 'status' })
  })
  test('validates step states', () => {
    expect(() => parseInput({ action: 'list_set', list: 'l', title: 'T', steps: [{ name: 'a', state: 'done' }] })).toThrow(/steps\[0\]\.state/)
  })
})

describe('task lists', () => {
  test('list_set keeps state of existing steps and set_step ends the list', () => {
    let lists = listSet([], 'l', 'Release', [{ name: 'build' }, { name: 'ship' }], 1000)
    lists = setListStep(lists, 'l', 'build', 'passed', undefined, 2000)
    lists = listSet(lists, 'l', 'Release', [{ name: 'build' }, { name: 'ship' }, { name: 'tag', after: 'build' }], 3000)
    expect(lists[0]!.steps.map(s => `${s.label}:${s.state}`)).toEqual(['build:passed', 'tag:pending', 'ship:pending'])
    lists = setListStep(lists, 'l', 'tag', 'skipped', undefined, 4000)
    lists = setListStep(lists, 'l', 'ship', 'passed', undefined, 5000)
    expect(lists[0]!.endedAt).toBe(5000)
    expect(() => setListStep(lists, 'l', 'nope', 'passed', undefined, 1)).toThrow(/no step "nope"/)
  })
})

describe('persistence', () => {
  test('unknown versions start empty; sweep moves lingering tracks to history', () => {
    expect(migrate({ version: 99, tracks: [1] })).toEqual(emptyPersisted())
    expect(migrate('garbage')).toEqual(emptyPersisted())
    const done = { ...newTrack('o/r', 1, 0), status: 'done' as const, endedAt: 1000, mergeSha: 'abc' }
    const p = sweep({ ...emptyPersisted(), tracks: [done, newTrack('o/r', 2, 0)] }, 1000 + 10 * 60_000)
    expect(p.tracks.map(t => t.number)).toEqual([2])
    expect(p.history).toEqual([{ key: 'o/r#1', title: undefined, status: 'done', sha: 'abc', endedAt: 1000 }])
  })
})

describe('bar line', () => {
  test('formats a running deploy', () => {
    const t = newTrack('o/r', 608, 0)
    t.stages = [
      { id: 'pr-ci', label: 'PR CI', owner: 'mod', state: 'passed' },
      { id: 'merged', label: 'merged', owner: 'mod', state: 'passed' },
      { id: 'main-ci', label: 'main CI', owner: 'mod', state: 'passed' },
      { id: 'deploy:web', label: 'web', owner: 'mod', state: 'running', startedAt: 0 },
      { id: 'check:x', label: 'x', owner: 'mod', state: 'pending' },
    ]
    t.mergeSha = 'c0607dcbdeadbeef'
    expect(plainLine(trackLine(t, 4 * 60_000, 'o/r'))).toBe('#608 ■■■▣□  deploying (web) 4m c0607dcb')
    expect(plainLine(trackLine(t, 4 * 60_000, 'x/y'))).toMatch(/^o\/r#608 /)
  })
})
