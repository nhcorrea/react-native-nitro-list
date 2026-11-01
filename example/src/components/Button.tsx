import React from 'react';
import {Pressable, StyleSheet, Text} from 'react-native';

type Props = {label: string; onPress: () => void; active?: boolean};

export function Button({label, onPress, active = false}: Props) {
  return (
    <Pressable onPress={onPress} style={[styles.button, active && styles.active]}>
      <Text style={[styles.label, active && styles.activeLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: '#eef0f3'},
  active: {backgroundColor: '#1d3557'},
  label: {fontSize: 14, fontWeight: '600', color: '#1d3557'},
  activeLabel: {color: '#ffffff'},
});
