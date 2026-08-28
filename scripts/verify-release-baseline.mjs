// semantic-release derives the last released version from git tags. With no tags
// it assumes a first release and publishes 1.0.0 — over a package already on 2.x.
// That is not hypothetical: it happened on the first automated run of this repo,
// because the history had never been tagged. Tags go missing for mundane reasons
// too — a shallow checkout that skipped them, a deleted tag, a fresh fork — and
// the damage is a burned version number that npm never lets you reuse.
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const {name} = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const tags = execFileSync('git', ['tag', '--list', 'v*'], {cwd: root, encoding: 'utf8'})
  .split('\n')
  .filter(Boolean)

if (tags.length > 0) {
  console.log(`release baseline OK — ${tags.length} version tag(s) visible to semantic-release`)
  process.exit(0)
}

const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
  headers: {accept: 'application/vnd.npm.install-v1+json'},
})

if (response.status === 404) {
  console.log(`release baseline OK — no tags, but ${name} has never been published`)
  process.exit(0)
}

if (!response.ok) {
  console.error(`release baseline check failed: registry returned ${response.status} for ${name}`)
  process.exit(1)
}

const {versions = {}} = await response.json()
const published = Object.keys(versions)

console.error('release baseline check failed: no git tags, but the package is already published')
console.error(`  ${name} has ${published.length} version(s) on npm: ${published.join(', ')}`)
console.error('  semantic-release would treat this as a first release and publish 1.0.0.')
console.error('  Fix: tag the current baseline and push it, e.g.')
console.error('    git tag -a v<last-released-version> <commit> -m "v<last-released-version>"')
console.error('    git push origin v<last-released-version>')
console.error('  If the checkout is shallow, set `fetch-depth: 0` so tags are fetched.')
process.exit(1)
