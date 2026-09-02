const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;

const warnedIds = new Set<string>();

export function warnDevOnce(id: string, message: string): void {
  if (!IS_DEV || warnedIds.has(id)) return;
  warnedIds.add(id);
  console.warn(`[nitro-list] ${message}`);
}

export function clearWarnDevOnceForTests(): void {
  warnedIds.clear();
}

export function maybeWarnMissingKeyExtractor(
  hasKeyExtractor: boolean,
  previousItemCount: number,
  nextItemCount: number,
): void {
  if (hasKeyExtractor || previousItemCount === 0 || nextItemCount === 0) return;
  warnDevOnce(
    'missing-key-extractor',
    'data changed without a keyExtractor: every update drops all measured item sizes back to ' +
      'estimates and scroll anchoring loses its target. Provide keyExtractor so measurements ' +
      'can be remapped across updates.',
  );
}

export const MAX_TRACKED_ITEM_TYPES = 4096;

export function maybeWarnTooManyItemTypes(distinctTypes: number): void {
  if (distinctTypes <= MAX_TRACKED_ITEM_TYPES) return;
  warnDevOnce(
    'too-many-item-types',
    `getItemType produced ${distinctTypes} distinct types; the engine only keeps per-type ` +
      `size statistics for the first ${MAX_TRACKED_ITEM_TYPES}. Items of the other types fall ` +
      'back to estimatedItemSize until measured. Types should describe layout, not identity.',
  );
}

export function checkDuplicateKeyDev(seenKeys: Set<string>, key: string): void {
  if (seenKeys.has(key)) {
    warnDevOnce(
      'duplicate-item-key',
      `duplicate item key "${key}" in the rendered window. Keys must be unique — duplicates ` +
        'make React reuse the wrong cell and corrupt size measurements.',
    );
    return;
  }
  seenKeys.add(key);
}

export function maybeWarnZeroViewport(viewportHeight: number, itemCount: number): void {
  if (viewportHeight > 0 || itemCount === 0) return;
  warnDevOnce(
    'zero-viewport',
    'the list has data but its viewport still measures 0. Give NitroList a bounded height ' +
      '(flex: 1 inside a flex parent, or an explicit height) — nothing renders until the ' +
      'viewport has a size.',
  );
}

export const ESTIMATE_DRIFT_MIN_SAMPLES = 8;
export const ESTIMATE_DRIFT_MIN_RATIO = 0.4;

export type EstimateDriftStats = {mean: number; num: number};

export function accumulateEstimateDriftSample(
  stats: Map<string, EstimateDriftStats>,
  typeLabel: string,
  sizeDp: number,
  estimatedItemSize: number,
): void {
  if (!(sizeDp > 0)) return;
  let entry = stats.get(typeLabel);
  if (entry == null) {
    entry = {mean: 0, num: 0};
    stats.set(typeLabel, entry);
  }
  entry.mean = (entry.mean * entry.num + sizeDp) / (entry.num + 1);
  entry.num++;
  maybeWarnEstimateDrift(typeLabel, entry.mean, entry.num, estimatedItemSize);
}

export function maybeWarnEstimateDrift(
  typeLabel: string,
  measuredMean: number,
  sampleCount: number,
  estimatedItemSize: number,
): void {
  if (sampleCount < ESTIMATE_DRIFT_MIN_SAMPLES || !(estimatedItemSize > 0)) return;
  const ratio = Math.abs(measuredMean - estimatedItemSize) / estimatedItemSize;
  if (ratio <= ESTIMATE_DRIFT_MIN_RATIO) return;
  const suggested = Math.round(measuredMean);
  const subject =
    typeLabel === ''
      ? `${sampleCount} measured items average`
      : `${sampleCount} measured items of type "${typeLabel}" average`;
  warnDevOnce(
    `estimated-item-size-drift:${typeLabel}`,
    `estimatedItemSize=${estimatedItemSize}, but ${subject} ≈${suggested}. Use ` +
      `estimatedItemSize={${suggested}} (or split sizes with getItemType) so unmeasured ` +
      'items start close to reality.',
  );
}

export function maybeWarnJsOnScrollUnderUiDriver(
  hasJsOnScroll: boolean,
  uiThreadScrollEnabled: boolean,
): void {
  if (!hasJsOnScroll || !uiThreadScrollEnabled) return;
  warnDevOnce(
    'js-onscroll-under-ui-driver',
    'onScroll (JS) together with experimentalUiThreadScroll: every scroll frame hops ' +
      'UI → JS just to feed this callback. Prefer onScrollWorklet (runs on the UI thread) ' +
      'or scrollOffsetSharedValue.',
  );
}
