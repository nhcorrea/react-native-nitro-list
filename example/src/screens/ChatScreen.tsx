import React, {useCallback, useRef, useState} from 'react';
import {KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View} from 'react-native';
import {NitroList, type NitroListRenderItem} from '@nhcorrea/react-native-nitro-list';

import {Button} from '../components/Button';
import {makeMessages, type Message} from '../data';

const PAGE = 20;
const OLDEST = -200;

const renderItem: NitroListRenderItem<Message> = ({item}) => (
  <View style={[styles.bubble, item.mine ? styles.mine : styles.theirs]}>
    <Text style={item.mine ? styles.mineText : styles.theirsText}>{item.text}</Text>
  </View>
);

const keyExtractor = (item: Message) => item.id;

export function ChatScreen() {
  const [messages, setMessages] = useState(() => makeMessages(0, 30));
  const [draft, setDraft] = useState('');
  const oldest = useRef(0);
  const nextId = useRef(30);

  const loadOlder = useCallback(() => {
    if (oldest.current <= OLDEST) return;
    const from = oldest.current - PAGE;
    oldest.current = from;
    setMessages(current => [...makeMessages(from, PAGE), ...current]);
  }, []);

  const send = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0) return;
    const message = {id: `message-${nextId.current++}`, text, mine: true};
    setMessages(current => [...current, message]);
    setDraft('');
  }, [draft]);

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <NitroList
        data={messages}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        estimatedItemSize={56}
        initialScrollAtEnd
        alignItemsAtEnd
        maintainScrollAtEnd
        maintainVisibleContentPosition={{data: true}}
        onStartReached={loadOlder}
        contentContainerStyle={styles.content}
        style={styles.list}
      />
      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={send}
          placeholder="Message"
          style={styles.input}
          returnKeyType="send"
        />
        <Button label="Send" onPress={send} active />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1},
  list: {flex: 1},
  content: {paddingVertical: 8},
  bubble: {maxWidth: '78%', marginHorizontal: 12, marginVertical: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16},
  mine: {alignSelf: 'flex-end', backgroundColor: '#1d3557'},
  theirs: {alignSelf: 'flex-start', backgroundColor: '#eef0f3'},
  mineText: {color: '#ffffff', fontSize: 15},
  theirsText: {color: '#111827', fontSize: 15},
  composer: {flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#d0d4da'},
  input: {flex: 1, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, backgroundColor: '#f3f4f6', fontSize: 15},
});
