import type { Stage, Track } from '../../types'
import type { Config } from './config'
import { shortSha } from './model'

export type Alert = { key: string; text: string; url?: string }

const name = (t: Track, repo: string | null) => (t.repo === repo ? `#${t.number}` : `${t.repo}#${t.number}`)

const stageText = (s: Stage) => `${s.id} ${s.state}${s.note ? `: ${s.note}` : ''}`

/**
 * The alerts a poll raised: each stage that moved into a state `notify.on` lists,
 * and the track going live. The key names the track, stage, state and what the
 * state is about (a run, a head SHA), so each fires once and a new failure on a
 * new run fires again.
 */
export const transitions = (prev: Track | undefined, next: Track, notify: Config['notify'], repo: string | null): Alert[] => {
  const out: Alert[] = []
  for (const s of next.stages) {
    const before = prev?.stages.find(x => x.id === s.id)
    if (before?.state === s.state || !notify.on.includes(s.state)) continue
    out.push({ key: `${next.key}|${s.id}|${s.state}|${s.ref ?? ''}`, text: `${name(next, repo)} ${stageText(s)}`, url: s.url ?? next.url })
  }
  if (next.status === 'done' && prev?.status !== 'done' && notify.on.includes('done')) {
    const sha = next.deployedSha ?? next.mergeSha
    out.push({ key: `${next.key}|done`, text: `${name(next, repo)} live${sha ? ` (${shortSha(sha)})` : ''}${next.title ? `: ${next.title}` : ''}`, url: next.url })
  }
  return out
}

/** Escapes text for an AppleScript string literal. */
export const appleScriptString = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`

export const osascriptArgv = (text: string) => ['osascript', '-e', `display notification ${appleScriptString(text)} with title "ship-progress"`]
