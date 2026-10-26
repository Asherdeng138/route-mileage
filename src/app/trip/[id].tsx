import { Image } from 'expo-image';
import { router, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from 'react-native';

import { emptyPlace, PlaceInput, type PlaceValue } from '@/components/PlaceInput';
import { GapFillCard } from '@/components/GapFillCard';
import { RouteMap } from '@/components/RouteMap';
import { StopsInput } from '@/components/StopsInput';
import { Badge, Button, Card, Chips, DateField, Field, Input, Notice, Segmented, SwitchRow } from '@/components/ui';
import { space, useTheme } from '@/constants/theme';
import { listGaps, type GapRow } from '@/db/gaps';
import { listPlaces } from '@/db/places';
import { getAppSettings } from '@/db/settings';
import { restoreTrips, trashTrips } from '@/db/archive';
import { getPoints, getTrip, manualDistanceM, recentStops, recentValues, setClaimed, updateTrip } from '@/db/trips';
import { ARCHIVE_DAYS, lifecycleOf, TRASH_DAYS } from '@/lib/archive';
import { routeDescription } from '@/lib/claim';
import { findGaps } from '@/lib/gaps';
import { isLikelyCommute } from '@/lib/commute';
import { takePick } from '@/lib/pickerBridge';
import { trackQuality } from '@/lib/trackQuality';
import { formatDateSlash, formatDuration, formatTime } from '@/lib/dates';
import type { AppSettings, Category, Place, TrackPoint, Trip } from '@/lib/types';
import { metersToUnit, parseNumber, round1, unitLabel, unitToMeters } from '@/lib/units';
import { deleteRouteImage, pickRouteImage } from '@/services/evidence';
import { generateRouteMap } from '@/services/routeMap';
import { resolveTripPlaces } from '@/tracking/recorder';

/** 轨迹密度与定位中断提示（中断的那一段只能按直线连接） */
function TrackQualityNote({ points }: { points: TrackPoint[] }) {
  const t = useTheme();
  const q = trackQuality(points);
  const worst = q.gaps[0];
  const avg = q.avgIntervalSec != null ? Math.round(q.avgIntervalSec) : null;
  if (!worst) {
    return (
      <Text style={{ color: t.textSecondary, fontSize: 13 }}>
        路线由 {q.points} 个 GPS 点连成{avg != null ? `，平均每 ${avg} 秒一个点` : ''}，按实际行驶路径绘制。
      </Text>
    );
  }
  return (
    <Notice>
      {`有 ${q.gaps.length} 段定位中断（最长 ${Math.round(worst.seconds / 60)} 分钟），这些地方按直线连接，约占全程 ${Math.round(q.straightShare * 100)}%。` +
        '常见原因：隧道 / 地下停车场、定位权限只给了「大致位置」、手机省电限制了后台定位。'}
    </Notice>
  );
}

function routeMapLabel(status: Trip['routeMapStatus'], points: number): string {
  if (points < 2) return 'GPS 点太少，Word 中不放路线图';
  switch (status) {
    case 'ok':
      return 'Word 路线图：已生成（OpenStreetMap 底图 + 实际轨迹）';
    case 'pending':
      return 'Word 路线图：等待联网生成';
    case 'failed':
      return 'Word 路线图：生成失败（没网时会用轨迹预览）';
    default:
      return 'Word 路线图：未生成';
  }
}

interface Loaded {
  trip: Trip;
  points: TrackPoint[];
  gaps: GapRow[];
  places: Place[];
  settings: AppSettings;
  purposes: string[];
  clients: string[];
  stops: string[];
}

const toPlaceValue = (name: string | null, address: string | null, lat: number | null, lng: number | null): PlaceValue => ({
  name: name ?? '',
  address: address ?? '',
  lat,
  lng,
});

export default function TripDetailScreen() {
  const t = useTheme();
  const navigation = useNavigation();
  const { id, fresh } = useLocalSearchParams<{ id: string; fresh?: string }>();
  const tripId = Number(id);

  const [data, setData] = useState<Loaded | null>(null);
  const [date, setDate] = useState('');
  const [start, setStart] = useState<PlaceValue>(emptyPlace());
  const [end, setEnd] = useState<PlaceValue>(emptyPlace());
  const [via, setVia] = useState<string[]>([]);
  const [customDesc, setCustomDesc] = useState(false);
  const [reportDesc, setReportDesc] = useState('');
  const [distanceText, setDistanceText] = useState('');
  const [oneWayText, setOneWayText] = useState('');
  const [roundTrip, setRoundTrip] = useState(false);
  const [purpose, setPurpose] = useState('');
  const [client, setClient] = useState('');
  const [notes, setNotes] = useState('');
  const [category, setCategory] = useState<Category>('business');
  const [commuteConfirmed, setCommuteConfirmed] = useState(false);
  const [image, setImage] = useState<{ uri: string; width: number; height: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [mapBusy, setMapBusy] = useState(false);

  // 从「在地图上选择」返回时填入选中的地点
  useFocusEffect(
    useCallback(() => {
      const s = takePick(`trip-${tripId}-start`);
      if (s) setStart({ name: s.name, address: s.address ?? '', lat: s.lat, lng: s.lng });
      const e = takePick(`trip-${tripId}-end`);
      if (e) setEnd({ name: e.name, address: e.address ?? '', lat: e.lat, lng: e.lng });
    }, [tripId]),
  );

  const fill = (trip: Trip, settings: AppSettings) => {
    setDate(trip.date);
    setStart(toPlaceValue(trip.startName, trip.startAddress, trip.startLat, trip.startLng));
    setEnd(toPlaceValue(trip.endName, trip.endAddress, trip.endLat, trip.endLng));
    setVia(trip.via);
    setCustomDesc(!!trip.reportDesc);
    setReportDesc(trip.reportDesc ?? '');
    setDistanceText(round1(metersToUnit(trip.distanceM, settings.unit)).toFixed(1));
    setOneWayText(round1(metersToUnit(trip.oneWayM ?? trip.distanceM, settings.unit)).toFixed(1));
    setRoundTrip(trip.roundTrip);
    setPurpose(trip.purpose ?? '');
    setClient(trip.client ?? '');
    setNotes(trip.notes ?? '');
    setCategory(trip.category);
    setCommuteConfirmed(trip.commuteConfirmed);
    setImage(trip.mapImageUri && trip.mapImageW && trip.mapImageH ? { uri: trip.mapImageUri, width: trip.mapImageW, height: trip.mapImageH } : null);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const [trip, points, gaps, places, settings, purposes, clients, stops] = await Promise.all([
        getTrip(tripId),
        getPoints(tripId),
        listGaps(tripId),
        listPlaces(),
        getAppSettings(),
        recentValues('purpose'),
        recentValues('client'),
        recentStops(),
      ]);
      if (!trip || !alive) return;
      setData({ trip, points, gaps, places, settings, purposes, clients, stops });
      fill(trip, settings);
    })();
    return () => {
      alive = false;
    };
  }, [tripId]);

  if (!data) return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  const { trip, points, places, settings } = data;
  const unit = settings.unit;
  // 自动里程 = GPS 实测 + 信号中断补算（撤销补算后 gapFillM 为 0）
  const gpsText = round1(metersToUnit(trip.distanceGpsM + trip.gapFillM, unit)).toFixed(1);
  const fills = trip.gapFillStatus === 'done' ? data.gaps.filter((g) => g.status === 'filled' && g.path.length > 1) : [];

  // 补算 / 撤销后重新读取；没有手动修正里程时，申报里程跟着更新
  const reloadGaps = async () => {
    const [fresh, gaps] = await Promise.all([getTrip(tripId), listGaps(tripId)]);
    if (!fresh) return;
    setData({ ...data, trip: fresh, gaps });
    if (!fresh.distanceEdited) setDistanceText(round1(metersToUnit(fresh.distanceM, unit)).toFixed(1));
  };
  const isGps = trip.source === 'gps';
  const life = lifecycleOf(trip);
  if (life.state === 'purged') {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, padding: space.xl, justifyContent: 'center' }}>
        <Text style={{ color: t.textSecondary, textAlign: 'center', lineHeight: 21 }}>
          这条行程已永久删除，只保留了日期和里程（用于本年累计）。
        </Text>
      </View>
    );
  }
  const oneWay = parseNumber(oneWayText);

  const draft = {
    ...trip,
    startName: start.name.trim() || null,
    startAddress: start.address.trim() || null,
    startLat: start.lat,
    startLng: start.lng,
    endName: end.name.trim() || null,
    endAddress: end.address.trim() || null,
    endLat: end.lat,
    endLng: end.lng,
    via: via.map((v) => v.trim()).filter(Boolean),
    reportDesc: customDesc && reportDesc.trim() ? reportDesc.trim() : null,
    roundTrip: isGps ? false : roundTrip,
  };
  const autoDesc = routeDescription({ ...draft, reportDesc: null });
  const commute = isLikelyCommute(draft, places);

  const onSave = async () => {
    let distanceM: number;
    let distanceEdited: boolean;
    let oneWayM: number | null = null;
    if (isGps) {
      const n = parseNumber(distanceText);
      if (n == null || n < 0) return Alert.alert('里程不正确', `请输入数字（${unitLabel(unit)}）`);
      const sameAsGps = distanceText === gpsText;
      distanceM = sameAsGps ? trip.distanceGpsM + trip.gapFillM : unitToMeters(n, unit);
      distanceEdited = !sameAsGps;
    } else {
      if (oneWay == null || oneWay <= 0) return Alert.alert('单程里程不正确', `请输入单程${unitLabel(unit)}数`);
      oneWayM = unitToMeters(oneWay, unit);
      distanceM = manualDistanceM(oneWayM, roundTrip);
      distanceEdited = true;
    }
    setSaving(true);
    try {
      if (trip.mapImageUri && trip.mapImageUri !== image?.uri && !trip.claimId) deleteRouteImage(trip.mapImageUri);
      await updateTrip(trip.id, {
        date,
        startName: draft.startName,
        startAddress: draft.startAddress,
        startLat: draft.startLat,
        startLng: draft.startLng,
        endName: draft.endName,
        endAddress: draft.endAddress,
        endLat: draft.endLat,
        endLng: draft.endLng,
        via: draft.via,
        reportDesc: draft.reportDesc,
        distanceM,
        distanceEdited,
        oneWayM,
        roundTrip: draft.roundTrip,
        purpose: purpose.trim() || null,
        client: client.trim() || null,
        notes: notes.trim() || null,
        category,
        commuteConfirmed,
        mapImageUri: image?.uri ?? null,
        mapImageW: image?.width ?? null,
        mapImageH: image?.height ?? null,
        // 用户手动填写了起终点，就不再显示「地址未解析」
        geocodeStatus: (draft.startName || draft.startAddress) && (draft.endName || draft.endAddress) ? 'ok' : trip.geocodeStatus,
      });
      navigation.goBack();
    } finally {
      setSaving(false);
    }
  };

  const onRetryGeocode = async () => {
    setGeocoding(true);
    try {
      const updated = await resolveTripPlaces(trip.id);
      if (!updated) return;
      setData({ ...data, trip: updated });
      if (!start.name && !start.address) setStart(toPlaceValue(updated.startName, updated.startAddress, updated.startLat, updated.startLng));
      if (!end.name && !end.address) setEnd(toPlaceValue(updated.endName, updated.endAddress, updated.endLat, updated.endLng));
      if (updated.geocodeStatus !== 'ok') Alert.alert('仍然无法解析地址', '可能没有网络。坐标已保留，可以稍后再试，或直接手动填写起点和终点名称。');
    } finally {
      setGeocoding(false);
    }
  };

  const onGenerateMap = async () => {
    setMapBusy(true);
    try {
      const status = await generateRouteMap(trip.id);
      const updated = await getTrip(trip.id);
      if (updated) setData({ ...data, trip: updated });
      if (status !== 'ok') Alert.alert('暂时无法生成路线图', '可能没有网络。导出时会再试一次；仍失败时 Word 使用轨迹预览图。');
    } finally {
      setMapBusy(false);
    }
  };

  const onDelete = () =>
    Alert.alert(
      '删除这条行程？',
      `行程会移到底部「归档 → 最近删除」，${TRASH_DAYS} 天内可以恢复，之后永久删除。` +
        (trip.claimedAt ? '已报销的里程仍计入本年累计；已导出的报销文件不受影响。' : ''),
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            await trashTrips([trip.id]);
            navigation.goBack();
          },
        },
      ],
    );

  // 已报销的行程一律在底部「归档」；撤销已报销后回到「行程」和「报表」
  const onToggleClaimed = async () => {
    if (trip.claimedAt) {
      await setClaimed([trip.id], false);
      setData({ ...data, trip: { ...trip, claimedAt: null, claimId: null, archivedAt: null } });
      return;
    }
    await setClaimed([trip.id], true);
    Alert.alert('已标记为已报销', `这条行程已移到底部的「归档」，${ARCHIVE_DAYS} 天后移到「最近删除」，再过 ${TRASH_DAYS} 天自动删除。`);
    navigation.goBack();
  };

  const onRestore = async () => {
    await restoreTrips([trip.id]);
    setData({ ...data, trip: { ...trip, deletedAt: null, archivedAt: null } });
  };

  const onPickImage = async () => {
    try {
      const img = await pickRouteImage(trip.id);
      if (img) setImage(img);
    } catch (e) {
      Alert.alert('无法添加图片', (e as Error).message);
    }
  };

  const openPicker = (which: 'start' | 'end', label: string, lat: number | null, lng: number | null) =>
    router.push({
      pathname: '/pick-place',
      params: { key: `trip-${tripId}-${which}`, label, lat: lat != null ? String(lat) : '', lng: lng != null ? String(lng) : '' },
    });

  const saveAsPlace = (p: PlaceValue) =>
    router.push({
      pathname: '/place/[id]',
      params: {
        id: 'new',
        name: p.name || p.address,
        address: p.address,
        lat: p.lat != null ? String(p.lat) : '',
        lng: p.lng != null ? String(p.lng) : '',
      },
    });

  const stopSuggestions = [...places.map((p) => p.name), ...data.stops];

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior="height">
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {life.state === 'archived' ? (
          <Card>
            <Text style={{ color: t.text, fontWeight: '600' }}>
              已报销 · 在「归档」里 · {life.daysLeft > 0 ? `${life.daysLeft} 天后移到「最近删除」` : '下次打开 App 时移到「最近删除」'}
            </Text>
            <Button title="撤销已报销" kind="secondary" onPress={onToggleClaimed} />
          </Card>
        ) : null}
        {life.state === 'trash' ? (
          <Card>
            <Text style={{ color: t.record, fontWeight: '600' }}>
              已删除 · {life.daysLeft > 0 ? `${life.daysLeft} 天后永久删除` : '下次打开 App 时永久删除'}
            </Text>
            <Button title="恢复行程" kind="secondary" onPress={onRestore} />
          </Card>
        ) : null}
        {fresh ? <Notice tone="info">行程已保存。请确认起点、终点（以及途经地点），报表会用它们生成路线描述。</Notice> : null}
        {trip.claimId ? (
          <Notice tone="info">这条行程已确认报销。修改不会改变已导出的报表（报表使用当时保存的快照）。</Notice>
        ) : null}

        {isGps ? <RouteMap points={points} height={260} online={settings.onlineMaps} provider={settings.mapProvider} fills={fills} /> : null}
        {/* 能补算的中断由下面的补算卡片说明；这里只说明点的密度和不需要补算的短中断 */}
        {isGps && points.length > 1 && findGaps(points).length === 0 ? <TrackQualityNote points={points} /> : null}
        {isGps && points.length > 1 ? <GapFillCard trip={trip} gaps={data.gaps} points={points} unit={unit} onChanged={reloadGaps} /> : null}
        {isGps && settings.onlineMaps && !image ? (
          <View style={styles.row}>
            <Text style={{ color: t.textSecondary, flex: 1, fontSize: 13 }}>
              {routeMapLabel(trip.routeMapStatus, points.length)}
            </Text>
            {trip.status === 'completed' && points.length >= 2 ? (
              <Button
                title={trip.routeMapStatus === 'ok' ? '重新生成' : '生成路线图'}
                kind="ghost"
                loading={mapBusy}
                onPress={onGenerateMap}
              />
            ) : null}
          </View>
        ) : null}

        <Card>
          <View style={styles.summary}>
            <Badge label={isGps ? 'GPS 记录' : '手动补录'} tone="business" />
            {trip.claimedAt ? <Badge label="已报销" tone="success" /> : null}
            {trip.geocodeStatus === 'pending' ? <Badge label="地址解析中" tone="warning" /> : null}
            {trip.geocodeStatus === 'failed' ? <Badge label="地址未解析" tone="warning" /> : null}
          </View>
          {trip.startTime ? (
            <Text style={{ color: t.textSecondary }}>
              {formatTime(trip.startTime)} – {formatTime(trip.endTime)}
              {trip.endTime ? ` · ${formatDuration(trip.endTime - trip.startTime)}` : ''}
              {isGps ? ` · ${points.length} 个 GPS 点` : ''}
            </Text>
          ) : null}
          <Field label="日期">
            <DateField value={date} onChange={setDate} />
          </Field>
        </Card>

        <Card>
          {isGps && trip.geocodeStatus !== 'ok' ? (
            <>
              <Notice>起终点地址还没有解析成功（可能没有网络）。坐标已保存，可以重试，或直接手动填写名称。</Notice>
              <Button title="重试地址解析" kind="secondary" onPress={onRetryGeocode} loading={geocoding} />
            </>
          ) : null}
          <PlaceInput
            label="起点"
            value={start}
            onChange={setStart}
            places={places}
            onPickOnMap={() => openPicker('start', '起点', start.lat ?? trip.startLat, start.lng ?? trip.startLng)}
          />
          {(start.name || start.address) && !places.some((p) => p.name === start.name) ? (
            <Button title="把起点存为常用地点" kind="ghost" onPress={() => saveAsPlace(start)} />
          ) : null}
          <StopsInput value={via} onChange={setVia} suggestions={stopSuggestions} />
          <PlaceInput
            label="终点"
            value={end}
            onChange={setEnd}
            places={places}
            onPickOnMap={() => openPicker('end', '终点', end.lat ?? trip.endLat, end.lng ?? trip.endLng)}
          />
          {(end.name || end.address) && !places.some((p) => p.name === end.name) ? (
            <Button title="把终点存为常用地点" kind="ghost" onPress={() => saveAsPlace(end)} />
          ) : null}
        </Card>

        <Card>
          <Field label="报表中的路线描述" hint="Word / Excel 每行显示为：日期 + 这段描述（和样板一致，例如 From home to B&Q Farnborough to home）">
            <Text style={{ color: autoDesc ? t.text : t.warning, lineHeight: 20 }}>
              {formatDateSlash(date)} {customDesc && reportDesc.trim() ? reportDesc.trim() : autoDesc || '（缺少起点 / 终点，无法生成）'}
            </Text>
          </Field>
          <SwitchRow label="自定义描述" hint="打开后用下面的文字代替自动生成的描述" value={customDesc} onChange={setCustomDesc} />
          {customDesc ? (
            <Input value={reportDesc} onChangeText={setReportDesc} multiline placeholder={autoDesc || 'From home to … to home'} />
          ) : null}
        </Card>

        <Card>
          {isGps ? (
            <>
              <Field label={`申报里程（${unitLabel(unit)}）`} hint={
                  trip.gapFillM > 0
                    ? `GPS 实测 ${round1(metersToUnit(trip.distanceGpsM, unit)).toFixed(1)} + 信号中断补算 ${round1(metersToUnit(trip.gapFillM, unit)).toFixed(1)} = ${gpsText} ${unitLabel(unit)}。报表使用这里的申报里程。`
                    : `GPS 原始里程 ${gpsText} ${unitLabel(unit)}（保留不变）。报表使用这里的申报里程。`
                }>
                <Input value={distanceText} onChangeText={setDistanceText} keyboardType="decimal-pad" />
              </Field>
              {distanceText !== gpsText ? (
                <>
                  <Text style={{ color: t.warning }}>已手动修正：报表将使用 {distanceText} {unitLabel(unit)}，不是自动计算的 {gpsText}</Text>
                  <Button title={trip.gapFillM > 0 ? '恢复为 GPS + 补算里程' : '恢复为 GPS 里程'} kind="ghost" onPress={() => setDistanceText(gpsText)} />
                </>
              ) : null}
            </>
          ) : (
            <>
              <Field label={`单程里程（${unitLabel(unit)}）`} hint="只填单程；打开「往返」后报销里程自动按 ×2 计算，不会重复乘">
                <Input value={oneWayText} onChangeText={setOneWayText} keyboardType="decimal-pad" />
              </Field>
              <SwitchRow
                label="往返"
                hint={oneWay != null ? `报销里程 ${(roundTrip ? oneWay * 2 : oneWay).toFixed(1)} ${unitLabel(unit)}（手动填写，非地图计算）` : undefined}
                value={roundTrip}
                onChange={setRoundTrip}
              />
            </>
          )}
        </Card>

        <Card>
          <Field label="路线截图（可选）" hint="例如 Google 地图截图。附加后 Word 用截图；不附加时，GPS 行程用自动生成的 OpenStreetMap 路线图。">
            {image ? (
              <Image source={{ uri: image.uri }} style={{ width: '100%', aspectRatio: image.width / image.height, borderRadius: 8 }} contentFit="contain" />
            ) : null}
          </Field>
          <View style={styles.row}>
            <Button title={image ? '更换截图' : '添加截图'} kind="secondary" onPress={onPickImage} style={{ flex: 1 }} />
            {image ? <Button title="移除" kind="ghost" onPress={() => setImage(null)} /> : null}
          </View>
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
          {commute && category === 'business' ? (
            commuteConfirmed ? (
              <SwitchRow label="已确认这是公务行程（不是通勤）" value onChange={setCommuteConfirmed} />
            ) : (
              <>
                <Notice>
                  这条行程看起来是「家 ↔ 固定办公室」。按 HMRC 规则普通通勤一般不能作为公务里程；
                  但如果中途有公务（例如先去客户 / 门店），请确认后保留。App 不会自动删除或改分类。
                </Notice>
                <View style={styles.row}>
                  <Button title="确认是公务" kind="secondary" onPress={() => setCommuteConfirmed(true)} style={{ flex: 1 }} />
                  <Button title="改为私人" kind="ghost" onPress={() => setCategory('personal')} style={{ flex: 1 }} />
                </View>
              </>
            )
          ) : null}
          <Field label="出差事由（可选，样板不显示）">
            <Input value={purpose} onChangeText={setPurpose} placeholder="例如：客户拜访、门店巡检" />
            <Chips items={data.purposes.filter((p) => p !== purpose)} onPick={setPurpose} />
          </Field>
          <Field label="客户 / 项目（可选）">
            <Input value={client} onChangeText={setClient} />
            <Chips items={data.clients.filter((c) => c !== client)} onPick={setClient} />
          </Field>
          <Field label="备注">
            <Input value={notes} onChangeText={setNotes} multiline placeholder="可选" />
          </Field>
        </Card>

        <Button title="保存" onPress={onSave} loading={saving} />
        {life.state === 'active' ? (
          <Button title={trip.claimedAt ? '标记为未报销' : '标记为已报销'} kind="secondary" onPress={onToggleClaimed} />
        ) : null}
        {life.state !== 'trash' ? <Button title="删除行程" kind="ghost" onPress={onDelete} /> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.md, paddingBottom: 64 },
  summary: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  row: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
});
