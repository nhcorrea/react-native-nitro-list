import React, {useMemo} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {NitroList, type NitroListRenderItem} from '@nhcorrea/react-native-nitro-list';

import {makePhotos, type Photo} from '../data';

const renderItem: NitroListRenderItem<Photo> = ({item}) => (
  <View style={[styles.tile, {backgroundColor: item.color}]}>
    <Text style={styles.label}>{item.label}</Text>
  </View>
);

const keyExtractor = (item: Photo) => item.id;

export function GridScreen() {
  const data = useMemo(() => makePhotos(3_000), []);

  return (
    <NitroList
      data={data}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      estimatedItemSize={120}
      numColumns={3}
      columnWrapperStyle={{rowGap: 8, columnGap: 8}}
      contentContainerStyle={styles.content}
      recycleItems
      style={styles.list}
    />
  );
}

const styles = StyleSheet.create({
  list: {flex: 1},
  content: {padding: 8},
  tile: {height: 120, borderRadius: 8, alignItems: 'center', justifyContent: 'center'},
  label: {color: '#ffffff', fontSize: 18, fontWeight: '700'},
});
