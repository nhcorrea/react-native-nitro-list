import {NitroModules} from 'react-native-nitro-modules';

import type {NitroListEngine} from './NitroListEngine.nitro';

export type {NitroListEngine};

export function createNitroListEngine(): NitroListEngine {
  return NitroModules.createHybridObject<NitroListEngine>('NitroListEngine');
}
