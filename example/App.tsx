import React, {useState} from 'react';
import {StatusBar, StyleSheet, View} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';

import {Button} from './src/components/Button';
import {ChatScreen} from './src/screens/ChatScreen';
import {FeedScreen} from './src/screens/FeedScreen';
import {GridScreen} from './src/screens/GridScreen';
import {SectionsScreen} from './src/screens/SectionsScreen';

const SCREENS = {
  feed: {label: 'Feed', Component: FeedScreen},
  grid: {label: 'Grid', Component: GridScreen},
  sections: {label: 'Sections', Component: SectionsScreen},
  chat: {label: 'Chat', Component: ChatScreen},
} as const;

type ScreenKey = keyof typeof SCREENS;

export default function App() {
  const [screen, setScreen] = useState<ScreenKey>('feed');
  const {Component} = SCREENS[screen];

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <View style={styles.tabs}>
          {(Object.keys(SCREENS) as ScreenKey[]).map(key => (
            <Button key={key} label={SCREENS[key].label} active={key === screen} onPress={() => setScreen(key)} />
          ))}
        </View>
        <Component />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#ffffff'},
  tabs: {flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 8},
});
