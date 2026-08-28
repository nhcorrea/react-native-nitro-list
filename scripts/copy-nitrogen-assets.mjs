// bob emits src/*.js into lib/module/ and lib/commonjs/ — one level deeper than
// the source — so the literal "../nitrogen/..." specifier in NitroListHost stops
// pointing at the package root and lands on lib/nitrogen/ instead. Mirror the
// generated json there so the same relative path resolves from both flavors.
import {cpSync, existsSync, mkdirSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const relative = join('nitrogen', 'generated', 'shared', 'json')
const from = join(root, relative)
const to = join(root, 'lib', relative)

if (!existsSync(from)) {
  console.error(`missing generated nitro config: ${relative} — run nitrogen first`)
  process.exit(1)
}

mkdirSync(dirname(to), {recursive: true})
cpSync(from, to, {recursive: true})
console.log(`copied ${relative} -> lib/${relative}`)
