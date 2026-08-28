// Types are kept in sync with release.config.cjs by hand: every type allowed here
// either cuts a version or shows up in the changelog. `build` and `style` are
// deliberately absent — a build-config change that reaches the published
// artifact is a `fix`, and typing it `build` would ship it with no release.
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'perf', 'refactor', 'docs', 'chore', 'test', 'ci', 'revert'],
    ],
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
    'body-max-line-length': [0],
  },
}
