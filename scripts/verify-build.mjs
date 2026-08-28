import {readdirSync, readFileSync, statSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
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

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const specifiers = [...source.matchAll(/(?:from|require\()\s*["'](\.[^"']+)["']/g)].map((m) => m[1]);
    for (const specifier of specifiers) {
      const target = resolve(dirname(file), specifier);
      const resolved = [target, `${target}.js`, join(target, 'index.js')].some(existsSync);
      if (!resolved) {
        failures.push(`unresolvable relative import "${specifier}" in ${file}`);
      }
    }
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

if (failures.length > 0) {
  console.error('build verification failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('build verification OK — subpaths isolated, optional peers contained');
