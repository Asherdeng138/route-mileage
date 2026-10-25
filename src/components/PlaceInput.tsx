import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/constants/theme';

import type { Place } from '@/lib/types';

import { Chips, Field, Input } from './ui';

export interface PlaceValue {
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
}

export const emptyPlace = (): PlaceValue => ({ name: '', address: '', lat: null, lng: null });

/** 起点 / 终点输入：名称 + 地址，可一键选常用地点 */
export function PlaceInput({
  label,
  value,
  onChange,
  places,
  onPickOnMap,
}: {
  label: string;
  value: PlaceValue;
  onChange: (v: PlaceValue) => void;
  places: Place[];
  /** 打开「在地图上选择」（拖动图钉 + 附近地点） */
  onPickOnMap?: () => void;
}) {
  const t = useTheme();
  return (
    <Field label={label}>
      <View style={styles.col}>
        <Input
          value={value.name}
          placeholder="名称，例如：M&S Paddington 总部"
          onChangeText={(name) => onChange({ ...value, name })}
        />
        <Input
          value={value.address}
          placeholder="地址或邮编（可选）"
          onChangeText={(address) => onChange({ ...value, address, lat: null, lng: null })}
        />
        {onPickOnMap ? (
          <Pressable
            onPress={onPickOnMap}
            accessibilityRole="button"
            style={({ pressed }) => [styles.pick, { borderColor: t.primary, opacity: pressed ? 0.7 : 1 }]}>
            <Text style={{ color: t.primary, fontWeight: '700' }}>📍 在地图上选 / 附近地点</Text>
          </Pressable>
        ) : null}
        <Chips
          items={places.map((p) => p.name)}
          onPick={(name) => {
            const p = places.find((x) => x.name === name);
            if (p) onChange({ name: p.name, address: p.address ?? '', lat: p.lat, lng: p.lng });
          }}
        />
      </View>
    </Field>
  );
}

const styles = StyleSheet.create({
  col: { gap: 8 },
  pick: { borderWidth: 1, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
});
