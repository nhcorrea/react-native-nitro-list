import {getHostComponent} from 'react-native-nitro-modules';

import NitroListViewConfig from '../nitrogen/generated/shared/json/NitroListViewConfig.json';

import type {NitroListViewMethods, NitroListViewProps} from './NitroListView.nitro';

export const NitroListView = getHostComponent<NitroListViewProps, NitroListViewMethods>(
  'NitroListView',
  () => NitroListViewConfig,
);

export type {NitroListViewMethods, NitroListViewProps};
