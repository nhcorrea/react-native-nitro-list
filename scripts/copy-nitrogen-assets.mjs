import {cpSync, existsSync, mkdirSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const relative = join('nitrogen', 'generated', 'shared', 'json')
const from = join(root, relative)
const to = join(root, 'lib', relative)

if (!existsSync(from)) {
  console.log(`no ${relative} to copy (no Nitro views in this package)`)
  process.exit(0)
}

mkdirSync(dirname(to), {recursive: true})
cpSync(from, to, {recursive: true})
console.log(`copied ${relative} -> lib/${relative}`)
