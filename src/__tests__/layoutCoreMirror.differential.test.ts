import {execFileSync, execSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {describe, expect, it} from '@jest/globals';

import {LayoutCoreMirror} from './helpers/layoutCoreMirror';

const CPP_DIR = path.resolve(__dirname, '..', '..', 'cpp');
const SOURCES = [
  path.join(CPP_DIR, 'LayoutCore.hpp'),
  path.join(CPP_DIR, 'LayoutCore.cpp'),
  path.join(CPP_DIR, 'tests', 'LayoutCoreTests.cpp'),
];

function findCompiler(): string | null {
  for (const candidate of ['clang++', 'g++']) {
    try {
      execSync(`command -v ${candidate}`, {stdio: 'ignore'});
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function sourceFingerprint(): string {
  return SOURCES.map((file) => {
    const stat = fs.statSync(file);
    return `${path.basename(file)}:${stat.size}:${stat.mtimeMs}`;
  })
    .join('|')
    .replace(/[^a-zA-Z0-9]/g, '_');
}

function ensureReplayBinary(compiler: string): string {
  const binary = path.join(os.tmpdir(), `nitrolist-replay-${sourceFingerprint()}`);
  if (!fs.existsSync(binary)) {
    execFileSync(
      compiler,
      [
        '-std=c++20',
        '-O1',
        `-I${CPP_DIR}`,
        path.join(CPP_DIR, 'tests', 'LayoutCoreTests.cpp'),
        path.join(CPP_DIR, 'LayoutCore.cpp'),
        '-o',
        binary,
      ],
      {timeout: 120_000},
    );
  }
  return binary;
}

type Dump = {
  probes: number[];
  layoutVersion: number;
  totalSize: number;
  itemCount: number;
  offsets: number[];
  sizes: number[];
};

function replay(binary: string, commands: string[], tag: string): Dump {
  const scriptFile = path.join(os.tmpdir(), `nitrolist-replay-ops-${tag}-${process.pid}.txt`);
  fs.writeFileSync(scriptFile, commands.join('\n') + '\n');
  let raw: string;
  try {
    raw = execFileSync(binary, ['--dump-json', scriptFile], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 256 * 1024 * 1024,
    });
  } finally {
    fs.unlinkSync(scriptFile);
  }
  return JSON.parse(raw) as Dump;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Script = {
  commands: string[];
  mirrorProbes: number[];
  mirror: LayoutCoreMirror;
  itemCount: number;
};

function generateScript(seed: number, steps: number): Script {
  const rng = mulberry32(seed);
  const mirror = new LayoutCoreMirror();
  const commands: string[] = [];
  const probes: number[] = [];
  let itemCount = 200;
  let clockMs = 1000;

  const push = (line: string) => commands.push(line);

  push(`count ${itemCount}`);
  mirror.setItemCount(itemCount);
  push('estimate 100');
  mirror.setEstimate(100);
  push('epsilon 0.51');
  mirror.setMeasurementEpsilon(0.51);
  push('typeavg 1');
  mirror.setTypeAverages(true);
  push('directional 1');
  mirror.setDirectionalBuffers(true);
  push(`clock ${clockMs}`);
  mirror.setClock(() => clockMs);

  const assignTypes = () => {
    const types: number[] = [];
    for (let i = 0; i < itemCount; i++) {
      types.push(1 + ((i + Math.floor(rng() * 3)) % 3));
    }
    push(`types ${itemCount} ${types.join(' ')}`);
    mirror.setItemTypes(types, itemCount);
  };
  assignTypes();

  const probeAll = () => {
    push('total');
    probes.push(mirror.getTotalSize());
    push('version');
    probes.push(mirror.getLayoutVersion());
    for (let k = 0; k < 5 && itemCount > 0; k++) {
      const idx = Math.floor(rng() * itemCount);
      push(`offset ${idx}`);
      probes.push(mirror.getOffset(idx));
      push(`sizeof ${idx}`);
      probes.push(mirror.getSize(idx));
    }
  };

  for (let step = 0; step < steps; step++) {
    const roll = rng();
    if (roll < 0.3) {
      const idx = Math.floor(rng() * Math.max(1, itemCount));
      const size = rng() * 280 + 8;
      push(`size ${idx} ${size}`);
      mirror.setItemSize(idx, size);
    } else if (roll < 0.55) {
      const n = 1 + Math.floor(rng() * 8);
      const pairs: number[] = [];
      for (let p = 0; p < n; p++) {
        pairs.push(Math.floor(rng() * Math.max(1, itemCount)));
        pairs.push(rng() * 280 + 8);
      }
      push(`batch ${n} ${pairs.join(' ')}`);
      mirror.setItemSizes(pairs, n, 1);
    } else if (roll < 0.62) {
      const anchor = Math.floor(rng() * Math.max(1, itemCount));
      const n = 1 + Math.floor(rng() * 4);
      const pairs: number[] = [];
      for (let p = 0; p < n; p++) {
        pairs.push(Math.floor(rng() * Math.max(1, itemCount)));
        pairs.push(rng() * 280 + 8);
      }
      push(`anchored ${anchor} ${n} ${pairs.join(' ')}`);
      probes.push(mirror.setItemSizesAnchored(pairs, n, 1, anchor));
    } else if (roll < 0.72) {
      clockMs += 4 + Math.floor(rng() * 40);
      push(`clock ${clockMs}`);
      const scroll = rng() * Math.max(1, mirror.getTotalSize());
      const viewport = 400 + rng() * 500;
      const draw = rng() < 0.5 ? 250 : 50;
      push(`range ${scroll} ${viewport} ${draw}`);
      const range = mirror.getEngagedRange(scroll, viewport, draw);
      probes.push(range.start, range.end, range.version);
    } else if (roll < 0.78) {
      const next = Math.floor(rng() * 400);
      push(`count ${next}`);
      mirror.setItemCount(next);
      itemCount = next;
      if (itemCount > 0 && rng() < 0.7) assignTypes();
    } else if (roll < 0.83) {
      const estimate = 20 + rng() * 200;
      push(`estimate ${estimate}`);
      mirror.setEstimate(estimate);
    } else if (roll < 0.88) {
      const n = Math.max(1, Math.floor(itemCount * (0.5 + rng() * 0.5)));
      const shift = Math.floor(rng() * 5);
      const pairs: number[] = [];
      for (let p = 0; p < n; p++) {
        const oldIdx = Math.floor(rng() * Math.max(1, itemCount));
        const newIdx = Math.min(itemCount - 1, oldIdx + shift);
        if (newIdx < 0) continue;
        pairs.push(oldIdx, newIdx);
      }
      const pairCount = pairs.length / 2;
      if (pairCount > 0) {
        push(`remap ${pairCount} ${pairs.join(' ')}`);
        mirror.remapItemSizes(pairs, pairCount);
      }
    } else if (roll < 0.92) {
      const frozen = rng() < 0.5 ? 1 : 0;
      push(`freeze ${frozen}`);
      mirror.setEstimatesFrozen(frozen === 1);
    } else if (roll < 0.96) {
      const n = 1 + Math.floor(rng() * 3);
      const pairs: number[] = [];
      for (let p = 0; p < n; p++) {
        pairs.push(1 + Math.floor(rng() * 3));
        pairs.push(40 + rng() * 200);
      }
      push(`seed ${n} ${pairs.join(' ')}`);
      mirror.seedTypeMeans(pairs, n, 1);
    } else if (roll < 0.975) {
      push('reset');
      mirror.resetItemSizes();
    } else if (roll < 0.99) {
      const columns = 1 + Math.floor(rng() * 3);
      push(`columns ${columns}`);
      mirror.setColumnCount(columns);
    } else if (itemCount > 0) {
      const spans: number[] = [];
      for (let i = 0; i < itemCount; i++) {
        spans.push(rng() < 0.15 ? 1 + Math.floor(rng() * 3) : 1);
      }
      push(`spans ${itemCount} ${spans.join(' ')}`);
      mirror.setItemSpans(spans, itemCount);
    }
    if (step % 40 === 0) probeAll();
  }
  push('freeze 0');
  mirror.setEstimatesFrozen(false);
  probeAll();

  return {commands, mirrorProbes: probes, mirror, itemCount};
}

const compiler = findCompiler();
const describeIfCompiler = compiler != null ? describe : describe.skip;
if (compiler == null) {
  console.warn(
    '[nitro-list tests] no C++ compiler found — skipping the mirror × LayoutCore differential suite',
  );
}

describeIfCompiler('LayoutCore mirror differential (TS mirror × C++ core)', () => {
  it.each([[1337], [20260820], [424242]])(
    'replays the same random script on both implementations (seed %d)',
    (seed) => {
      const binary = ensureReplayBinary(compiler as string);
      const script = generateScript(seed, 400);
      const dump = replay(binary, script.commands, String(seed));

      expect(dump.itemCount).toBe(script.itemCount);
      expect(dump.probes.length).toBe(script.mirrorProbes.length);
      for (let i = 0; i < dump.probes.length; i++) {
        if (Math.abs(dump.probes[i] - script.mirrorProbes[i]) > 1e-3) {
          throw new Error(
            `probe ${i} diverged: core=${dump.probes[i]} mirror=${script.mirrorProbes[i]}`,
          );
        }
      }
      expect(dump.layoutVersion).toBe(script.mirror.getLayoutVersion());
      expect(Math.abs(dump.totalSize - script.mirror.getTotalSize())).toBeLessThanOrEqual(1e-3);
      for (let i = 0; i < script.itemCount; i++) {
        if (Math.abs(dump.offsets[i] - script.mirror.getOffset(i)) > 1e-3) {
          throw new Error(
            `offset[${i}] diverged: core=${dump.offsets[i]} mirror=${script.mirror.getOffset(i)}`,
          );
        }
        if (Math.abs(dump.sizes[i] - script.mirror.getSize(i)) > 1e-3) {
          throw new Error(
            `size[${i}] diverged: core=${dump.sizes[i]} mirror=${script.mirror.getSize(i)}`,
          );
        }
      }
    },
    120_000,
  );

  it(
    'keeps offsets exact at N = 100 000: core and mirror both match a double prefix sum bit for bit',
    () => {
      const binary = ensureReplayBinary(compiler as string);
      const count = 100_000;
      const estimate = 37.375;
      const mirror = new LayoutCoreMirror();
      const commands: string[] = [];
      const mirrorProbes: number[] = [];
      commands.push(`count ${count}`, `estimate ${estimate}`, 'epsilon 0.51');
      mirror.setItemCount(count);
      mirror.setEstimate(estimate);
      mirror.setMeasurementEpsilon(0.51);

      const sizes = new Float64Array(count);
      const pairs: number[] = [];
      for (let i = 0; i < count; i++) {
        const size = 20 + ((i * 7919) % 1024) / 8;
        sizes[i] = size;
        pairs.push(i, size);
      }
      commands.push(`batch ${count} ${pairs.join(' ')}`);
      mirror.setItemSizes(pairs, count, 1);

      const bump: number[] = [];
      for (let k = 0; k < 10; k++) {
        bump.push(90_000 + k, sizes[90_000 + k] + 1);
        sizes[90_000 + k] += 1;
      }
      commands.push(`anchored 95000 10 ${bump.join(' ')}`);
      mirrorProbes.push(mirror.setItemSizesAnchored(bump, 10, 1, 95_000));
      expect(mirrorProbes[0]).toBe(10);

      const expectedOffsets = new Float64Array(count);
      let running = 0;
      for (let i = 0; i < count; i++) {
        expectedOffsets[i] = running;
        running += sizes[i];
      }
      expect(running).toBeGreaterThan(2 ** 22);

      for (const idx of [0, 1, 4_999, 50_000, 94_999, 95_000, 99_999]) {
        commands.push(`offset ${idx}`);
        mirrorProbes.push(mirror.getOffset(idx));
      }
      commands.push('total');
      mirrorProbes.push(mirror.getTotalSize());
      const scroll = expectedOffsets[95_000];
      commands.push(`range ${scroll} 800 250`);
      const range = mirror.getEngagedRange(scroll, 800, 250);
      mirrorProbes.push(range.start, range.end, range.version);
      expect(range.start).toBeLessThanOrEqual(95_000);
      expect(range.end).toBeGreaterThanOrEqual(95_000);

      const dump = replay(binary, commands, 'large');
      expect(dump.itemCount).toBe(count);
      expect(dump.probes).toEqual(mirrorProbes);
      expect(dump.totalSize).toBe(running);
      expect(mirror.getTotalSize()).toBe(running);
      let coreMismatches = 0;
      let mirrorMismatches = 0;
      for (let i = 0; i < count; i++) {
        if (dump.offsets[i] !== expectedOffsets[i]) coreMismatches++;
        if (mirror.getOffset(i) !== expectedOffsets[i]) mirrorMismatches++;
      }
      expect(coreMismatches).toBe(0);
      expect(mirrorMismatches).toBe(0);
    },
    120_000,
  );
});
