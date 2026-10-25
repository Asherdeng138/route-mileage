import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Alert, AppState, useColorScheme } from 'react-native';

import { useTheme } from '@/constants/theme';
import { ensureDefaultPlaces } from '@/db/places';
import { getAppSettings } from '@/db/settings';
import { formatTime } from '@/lib/dates';
import { formatDistance } from '@/lib/units';
import { loadGoogleKey } from '@/services/google';
import { archiveMaintenanceOnLaunch } from '@/services/archive';
import { retryPendingGapFills } from '@/services/gapFill';
import { retryPendingRouteMaps } from '@/services/routeMap';
import {
  findInterruptedTrip,
  refreshServiceOnForeground,
  resumeRecording,
  retryPendingGeocodes,
  stopRecording,
} from '@/tracking/recorder';

SplashScreen.preventAutoHideAsync();

/** 打开 App 时：发现被中断的记录（App 被杀、手机重启）→ 让用户选择继续或结束；重试失败的地址解析 */
async function checkOnLaunch() {
  await loadGoogleKey().catch(() => '');
  await ensureDefaultPlaces().catch(() => 0);
  // 归档满 30 天 → 最近删除；最近删除满 30 天 → 永久删除（只保留已报销行程的里程记录）
  await archiveMaintenanceOnLaunch().catch((e) => console.warn('[route] archive maintenance failed', e));
  const interrupted = await findInterruptedTrip();
  if (interrupted) {
    const { trip, points } = interrupted;
    const unit = (await getAppSettings()).unit;
    Alert.alert(
      '发现未结束的行程',
      `${formatTime(trip.startTime)} 开始的记录已中断（App 被关闭或手机重启）。已保存 ${points} 个 GPS 点，` +
        `约 ${formatDistance(trip.distanceGpsM, unit)}。中断期间的路线没有记录。`,
      [
        {
          text: '结束并保存',
          onPress: async () => {
            const id = await stopRecording();
            if (id != null) router.push({ pathname: '/trip/[id]', params: { id: String(id), fresh: '1' } });
          },
        },
        {
          text: '继续记录',
          onPress: async () => {
            const r = await resumeRecording();
            if (r.ok) router.push('/recording');
            else Alert.alert('无法继续记录', r.message);
          },
        },
      ],
      { cancelable: false },
    );
  }
  retryPendingGeocodes()
    .catch(() => undefined)
    .then(() => retryPendingGapFills())
    .catch(() => undefined)
    .then(() => retryPendingRouteMaps())
    .catch(() => undefined);
}

export default function RootLayout() {
  const scheme = useColorScheme();
  const t = useTheme();

  useEffect(() => {
    SplashScreen.hideAsync();
    checkOnLaunch().catch((e) => console.warn('[route] launch check failed', e));
    // 回到前台：补上前台服务参数（后台切换省电模式时不能带，见 tracking/power.ts）
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refreshServiceOnForeground().catch(() => undefined);
    });
    return () => sub.remove();
  }, []);

  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  return (
    <ThemeProvider
      value={{
        ...base,
        colors: { ...base.colors, background: t.bg, card: t.card, primary: t.primary, text: t.text, border: t.border },
      }}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.bg },
          headerShadowVisible: false,
          headerTintColor: t.primary,
          headerTitleStyle: { fontWeight: '600', fontSize: 17, color: t.text },
          contentStyle: { backgroundColor: t.bg },
        }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="recording" options={{ title: '正在记录', headerBackVisible: true }} />
        <Stack.Screen name="trip/[id]" options={{ title: '行程详情' }} />
        <Stack.Screen name="trip/new" options={{ title: '手动补录' }} />
        <Stack.Screen name="place/[id]" options={{ title: '常用地点' }} />
        <Stack.Screen name="rates" options={{ title: '报销费率' }} />
        <Stack.Screen name="month-miles" options={{ title: '往月里程' }} />
        <Stack.Screen name="help" options={{ title: '后台记录说明' }} />
        <Stack.Screen name="archive" options={{ title: '归档与最近删除' }} />
        <Stack.Screen name="pick-place" options={{ title: '选择地点' }} />
        <Stack.Screen name="google" options={{ title: 'Google 地点' }} />
      </Stack>
    </ThemeProvider>
  );
}
