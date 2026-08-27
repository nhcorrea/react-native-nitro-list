import {readdirSync, readFileSync, statSync, existsSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

import {renderViewConfigModule, SOURCE_JSON, TARGET_TS} from './sync-view-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const posix = (absolute) => relative(root, absolute).split(sep).join('/');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * Every relative specifier reachable from the built output must resolve on disk.
 *
 * bob copies relative specifiers verbatim from `src/` into `lib/module/` and
 * `lib/commonjs/`, so any import that escapes the source root silently changes
 * meaning: `../foo` means `<root>/foo` in `src/` but `<root>/lib/foo` in the build.
 * That shipped once (v2.1.0 could not resolve the nitrogen view config) precisely
 * because nothing here ever tried to follow the built graph.
 */
const SPECIFIER = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"])([^'"]+)\1/g;
const RESOLVE_SUFFIXES = ['', '.js', '.json', '.cjs', '.mjs', '/index.js'];

function assertRelativeImportsResolve(file) {
  const source = readFileSync(file, 'utf8');
  for (const [, , specifier] of source.matchAll(SPECIFIER)) {
    if (!specifier.startsWith('.')) continue;
    const from = dirname(file);
    const resolved = RESOLVE_SUFFIXES.some((suffix) =>
      existsSync(resolve(from, `${specifier}${suffix}`)),
    );
    if (!resolved) {
      failures.push(`unresolvable relative import "${specifier}" in ${posix(file)}`);
    }
  }
}

for (const [subpath, conditions] of Object.entries(pkg.exports)) {
  if (subpath === './package.json') continue;
  for (const condition of Object.values(conditions)) {
    for (const target of Object.values(condition)) {
      if (!existsSync(join(root, target))) {
        failures.push(`exports[${subpath}] points at missing file: ${target}`);
      }
    }
  }
}

for (const flavor of ['module', 'commonjs']) {
  const base = join(root, 'lib', flavor);
  const files = walk(base).filter((file) => file.endsWith('.js'));

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const inKeyboard = file.includes(`${flavor}/keyboard/`);
    if (!inKeyboard && source.includes('react-native-keyboard-controller')) {
      failures.push(`optional peer leaked outside the keyboard subpath: ${file}`);
    }
    assertRelativeImportsResolve(file);
  }

  const keyboardEntry = join(base, 'keyboard', 'KeyboardAwareNitroList.js');
  const keyboardSource = readFileSync(keyboardEntry, 'utf8');
  if (!/["']\.\.\/NitroList(\.js)?["']/.test(keyboardSource)) {
    failures.push(`keyboard entry does not import the core by module reference: ${keyboardEntry}`);
  }
  const sectionEntry = join(base, 'section-list', 'NitroSectionList.js');
  const sectionSource = readFileSync(sectionEntry, 'utf8');
  if (!/["']\.\.\/NitroList(\.js)?["']/.test(sectionSource)) {
    failures.push(`section-list entry does not import the core by module reference: ${sectionEntry}`);
  }

  const mainEntry = readFileSync(join(base, 'index.js'), 'utf8');
  for (const forbidden of ['keyboard', 'section-list', 'react-native-keyboard-controller']) {
    if (mainEntry.includes(forbidden)) {
      failures.push(`main ${flavor} entry references "${forbidden}" — subpath leaked into "."`);
    }
  }
}

if (pkg.sideEffects !== false) {
  failures.push('package.json sideEffects must be false');
}

// The mirrored view config must match whatever nitrogen last emitted, otherwise the
// build ships a stale prop list.
try {
  const expected = renderViewConfigModule();
  const actual = existsSync(TARGET_TS) ? readFileSync(TARGET_TS, 'utf8') : null;
  if (actual !== expected) {
    failures.push(
      `${posix(TARGET_TS)} is out of sync with ${posix(SOURCE_JSON)} — ` +
        'run `node scripts/sync-view-config.mjs`',
    );
  }
} catch (error) {
  failures.push(`view config check failed: ${error.message}`);
}

if (failures.length > 0) {
  console.error('build verification failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  'build verification OK — subpaths isolated, optional peers contained, relative imports resolve',
);
