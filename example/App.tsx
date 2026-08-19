import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  NitroList,
  type NitroListHandle,
  type NitroListRenderItem,
} from '@nhcorrea/react-native-nitro-list';

type DemoItem = {
  id: string;
  title: string;
  subtitle: string;
};

const COUNT = 1000;

function makeItems(): DemoItem[] {
  return Array.from({ length: COUNT }, (_, i) => ({
    id: `item-${i}`,
    title: `Row ${i}`,
    subtitle: `NitroList demo item #${i}`,
  }));
}

function App(): React.JSX.Element {
  const items = useMemo(makeItems, []);
  const listRef = useRef<NitroListHandle>(null);
  const [pressedId, setPressedId] = useState<string | null>(null);

  const renderItem = useCallback<NitroListRenderItem<DemoItem>>(
    ({ item }) => (
      <Pressable style={styles.row} onPress={() => setPressedId(item.id)}>
        <Text style={styles.title}>{item.title}</Text>
        <Text style={styles.subtitle}>{item.subtitle}</Text>
      </Pressable>
    ),
    []
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>NitroList example</Text>
        <View style={styles.headerActions}>
          <Pressable
            style={styles.button}
            onPress={() =>
              listRef.current?.scrollToIndex({ index: 0, animated: true })
            }
          >
            <Text style={styles.buttonLabel}>Top</Text>
          </Pressable>
          <Pressable
            style={styles.button}
            onPress={() =>
              listRef.current?.scrollToIndex({
                index: COUNT - 1,
                animated: true,
              })
            }
          >
            <Text style={styles.buttonLabel}>Bottom</Text>
          </Pressable>
        </View>
        {pressedId != null ? (
          <Text style={styles.pressed}>pressed: {pressedId}</Text>
        ) : null}
      </View>
      <NitroList
        ref={listRef}
        data={items}
        renderItem={renderItem}
        estimatedItemSize={64}
        keyExtractor={item => item.id}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    paddingTop: 64,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ccc',
    gap: 8,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  button: {
    backgroundColor: '#1d4ed8',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
  },
  buttonLabel: {
    color: '#fff',
    fontWeight: '600',
  },
  pressed: {
    color: '#555',
    fontSize: 12,
  },
  row: {
    minHeight: 64,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e5e5',
  },
  title: {
    fontSize: 16,
    fontWeight: '500',
  },
  subtitle: {
    fontSize: 13,
    color: '#777',
  },
});

export default App;
