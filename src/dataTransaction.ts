/** Internal ABI, shared with HybridNitroListEngine::updateData. */
export const DATA_CONFIG_SCHEMA = 1;
export const DATA_CONFIG_LENGTH = 17;
export function writeDataConfig(target: Float64Array, values: {
  count: number;
  estimate: number;
  draw: number;
  horizontal: boolean;
  columns: number;
  epsilon: number;
  reset: boolean;
  revision: number;
  invalidateFrom: number;
  typeStart: number;
  typeCount: number;
  fixedCount: number;
  remapCount: number;
  spanCount: number;
  typeOffset: number;
  spanStart: number;
}): void {
  target[0] = DATA_CONFIG_SCHEMA;
  target[1] = values.count;
  target[2] = values.estimate;
  target[3] = values.draw;
  target[4] = Number(values.horizontal);
  target[5] = values.columns;
  target[6] = values.epsilon;
  target[7] = Number(values.reset);
  target[8] = values.revision;
  target[9] = values.invalidateFrom;
  target[10] = values.typeStart;
  target[11] = values.typeCount;
  target[12] = values.fixedCount;
  target[13] = values.remapCount;
  target[14] = values.spanCount;
  target[15] = values.typeOffset;
  target[16] = values.spanStart;
}
