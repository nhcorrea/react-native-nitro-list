/**
 * @format
 */

// Precisa vir antes de qualquer import da lib — ver perfFlag.ts.
import './perfFlag';

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
