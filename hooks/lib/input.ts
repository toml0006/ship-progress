import type { StageState } from '../../types'

export const ACTIONS = ['track', 'untrack', 'annotate', 'add_step', 'set_step', 'list_set', 'status'] as const
export type Action = (typeof ACTIONS)[number]

/** States an agent may set on its own steps; `superseded` is the mod's alone. */
export const STEP_STATES = ['pending', 'running', 'passed', 'failed', 'skipped', 'warning'] as const

export type StepSpec = { name: string; state?: StageState; after?: string }

export type ToolInput =
  | { action: 'track'; pr: string }
  | { action: 'untrack'; pr: string }
  | { action: 'annotate'; pr: string; stage?: string; note: string }
  | { action: 'add_step'; pr: string; name: string; after?: string }
  | { action: 'set_step'; pr?: string; list?: string; name: string; state: StageState; note?: string }
  | { action: 'list_set'; list: string; title: string; steps: StepSpec[] }
  | { action: 'status' }

const FIELDS: Record<Action, { required: string[]; optional: string[] }> = {
  track: { required: ['pr'], optional: [] },
  untrack: { required: ['pr'], optional: [] },
  annotate: { required: ['pr', 'note'], optional: ['stage'] },
  add_step: { required: ['pr', 'name'], optional: ['after'] },
  set_step: { required: ['name', 'state'], optional: ['pr', 'list', 'note'] },
  list_set: { required: ['list', 'title', 'steps'], optional: [] },
  status: { required: [], optional: [] },
}

/** Fields the engine puts beside a tool's arguments on `e`; never the model's. */
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta'])

/** Some models send nested values as JSON text; read those back. */
const unstring = (value: unknown) => {
  if (typeof value !== 'string') return value
  const t = value.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return value
  try {
    return JSON.parse(t) as unknown
  } catch {
    return value
  }
}

const text = (v: unknown, field: string, max = 200): string => {
  if (typeof v === 'number' && field === 'pr') return String(v)
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${field}" must be a non-empty string`)
  if (v.length > max) throw new Error(`"${field}" is longer than ${max} characters`)
  return v.trim()
}

const state = (v: unknown, field: string): StageState => {
  if (!(STEP_STATES as readonly unknown[]).includes(v)) throw new Error(`"${field}" must be one of ${STEP_STATES.join(', ')}`)
  return v as StageState
}

const step = (raw: unknown, i: number): StepSpec => {
  const v = unstring(raw)
  if (typeof v === 'string') return { name: text(v, `steps[${i}]`, 80) }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`steps[${i}] must be an object { name, state?, after? }`)
  const o = v as Record<string, unknown>
  const extra = Object.keys(o).filter(k => !['name', 'state', 'after'].includes(k))
  if (extra.length) throw new Error(`steps[${i}] has unknown field(s): ${extra.join(', ')}`)
  return {
    name: text(o.name, `steps[${i}].name`, 80),
    ...(o.state !== undefined && { state: state(o.state, `steps[${i}].state`) }),
    ...(o.after !== undefined && { after: text(o.after, `steps[${i}].after`, 80) }),
  }
}

/** Validates the `ship_progress` tool's input against a closed schema; throws a readable error. */
export const parseInput = (raw: unknown): ToolInput => {
  const top = unstring(raw)
  if (typeof top !== 'object' || top === null || Array.isArray(top)) throw new Error('input must be an object')
  const o = Object.fromEntries(Object.entries(top as Record<string, unknown>).filter(([k]) => !RESERVED.has(k)))
  const action = o.action
  if (!(ACTIONS as readonly unknown[]).includes(action)) throw new Error(`"action" must be one of ${ACTIONS.join(', ')}`)
  const spec = FIELDS[action as Action]
  const allowed = new Set(['action', ...spec.required, ...spec.optional])
  const unknown = Object.keys(o).filter(k => !allowed.has(k) && o[k] !== undefined && o[k] !== null)
  if (unknown.length) throw new Error(`unknown field(s) for "${String(action)}": ${unknown.join(', ')} (allowed: ${[...allowed].join(', ')})`)
  const missing = spec.required.filter(k => o[k] === undefined || o[k] === null)
  if (missing.length) throw new Error(`"${String(action)}" needs: ${missing.join(', ')}`)
  const opt = (k: string, max?: number) => (o[k] === undefined || o[k] === null ? {} : { [k]: text(o[k], k, max) })

  switch (action as Action) {
    case 'track':
    case 'untrack':
      return { action: action as 'track', pr: text(o.pr, 'pr') }
    case 'annotate':
      return { action: 'annotate', pr: text(o.pr, 'pr'), note: text(o.note, 'note', 160), ...opt('stage') }
    case 'add_step':
      return { action: 'add_step', pr: text(o.pr, 'pr'), name: text(o.name, 'name', 80), ...opt('after') }
    case 'set_step': {
      const hasPr = o.pr !== undefined && o.pr !== null
      const hasList = o.list !== undefined && o.list !== null
      if (hasPr === hasList) throw new Error('"set_step" needs exactly one of "pr" or "list"')
      return { action: 'set_step', name: text(o.name, 'name', 80), state: state(o.state, 'state'), ...opt('pr'), ...opt('list'), ...opt('note', 160) }
    }
    case 'list_set': {
      const steps = unstring(o.steps)
      if (!Array.isArray(steps) || steps.length === 0) throw new Error('"steps" must be a non-empty array')
      if (steps.length > 30) throw new Error('"steps" holds at most 30 steps')
      return { action: 'list_set', list: text(o.list, 'list', 60), title: text(o.title, 'title', 60), steps: steps.map(step) }
    }
    case 'status':
      return { action: 'status' }
  }
}

/** The tool's JSON schema, as the model sees it. */
export const INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: [...ACTIONS] },
    pr: { type: 'string', description: 'A PR: 608, #608, owner/repo#608 or its URL.' },
    list: { type: 'string', description: 'A task list id (list_set, set_step).' },
    title: { type: 'string', description: 'The task list title (list_set).' },
    name: { type: 'string', description: 'A step name (add_step, set_step).' },
    stage: { type: 'string', description: 'A stage id to annotate: pr-ci, merged, main-ci, deploy:<name>, check:<name>, or a step name.' },
    after: { type: 'string', description: 'Place the new step after this stage id or step name (add_step).' },
    state: { type: 'string', enum: [...STEP_STATES] },
    note: { type: 'string', description: 'A short note, under 160 characters.' },
    steps: {
      type: 'array',
      description: 'The list steps in order (list_set).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          state: { type: 'string', enum: [...STEP_STATES] },
          after: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  required: ['action'],
} as const
