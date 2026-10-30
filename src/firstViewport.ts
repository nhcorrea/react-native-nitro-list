import type {CellRecord} from './cells';
import {SNAPSHOT_HEADER, validSnapshot} from './layoutSnapshot';
import {isCurrentMeasurement, type MeasurementRevision} from './measurementIdentity';

/** Release the sampling cap only after its current measurements are consumed. */
export function hasCoherentInitialSample(
  cells: Iterable<CellRecord>,
  items: ReadonlyArray<unknown>,
  revision: MeasurementRevision,
  dataRevision: number,
  layoutVersion: number,
  slab: Float64Array,
  sampleLimit: number,
  epsilon: number,
): boolean {
  const written = Math.max(0, slab[3] - slab[2] + 1);
  if (!validSnapshot(slab, written) || written === 0 || slab[6] !== dataRevision || slab[0] !== layoutVersion) return false;
  let sampled = false;
  for (const cell of cells) {
    const identity = cell.identity;
    if (identity == null || identity.index >= sampleLimit || !cell.measures) continue;
    if (!isCurrentMeasurement(identity, items, revision) || !cell.laidOut || !(cell.reported > 0)) return false;
    if (identity.index < slab[2] || identity.index > slab[3]) return false;
    const size = slab[SNAPSHOT_HEADER + 2 * (identity.index - slab[2]) + 1];
    if (!Number.isFinite(size) || Math.abs(size - cell.reported) > epsilon) return false;
    sampled = true;
  }
  return sampled;
}
