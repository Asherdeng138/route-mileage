import { useState } from 'react';
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Card, DateField, Field, Input, Notice, SectionTitle } from '@/components/ui';
import { space, useTheme } from '@/constants/theme';
import { addRateVersion, deleteRateVersion, listRateVersions } from '@/db/rates';
import { rateNote } from '@/lib/claim';
import { todayISO } from '@/lib/dates';
import { COMPANY_TEMPLATE_RATE, HMRC_AMAP_CARS, rateForDate } from '@/lib/rates';
import { useFocusData } from '@/lib/useAsync';
import { parseNumber } from '@/lib/units';

export default function RatesScreen() {
  const t = useTheme();
  const { data, reload } = useFocusData(listRateVersions);
  const [from, setFrom] = useState(todayISO());
  const [first, setFirst] = useState('');
  const [after, setAfter] = useState('');
  const [threshold, setThreshold] = useState('10000');
  const [label, setLabel] = useState('');

  if (!data) return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  const current = rateForDate(data, todayISO());

  const onAdd = async () => {
    const a = parseNumber(first);
    const b = parseNumber(after);
    const c = parseNumber(threshold);
    if (a == null || b == null || c == null || a < 0 || b < 0 || c < 0) return Alert.alert('请输入有效数字（便士 / 英里）');
    Alert.alert(
      '新增费率版本？',
      `从 ${from} 起：${rateNote({ firstPence: a, afterPence: b, thresholdMiles: c })}\n\n生效日之前的行程仍按旧费率；已确认报销的报表不受影响。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '保存',
          onPress: async () => {
            await addRateVersion({ effectiveFrom: from, firstPence: a, afterPence: b, thresholdMiles: c, label: label.trim() || '公司费率', source: '手动设置' });
            setFirst('');
            setAfter('');
            setLabel('');
            reload();
          },
        },
      ],
    );
  };

  const onDelete = (id: number) =>
    Alert.alert('删除这个费率版本？', '未确认报销的行程会改用其他版本计算。已确认报销的报表不受影响。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => deleteRateVersion(id).then(reload).catch((e) => Alert.alert('无法删除', (e as Error).message)),
      },
    ]);

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior="height">
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Notice tone="info">
          报销金额按「公司费率」计算。默认值来自 example 样板：{rateNote(COMPANY_TEMPLATE_RATE)}。
          修改费率请新增一个带生效日期的版本，历史行程不会被悄悄改变。
        </Notice>

        <SectionTitle>公司费率版本</SectionTitle>
        {[...data].reverse().map((v) => (
          <Card key={v.id}>
            <Text style={{ color: t.text, fontWeight: '700' }}>
              {v.effectiveFrom <= '2000-01-02' ? '最早起' : `${v.effectiveFrom} 起`}
              {v.id === current.id ? '（当前使用）' : ''}
            </Text>
            <Text style={{ color: t.text }}>{rateNote(v)}</Text>
            <Text style={{ color: t.textSecondary, fontSize: 12 }}>
              {v.label}
              {v.source ? `\n依据：${v.source}` : ''}
            </Text>
            {data.length > 1 ? <Button title="删除" kind="ghost" onPress={() => onDelete(v.id)} /> : null}
          </Card>
        ))}

        <SectionTitle>新增费率版本</SectionTitle>
        <Card>
          <Field label="生效日期">
            <DateField value={from} onChange={setFrom} />
          </Field>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Field label="前段（p/英里）">
                <Input value={first} onChangeText={setFirst} keyboardType="decimal-pad" placeholder="45" />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="超出后（p/英里）">
                <Input value={after} onChangeText={setAfter} keyboardType="decimal-pad" placeholder="25" />
              </Field>
            </View>
          </View>
          <Field label="分档英里数（每个累计年度）">
            <Input value={threshold} onChangeText={setThreshold} keyboardType="number-pad" />
          </Field>
          <Field label="说明 / 依据（可选）">
            <Input value={label} onChangeText={setLabel} placeholder="例如：2027 年公司报销政策" />
          </Field>
          <Button title="保存新版本" onPress={onAdd} />
        </Card>

        <SectionTitle>HMRC 参考标准（仅供参考，不用于计算）</SectionTitle>
        <Card>
          {HMRC_AMAP_CARS.periods.map((p) => (
            <Text key={p.from} style={{ color: t.text }}>
              {p.taxYears}：前 {p.thresholdMiles.toLocaleString('en-GB')} 英里 {p.firstPence}p，之后 {p.afterPence}p（汽车 / 厢式货车）
            </Text>
          ))}
          <Text style={{ color: t.textSecondary, fontSize: 12, lineHeight: 17 }}>
            来源：gov.uk「Travel – mileage and fuel rates and allowances」（2026-05-21 更新），{HMRC_AMAP_CARS.checkedOn} 核对。
            公司支付低于 HMRC 标准时，差额的税务处理请咨询公司财务或 HMRC，App 不做税务判断。
          </Text>
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.md, paddingBottom: 64 },
  row: { flexDirection: 'row', gap: space.md },
});
