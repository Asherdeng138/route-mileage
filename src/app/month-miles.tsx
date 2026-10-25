import { useState } from 'react';
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Card, Field, Input, MonthSwitcher, Notice, SectionTitle } from '@/components/ui';
import { space, useTheme } from '@/constants/theme';
import { listMonthMiles, setMonthMiles } from '@/db/claims';
import { addMonths, monthKeyOf, monthLabel, todayISO } from '@/lib/dates';
import { formatTenths, milesToTenths } from '@/lib/money';
import { useFocusData } from '@/lib/useAsync';
import { parseNumber } from '@/lib/units';

/** 使用 App 之前月份的公务里程：参与「本年累计」和 10,000 英里分档，并列在 Excel 的往月行里 */
export default function MonthMilesScreen() {
  const t = useTheme();
  const { data, reload } = useFocusData(listMonthMiles);
  const [month, setMonth] = useState(addMonths(monthKeyOf(todayISO()), -1));
  const [miles, setMiles] = useState('');

  if (!data) return <View style={{ flex: 1, backgroundColor: t.bg }} />;

  const onSave = async () => {
    const v = parseNumber(miles);
    if (v == null || v < 0) return Alert.alert('请输入英里数');
    await setMonthMiles(month, milesToTenths(v));
    setMiles('');
    reload();
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior="height">
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Notice tone="info">
          只录入 App 里没有记录的月份（例如开始使用 App 之前已经报销的月份）。
          某个月录入后，累计时以这里的数字为准，不再用该月 App 内的行程。
        </Notice>
        <Card>
          <MonthSwitcher label={monthLabel(month)} onPrev={() => setMonth(addMonths(month, -1))} onNext={() => setMonth(addMonths(month, 1))} />
          <Field label="该月公务里程（英里）">
            <Input value={miles} onChangeText={setMiles} keyboardType="decimal-pad" placeholder="例如 520.4" />
          </Field>
          <Button title="保存" onPress={onSave} />
        </Card>

        <SectionTitle>已录入</SectionTitle>
        {data.length === 0 ? <Text style={{ color: t.textSecondary }}>还没有录入</Text> : null}
        {data.map((m) => (
          <Card key={m.month} style={styles.row}>
            <Text style={{ color: t.text, flex: 1, fontWeight: '600' }}>{monthLabel(m.month)}</Text>
            <Text style={{ color: t.text, fontWeight: '800' }}>{formatTenths(m.tenths)} mi</Text>
            <Button
              title="删除"
              kind="ghost"
              onPress={() =>
                Alert.alert(`删除 ${monthLabel(m.month)} 的录入？`, undefined, [
                  { text: '取消', style: 'cancel' },
                  { text: '删除', style: 'destructive', onPress: () => setMonthMiles(m.month, null).then(reload) },
                ])
              }
            />
          </Card>
        ))}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.md, paddingBottom: 64 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
