export interface MeasurementRevision {
  readonly id: number;
  geometry: number;
}

export interface MeasurementIdentity {
  readonly item: unknown;
  readonly index: number;
  readonly revision: MeasurementRevision;
  readonly geometry: number;
  readonly itemsAreEqual?: (prev: unknown, next: unknown, index: number) => boolean;
  active: boolean;
}

let nextRevision = 0;

export function createMeasurementRevision(): MeasurementRevision {
  return {id: ++nextRevision, geometry: 0};
}

export function isCurrentMeasurement(
  identity: MeasurementIdentity,
  items: ReadonlyArray<unknown>,
  revision: MeasurementRevision,
): boolean {
  return (
    identity.active &&
    identity.revision === revision &&
    identity.geometry === revision.geometry &&
    identity.index >= 0 &&
    identity.index < items.length &&
    (Object.is(items[identity.index], identity.item) ||
      identity.itemsAreEqual?.(identity.item, items[identity.index], identity.index) === true)
  );
}
