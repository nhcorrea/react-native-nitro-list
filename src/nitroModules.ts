import type {NitroModules as NitroModulesProxy} from 'react-native-nitro-modules';
import {NitroModules as core} from 'react-native-nitro-modules/lib/module/turbomodule/NativeNitroModules';

export const NitroModules: typeof NitroModulesProxy = core;
