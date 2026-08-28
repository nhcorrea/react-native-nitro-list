// verify-build.mjs checks lib/ on disk; this checks the tarball npm would ship.
// The difference matters: a file can exist locally and still be missing from the
// published package (absent from "files"), or a relative specifier can resolve
// locally and point outside the packed tree. Both break only the consumer, which
// is exactly how the lib/nitrogen regression reached npm.
import {execFileSync} from 'node:child_process'
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs'
import {dirname, join, posix, relative, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const failures = []

// --ignore-scripts is load-bearing: prepack calls into this file's siblings, and
// a pack that re-ran lifecycle scripts would recurse.
// Inside a lifecycle script npm puts node_modules/.bin ahead of PATH, where a
// transitive npm copy shadows the real CLI. npm_execpath is the one actually
// running us; only fall back to PATH when invoked outside npm.
const execpath = process.env.npm_execpath
const [command, prefixArgs] = execpath
  ? execpath.endsWith('.js')
    ? [process.execPath, [execpath]]
    : [execpath, []]
  : ['npm', []]

let packOutput
try {
  packOutput = execFileSync(
    command,
    [...prefixArgs, 'pack', '--dry-run', '--json', '--ignore-scripts'],
    {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}
  )
} catch (error) {
  console.error('package verification failed: could not list the tarball contents')
  console.error(String(error.stderr || error.message).trim())
  process.exit(1)
}
const shipped = new Set(JSON.parse(packOutput)[0].files.map((file) => file.path))

const toPackagePath = (absolute) => relative(root, absolute).split(/[\\/]/).join(posix.sep)

function firstShipped(packagePath) {
  const candidates = [
    packagePath,
    `${packagePath}.js`,
    `${packagePath}.ts`,
    `${packagePath}.tsx`,
    posix.join(packagePath, 'index.js'),
    posix.join(packagePath, 'index.ts'),
    posix.join(packagePath, 'index.tsx'),
  ]
  return candidates.find((candidate) => shipped.has(candidate))
}

// Entry points declared in package.json must exist inside the tarball.
const entries = []
for (const field of ['main', 'module', 'types', 'react-native', 'source']) {
  if (pkg[field]) entries.push([field, pkg[field]])
}
for (const [subpath, conditions] of Object.entries(pkg.exports ?? {})) {
  if (typeof conditions === 'string') {
    entries.push([`exports[${subpath}]`, conditions])
    continue
  }
  for (const condition of Object.values(conditions)) {
    for (const target of Object.values(condition)) {
      entries.push([`exports[${subpath}]`, target])
    }
  }
}
for (const [label, target] of entries) {
  if (!firstShipped(target.replace(/^\.\//, ''))) {
    failures.push(`${label} points at "${target}", which the tarball does not contain`)
  }
}

// Every relative specifier emitted into lib/ must resolve to a shipped file.
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const libDir = join(root, 'lib')
if (!existsSync(libDir)) {
  failures.push('lib/ is missing — run the build before verifying the package')
} else {
  for (const file of walk(libDir).filter((entry) => entry.endsWith('.js'))) {
    const packagePath = toPackagePath(file)
    if (!shipped.has(packagePath)) continue

    const source = readFileSync(file, 'utf8')
    const specifiers = [...source.matchAll(/(?:from|require\()\s*["'](\.[^"']+)["']/g)]
    for (const [, specifier] of specifiers) {
      const target = toPackagePath(resolve(dirname(file), specifier))
      if (target.startsWith('..')) {
        failures.push(`"${specifier}" in ${packagePath} escapes the package root`)
      } else if (!firstShipped(target)) {
        failures.push(`"${specifier}" in ${packagePath} resolves to "${target}", which is not shipped`)
      }
    }
  }
}

if (failures.length > 0) {
  console.error('package verification failed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`package verification OK — ${shipped.size} files shipped, every entry point and relative import resolves`)
