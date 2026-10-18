/** What a Bash command tells us about a PR to track. */
export type Hit =
  /** The PR is known from the command or its output. */
  | { kind: 'pr'; ref: string }
  /** The PR is the current branch's; resolve it with `gh pr view` on a tick. */
  | { kind: 'branch' }

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/
/** `gh pr merge` prints `✓ Squashed and merged pull request owner/repo#123 (title)`. */
const PR_REF = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/

/** The command's segments: split on `&&`, `||`, `;`, `|` and newlines. */
const segments = (command: string) => command.split(/&&|\|\||[;|\n]/).map(s => s.trim()).filter(Boolean)

const words = (segment: string): string[] => segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []

/** The PR argument after `gh pr <verb>`, skipping flags (and a flag's value where it takes one). */
const prArg = (args: string[]) => {
  const valued = new Set(['-R', '--repo', '-t', '--title', '-b', '--body', '-F', '--body-file', '--subject', '--author-email', '--match-head-commit'])
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (valued.has(a)) i++
    else if (!a.startsWith('-')) return a.replace(/^['"]|['"]$/g, '')
  }
  return undefined
}

const repoFlag = (args: string[]) => {
  const i = args.findIndex(a => a === '-R' || a === '--repo')
  if (i >= 0) return args[i + 1]
  return args.find(a => a.startsWith('--repo='))?.slice('--repo='.length)
}

/** The subcommand after `git`, skipping global options (`-C <dir>`, `-c <k=v>`, `--no-pager`). */
const gitSubcommand = (w: string[]) => {
  const at = w.indexOf('git')
  if (at < 0) return undefined
  for (let i = at + 1; i < w.length; i++) {
    const a = w[i]!
    if (a === '-C' || a === '-c') i++
    else if (!a.startsWith('-')) return a
  }
  return undefined
}

/**
 * Reads one Bash call: `gh pr create`, `gh pr merge`, `gh pr ready` and `git push`.
 * The output is read first (it names the PR exactly); then the argument; then the branch.
 */
export const matchCommand = (command: string, output: string): Hit | undefined => {
  for (const seg of segments(command)) {
    const w = words(seg)
    const at = w.findIndex((x, i) => x === 'gh' && w[i + 1] === 'pr')
    if (at >= 0) {
      const verb = w[at + 2]
      const args = w.slice(at + 3)
      if (!['create', 'merge', 'ready'].includes(verb ?? '') || args.includes('--help') || args.includes('-h')) continue
      const url = PR_URL.exec(output)
      if (url) return { kind: 'pr', ref: url[0] }
      const ref = PR_REF.exec(output)
      if (ref && verb !== 'create') return { kind: 'pr', ref: `${ref[1]}#${ref[2]}` }
      const arg = verb === 'create' ? undefined : prArg(args)
      if (arg && /^(#?\d+|https:\/\/github\.com\/\S+\/pull\/\d+)$/.test(arg)) {
        const repo = repoFlag(args)
        return { kind: 'pr', ref: repo && /^#?\d+$/.test(arg) ? `${repo}#${arg.replace('#', '')}` : arg }
      }
      return { kind: 'branch' }
    }
    if (gitSubcommand(w) === 'push') {
      if (w.includes('--tags') || w.includes('--delete') || w.includes('-d')) continue
      return { kind: 'branch' }
    }
  }
  return undefined
}
