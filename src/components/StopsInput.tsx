import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/constants/theme';

import { Chips, Field, Input } from './ui';

/** 途经地点（按顺序）。报表描述：From 起点 to 途经1 to 途经2 to 终点 */
export function StopsInput({
  value,
  onChange,
  suggestions,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  suggestions: string[];
}) {
  const t = useTheme();
  const set = (i: number, v: string) => onChange(value.map((x, j) => (j === i ? v : x)));
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));
  return (
    <Field label="途经地点（可选，按顺序）" hint="例如一天跑了多个门店：起点 home → 途经 B&Q Farnborough → 终点 home">
      <View style={styles.col}>
        {value.map((v, i) => (
          <View key={i} style={styles.row}>
            <Input style={{ flex: 1 }} value={v} placeholder={`途经 ${i + 1}`} onChangeText={(x) => set(i, x)} />
            <Pressable accessibilityLabel={`删除途经 ${i + 1}`} hitSlop={8} onPress={() => remove(i)} style={styles.remove}>
              <Text style={{ color: t.record, fontSize: 18, fontWeight: '700' }}>×</Text>
            </Pressable>
          </View>
        ))}
        <Pressable onPress={() => onChange([...value, ''])} hitSlop={6}>
          <Text style={{ color: t.primary, fontWeight: '700' }}>＋ 添加途经地点</Text>
        </Pressable>
        <Chips items={suggestions.filter((s) => !value.includes(s)).slice(0, 10)} onPick={(s) => onChange([...value.filter(Boolean), s])} />
      </View>
    </Field>
  );
}

const styles = StyleSheet.create({
  col: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  remove: { paddingHorizontal: 8, paddingVertical: 4 },
});
