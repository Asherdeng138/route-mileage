import * as Location from 'expo-location';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet, Text } from 'react-native';

import { Button, Card, Field, Input, Notice, Segmented } from '@/components/ui';
import { space, useTheme } from '@/constants/theme';
import { deletePlace, getPlace, PLACE_TYPE_LABEL, savePlace } from '@/db/places';
import type { PlaceType } from '@/lib/types';
import { parseNumber } from '@/lib/units';
import { geocodeAddress, resolvePlace } from '@/services/geocoding';

const TYPES: PlaceType[] = ['home', 'office', 'client', 'other'];

export default function PlaceEditScreen() {
  const t = useTheme();
  const navigation = useNavigation();
  const params = useLocalSearchParams<{ id: string; name?: string; address?: string; lat?: string; lng?: string }>();
  const isNew = params.id === 'new';

  const [name, setName] = useState(params.name ?? '');
  const [address, setAddress] = useState(params.address ?? '');
  const [lat, setLat] = useState<number | null>(params.lat ? Number(params.lat) : null);
  const [lng, setLng] = useState<number | null>(params.lng ? Number(params.lng) : null);
  const [radiusText, setRadiusText] = useState('150');
  const [type, setType] = useState<PlaceType>('client');
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    if (isNew) return;
    getPlace(Number(params.id)).then((p) => {
      if (!p) return;
      setName(p.name);
      setAddress(p.address ?? '');
      setLat(p.lat);
      setLng(p.lng);
      setRadiusText(String(p.radiusM));
      setType(p.type);
    });
  }, [isNew, params.id]);

  const useCurrent = async () => {
    setLocating(true);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        Alert.alert('需要定位权限');
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const point = { lat: loc.coords.latitude, lng: loc.coords.longitude };
      setLat(point.lat);
      setLng(point.lng);
      if (!address) {
        const r = await resolvePlace(point, []);
        if (r?.address) setAddress(r.address);
      }
    } catch (e) {
      Alert.alert('定位失败', (e as Error).message);
    } finally {
      setLocating(false);
    }
  };

  const locateAddress = async () => {
    if (!address.trim()) return;
    setLocating(true);
    const p = await geocodeAddress(address.trim());
    setLocating(false);
    if (p) {
      setLat(p.lat);
      setLng(p.lng);
    } else {
      Alert.alert('找不到这个地址', '可以到现场后点「使用当前位置」。');
    }
  };

  const onSave = async () => {
    if (!name.trim()) return Alert.alert('请填写名称');
    const radius = parseNumber(radiusText);
    await savePlace({
      id: isNew ? undefined : Number(params.id),
      name: name.trim(),
      address: address.trim() || null,
      lat,
      lng,
      radiusM: radius && radius > 20 ? radius : 150,
      type,
    });
    navigation.goBack();
  };

  const onDelete = () =>
    Alert.alert('删除这个地点？', '', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          await deletePlace(Number(params.id));
          navigation.goBack();
        },
      },
    ]);

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior="height">
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card>
          <Field label="名称">
            <Input value={name} onChangeText={setName} placeholder="例如：家、公司、M&S Paddington" />
          </Field>
          <Field label="类型">
            <Segmented<PlaceType>
              value={type}
              onChange={setType}
              options={TYPES.map((v) => ({ value: v, label: PLACE_TYPE_LABEL[v].split(' ')[0] }))}
            />
          </Field>
          {type === 'office' ? (
            <Notice tone="info">固定办公室：家 ↔ 这里的行程会提示属于通勤（HMRC 规定通勤不能报销）。</Notice>
          ) : null}
          <Field label="地址">
            <Input value={address} onChangeText={setAddress} placeholder="地址或邮编" />
          </Field>
          <Text style={{ color: lat != null ? t.success : t.textSecondary }}>
            {lat != null && lng != null ? `已定位：${lat.toFixed(5)}, ${lng.toFixed(5)}` : '还没有定位，无法自动识别'}
          </Text>
          <Button title="使用当前位置" kind="secondary" onPress={useCurrent} loading={locating} />
          <Button title="按地址定位" kind="ghost" onPress={locateAddress} disabled={!address.trim()} />
          <Field label="识别半径（米）" hint="行程起点 / 终点在这个范围内就显示为这个地点">
            <Input value={radiusText} onChangeText={setRadiusText} keyboardType="number-pad" />
          </Field>
        </Card>
        <Button title="保存" onPress={onSave} />
        {!isNew ? <Button title="删除地点" kind="ghost" onPress={onDelete} /> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.md, paddingBottom: 64 },
});
