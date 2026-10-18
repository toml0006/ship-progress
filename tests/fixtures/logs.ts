/**
 * Excerpt in the shape `gh run view --log` prints: job, step, timestamp, line.
 * A workflow_run deploy: the run's headSha is the branch tip when CI finished,
 * but the job checks out and resets to the commit it deploys.
 */
export const DEPLOY_WEB_LOG = [
  'deploy\tSet up job\t2026-10-18T10:20:01.0000000Z Current runner version: 2.330.0',
  'deploy\tCheckout\t2026-10-18T10:20:04.0000000Z HEAD is now at 0a1b2c3 chore: earlier commit',
  'deploy\tSync to CI commit\t2026-10-18T10:20:09.0000000Z \u001b[36mHEAD is now at def5678 feat: add thing (#42)\u001b[0m',
  'deploy\tDeploy\t2026-10-18T10:23:40.0000000Z deployed web',
].join('\n')

export const LOG_WITHOUT_SHA = 'deploy\tSet up job\t2026-10-18T10:20:01.0000000Z runner lost\n'
