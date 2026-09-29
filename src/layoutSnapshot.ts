/** Engine ABI. LayoutCore's private four-double slab is wrapped by this header. */
export const SNAPSHOT_SCHEMA = 1;
export const SNAPSHOT_HEADER = 12;
export const SNAPSHOT_STATUS = {
  unchanged: 0,
  changed: 1,
  empty: 2,
  capacity: -1,
  obsolete: -2,
} as const;
export function validSnapshot(slab: Float64Array, written: number): boolean {
  return (
    written >= 0 &&
    slab.length >= SNAPSHOT_HEADER &&
    slab[4] === SNAPSHOT_SCHEMA &&
    slab[5] === SNAPSHOT_HEADER &&
    slab[10] >= 0 &&
    written === Math.max(0, slab[3] - slab[2] + 1) &&
    SNAPSHOT_HEADER + written * 2 <= slab.length
  );
}

export const LAYOUT_READ_SCHEMA = 1;
export const LAYOUT_READ_HEADER = 8;
export function validLayoutRead(buffer: Float64Array, written: number, start: number): boolean {
  return (
    written >= 0 &&
    buffer.length >= LAYOUT_READ_HEADER &&
    buffer[0] === LAYOUT_READ_SCHEMA &&
    buffer[1] === LAYOUT_READ_HEADER &&
    buffer[6] === start &&
    buffer[7] === written &&
    LAYOUT_READ_HEADER + written * 2 <= buffer.length
  );
}
