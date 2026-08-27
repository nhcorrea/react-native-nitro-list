export const NitroListDevFlags = {
  stiEventDrivenWait: true,
  scrollEchoGuard: true,
  staleRangeReconcile: true,
  rangeEdgeHysteresis: true,
  stiLandingAdmission: true,
};

export type NitroListDevFlagKey = keyof typeof NitroListDevFlags;

export const NITRO_LIST_DEV_FLAG_KEYS = Object.keys(NitroListDevFlags) as NitroListDevFlagKey[];
