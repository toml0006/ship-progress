# ship-progress

A Claude Code mod that shows a live progress bar above the prompt for each pull request:

```
#608 ■■■■□  deploying (web)  4m   c0607dcb
```

It follows each PR through **PR CI → merged → main CI → deploy → custom checks**. It polls `gh` on a timer, so the agent doesn't spend turns watching CI, and it alerts on failures or completion: it wakes the agent and posts a macOS notification, plus a Slack message if you configure one. It only watches; it never merges, reruns or retargets anything.

Each repo describes its pipeline in a committed `.claude/ship-progress.json`: which workflow is CI, which ones deploy, how to read the commit that was actually deployed, and any post-deploy checks.

**Status:** specification only. See [SPEC.md](SPEC.md).

## Local development

```sh
claude --plugin-dir /path/to/ship-progress
```

## License

MIT
