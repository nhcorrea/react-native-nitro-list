export const NitroListDevFlags = {
  stiEventDrivenWait: true,
  scrollEchoGuard: true,
  staleRangeReconcile: true,
  rangeEdgeHysteresis: true,
  stiLandingAdmission: true,
  stiLayoutEffectWaiter: false,
  dataAppendFastPath: true,
  jsScrollEventThrottle1: false,
};

export type NitroListDevFlagKey = keyof typeof NitroListDevFlags;

export const NITRO_LIST_DEV_FLAG_KEYS = Object.keys(NitroListDevFlags) as NitroListDevFlagKey[];
