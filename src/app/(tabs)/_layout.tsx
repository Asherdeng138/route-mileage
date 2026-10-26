import { NativeTabs } from 'expo-router/native-tabs';

import { useTheme } from '@/constants/theme';

export default function TabsLayout() {
  const t = useTheme();
  return (
    <NativeTabs
      backgroundColor={t.card}
      disableIndicator
      rippleColor={t.primarySoft}
      labelVisibilityMode="labeled"
      iconColor={{ default: t.textSecondary, selected: t.primary }}
      labelStyle={{ default: { color: t.textSecondary }, selected: { color: t.primary } }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>首页</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon md="home" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="trips">
        <NativeTabs.Trigger.Label>行程</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon md="route" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="reports">
        <NativeTabs.Trigger.Label>报表</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon md="receipt_long" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="archive">
        <NativeTabs.Trigger.Label>归档</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon md="inventory_2" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>设置</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
