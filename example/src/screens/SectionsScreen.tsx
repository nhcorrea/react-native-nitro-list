import React, {useMemo} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {NitroSectionList} from '@nhcorrea/react-native-nitro-list/section-list';

import {makeContactSections, type Contact, type ContactSection} from '../data';

const renderItem = ({item}: {item: Contact}) => (
  <View style={styles.row}>
    <Text style={styles.name}>{item.name}</Text>
  </View>
);

const renderSectionHeader = ({section}: {section: ContactSection}) => (
  <View style={styles.header}>
    <Text style={styles.headerText}>{section.title}</Text>
  </View>
);

const keyExtractor = (item: Contact) => item.id;

export function SectionsScreen() {
  const sections = useMemo(() => makeContactSections(), []);

  return (
    <NitroSectionList<Contact, ContactSection>
      sections={sections}
      renderItem={renderItem}
      renderSectionHeader={renderSectionHeader}
      keyExtractor={keyExtractor}
      estimatedItemSize={48}
      recycleItems
      style={styles.list}
    />
  );
}

const styles = StyleSheet.create({
  list: {flex: 1},
  header: {paddingHorizontal: 16, paddingVertical: 6, backgroundColor: '#eef0f3'},
  headerText: {fontSize: 13, fontWeight: '700', color: '#1d3557'},
  row: {height: 48, justifyContent: 'center', paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e5e7eb'},
  name: {fontSize: 15, color: '#111827'},
});
