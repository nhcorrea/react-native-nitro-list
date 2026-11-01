import React, {useMemo, useRef} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {NitroList, type NitroListHandle, type NitroListRenderItem} from '@nhcorrea/react-native-nitro-list';

import {Button} from '../components/Button';
import {makeFeed, type FeedItem} from '../data';

const BANNER_HEIGHT = 56;

const renderItem: NitroListRenderItem<FeedItem> = ({item}) =>
  item.kind === 'banner' ? (
    <View style={styles.banner}>
      <Text style={styles.bannerText}>{item.title}</Text>
    </View>
  ) : (
    <View style={styles.post}>
      <Text style={styles.title}>{item.title}</Text>
      <Text style={styles.body}>{item.body}</Text>
    </View>
  );

const keyExtractor = (item: FeedItem) => item.id;
const getItemType = (item: FeedItem) => item.kind;
const getFixedItemSize = (_item: FeedItem, _index: number, type: string | number | undefined) =>
  type === 'banner' ? BANNER_HEIGHT : undefined;

export function FeedScreen() {
  const data = useMemo(() => makeFeed(10_000), []);
  const list = useRef<NitroListHandle>(null);

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Button label="Top" onPress={() => list.current?.scrollToIndex({index: 0, animated: true})} />
        <Button label="Item 5,000" onPress={() => list.current?.scrollToIndex({index: 4999, animated: true})} />
        <Button label="End" onPress={() => list.current?.scrollToEnd(true)} />
      </View>
      <NitroList
        ref={list}
        data={data}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        getItemType={getItemType}
        getFixedItemSize={getFixedItemSize}
        estimatedItemSize={96}
        recycleItems
        style={styles.list}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1},
  toolbar: {flexDirection: 'row', gap: 8, padding: 12},
  list: {flex: 1},
  banner: {height: BANNER_HEIGHT, justifyContent: 'center', paddingHorizontal: 16, backgroundColor: '#1d3557'},
  bannerText: {color: '#ffffff', fontSize: 16, fontWeight: '700'},
  post: {paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#d0d4da'},
  title: {fontSize: 15, fontWeight: '600', color: '#111827'},
  body: {marginTop: 4, fontSize: 14, lineHeight: 20, color: '#4b5563'},
});
