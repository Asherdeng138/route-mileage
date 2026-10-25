import { router, useFocusEffect, useNavigation } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet } from 'react-native';

import { emptyPlace, PlaceInput, type PlaceValue } from '@/components/PlaceInput';
import { StopsInput } from '@/components/StopsInput';
import {
  Button,
  Card,
  Chips,
  DateField,
  Field,
  Input,
  Notice,
  Segmented,
  SwitchRow,
} from '@/components/ui';
import { space, useTheme } from '@/constants/theme';
import { listPlaces } from '@/db/places';
import { getAppSettings } from '@/db/settings';
import { createManualTrip, recentStops, recentValues } from '@/db/trips';
import { todayISO } from '@/lib/dates';
import { takePick } from '@/lib/pickerBridge';
import { haversineM } from '@/lib/geo';
import type { Category, DistanceUnit, Place } from '@/lib/types';
import { metersToUnit, parseNumber, unitLabel, unitToMeters } from '@/lib/units';

export default function NewTripScreen() {
  const t = useTheme();
  const navigation = useNavigation();
  const [places, setPlaces] = useState<Place[]>([]);
  const [unit, setUnit] = useState<DistanceUnit>('mi');
  const [purposes, setPurposes] = useState<string[]>([]);
  const [clients, setClients] = useState<string[]>([]);
  const [stops, setStops] = useState<string[]>([]);
  const [via, setVia] = useState<string[]>([]);

  const [date, setDate] = useState(todayISO());
  const [start, setStart] = useState<PlaceValue>(emptyPlace());
  const [end, setEnd] = useState<PlaceValue>(emptyPlace());
  const [oneWayText, setOneWayText] = useState('');
  const [roundTrip, setRoundTrip] = useState(false);
  const [purpose, setPurpose] = useState('');
  const [client, setClient] = useState('');
  const [notes, setNotes] = useState('');
  const [category, setCategory] = useState<Category>('business');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [pl, s, ps, cs, st] = await Promise.all([
        listPlaces(),
        getAppSettings(),
        recentValues('purpose'),
        recentValues('client'),
        recentStops(),
      ]);
      setStops(st);
      setPlaces(pl);
      setUnit(s.unit);
      setPurposes(ps);
      setClients(cs);
      const home = pl.find((p) => p.type === 'home');
      if (home) setStart({ name: home.name, address: home.address ?? '', lat: home.lat, lng: home.lng });
    })();
  }, []);

  useFocusEffect(
    useCallback(() => {
      const s = takePick('new-trip-start');
      if (s) setStart({ name: s.name, address: s.address ?? '', lat: s.lat, lng: s.lng });
      const e = takePick('new-trip-end');
      if (e) setEnd({ name: e.name, address: e.address ?? '', lat: e.lat, lng: e.lng });
    }, []),
  );

  const openPicker = (which: 'start' | 'end', label: string, near: PlaceValue) =>
    router.push({
      pathname: '/pick-place',
      params: { key: `new-trip-${which}`, label, lat: near.lat != null ? String(near.lat) : '', lng: near.lng != null ? String(near.lng) : '' },
    });

  const oneWay = parseNumber(oneWayText);
  const total = oneWay != null ? (roundTrip ? oneWay * 2 : oneWay) : null;

  // 两个常用地点都有坐标时给出直线距离参考（实际驾车距离通常更长）
  const straight =
    start.lat != null && start.lng != null && end.lat != null && end.lng != null
      ? metersToUnit(haversineM({ lat: start.lat, lng: start.lng }, { lat: end.lat, lng: end.lng }), unit)
      : null;

  const onSave = async () => {
    if (!start.name.trim() && !start.address.trim()) return Alert.alert('请填写起点');
    if (!end.name.trim() && !end.address.trim()) return Alert.alert('请填写终点');
    if (oneWay == null || oneWay <= 0) return Alert.alert('请填写里程', `单程${unitLabel(unit)}数`);
    setSaving(true);
    try {
      await createManualTrip({
        date,
        startName: start.name.trim() || null,
        startAddress: start.address.trim() || null,
        startLat: start.lat,
        startLng: start.lng,
        endName: end.name.trim() || null,
        endAddress: end.address.trim() || null,
        endLat: end.lat,
        endLng: end.lng,
        via: via.map((v) => v.trim()).filter(Boolean),
        // 只保存单程；往返由 createManualTrip 统一 ×2
        oneWayM: unitToMeters(oneWay, unit),
        roundTrip,
        purpose: purpose.trim() || null,
        client: client.trim() || null,
        notes: notes.trim() || null,
        category,
      });
      navigation.goBack();
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior="height">
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card>
          <Field label="日期">
            <DateField value={date} onChange={setDate} />
          </Field>
        </Card>

        <Card>
          <PlaceInput label="起点" value={start} onChange={setStart} places={places} onPickOnMap={() => openPicker('start', '起点', start)} />
          <StopsInput value={via} onChange={setVia} suggestions={[...places.map((p) => p.name), ...stops]} />
          <PlaceInput label="终点" value={end} onChange={setEnd} places={places} onPickOnMap={() => openPicker('end', '终点', end.lat != null ? end : start)} />
        </Card>

        <Card>
          <Field
            label={`单程里程（${unitLabel(unit)}）`}
            hint={
              (straight != null
                ? `两地直线距离约 ${straight.toFixed(1)} ${unitLabel(unit)}，实际驾车距离通常更长。`
                : '') + '请填写单程；打开「往返」会自动 ×2，不要自己先乘。'
            }>
            <Input value={oneWayText} onChangeText={setOneWayText} keyboardType="decimal-pad" placeholder="例如 12.5" />
          </Field>
          <SwitchRow
            label="往返"
            hint={total != null ? `报销里程合计 ${total.toFixed(1)} ${unitLabel(unit)}（手动填写，非地图计算）` : '打开后报销里程 = 单程 × 2'}
            value={roundTrip}
            onChange={setRoundTrip}
          />
          <Notice tone="info">手动补录的里程需要自己填写（可在 Google 地图里查好后填入，并在行程详情里附上路线截图）。</Notice>
        </Card>

        <Card>
          <Field label="类型">
            <Segmented<Category>
              value={category}
              onChange={setCategory}
              options={[
                { value: 'business', label: '公务（报销）' },
                { value: 'personal', label: '私人' },
              ]}
            />
          </Field>
          <Field label="出差事由（可选）">
            <Input value={purpose} onChangeText={setPurpose} placeholder="例如：客户拜访、门店巡检、展会" />
            <Chips items={purposes.filter((p) => p !== purpose)} onPick={setPurpose} />
          </Field>
          <Field label="客户 / 项目">
            <Input value={client} onChangeText={setClient} placeholder="可选" />
            <Chips items={clients.filter((c) => c !== client)} onPick={setClient} />
          </Field>
          <Field label="备注">
            <Input value={notes} onChangeText={setNotes} multiline placeholder="可选" />
          </Field>
        </Card>

        <Button title="保存行程" onPress={onSave} loading={saving} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.md, paddingBottom: 64 },
});
