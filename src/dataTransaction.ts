/** Internal ABI, shared with HybridNitroListEngine::updateData. */
export const DATA_CONFIG_SCHEMA = 1;
export const DATA_CONFIG_LENGTH = 17;
export const EMPTY_DATA_BUFFER = new ArrayBuffer(0);

export function dataConfig(values: {
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
}): ArrayBuffer {
  return new Float64Array([
    DATA_CONFIG_SCHEMA,
    values.count,
    values.estimate,
    values.draw,
    Number(values.horizontal),
    values.columns,
    values.epsilon,
    Number(values.reset),
    values.revision,
    values.invalidateFrom,
    values.typeStart,
    values.typeCount,
    values.fixedCount,
    values.remapCount,
    values.spanCount,
    values.typeOffset,
    values.spanStart,
  ]).buffer;
}
