import { Linking, ScrollView, StyleSheet, Text } from 'react-native';

import { Button, Card, SectionTitle } from '@/components/ui';
import { space, useTheme } from '@/constants/theme';

const SECTIONS: { title: string; lines: string[] }[] = [
  {
    title: '怎样保证锁屏 / 切导航时继续记录',
    lines: [
      '开始记录后，通知栏会一直显示「正在记录行程」（安卓前台定位服务）。只要这条通知还在，锁屏或切到 Google 地图 / Waze 导航都会继续记录。',
      '定位权限建议设为「始终允许」；「仅使用时允许」在大多数手机上也能配合前台通知后台记录，但更容易被系统限制。',
      '安卓 13 及以上请允许通知，否则看不到记录状态（记录本身不受影响）。',
      '没有网络也能记录坐标和里程；地址会在有网络时再解析，也可以手动填写。',
    ],
  },
  {
    title: '省电：停车时自动降低定位频率',
    lines: [
      '行驶中约每 8 秒或每 20 米取一个点；App 在后台时，系统会把点攒起来约每 60 秒交给 App 一次（点不会少，只是晚一点写入）。',
      '停车超过 2 分钟会切到低功耗定位（约 30 秒一次）；一开动就恢复高精度。刚开动的 30–60 秒可能按直线补算，误差通常很小。',
      '在后台切换低功耗需要定位权限「始终允许」；只给了「仅使用时允许」时会保持高精度（更耗电，但不影响记录）。',
      '停留 10 分钟会提醒你结束记录；停留满设定时间（默认 20 分钟，可在「设置」里改或关闭）会自动结束并保存，结束时间取开始停留的时刻。',
      '记录页和首页在后台、锁屏时不刷新界面，回到 App 再更新。',
    ],
  },
  {
    title: '会中断记录的情况（App 无法绕过）',
    lines: [
      '在系统设置里「强制停止」App，或在多任务界面用某些厂商的「一键清理」：定位服务会被系统终止。',
      '手机重启或关机：记录不会自动恢复。再次打开 App 时会提示「继续记录 / 结束并保存」，中断期间没有轨迹。',
      '关闭手机定位服务或撤销定位权限：记录暂停，记录页会提示，重新打开后可继续。',
      '部分厂商（华为、小米、OPPO、vivo、三星等）的省电策略可能在后台杀掉服务，见下方设置。',
    ],
  },
  {
    title: '建议的省电设置',
    lines: [
      '系统设置 → 应用 → 里程记录 → 电池：选择「不受限制 / 无限制」。',
      '小米 / 红米：省电策略选「无限制」，并开启「自启动」。',
      '华为 / 荣耀：应用启动管理 → 里程记录 → 改为手动管理，三项全部打开。',
      '三星：电池 → 后台使用限制 → 把里程记录加入「从不休眠的应用」。',
      '各品牌菜单名称可能不同，可参考 dontkillmyapp.com 上对应机型的说明。',
    ],
  },
  {
    title: '里程如何计算',
    lines: [
      '只计入精度好于 50 米的点；与上一点距离太近（原地漂移）或速度不合理（跳点）的点不计入。',
      '慢速行驶时被跳过的点不会丢失里程：下一次位移足够大时会一起计入。',
      'GPS 原始里程会一直保留；你可以在行程里填写「申报里程」，报表使用申报里程，并在 Word 轨迹图下注明。',
    ],
  },
];

export default function HelpScreen() {
  const t = useTheme();
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={styles.content}>
      {SECTIONS.map((s) => (
        <Card key={s.title}>
          <SectionTitle>{s.title}</SectionTitle>
          {s.lines.map((l) => (
            <Text key={l} style={{ color: t.text, lineHeight: 21 }}>
              • {l}
            </Text>
          ))}
        </Card>
      ))}
      <Button title="打开本 App 的系统设置" kind="secondary" onPress={() => Linking.openSettings()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({ content: { padding: space.lg, gap: space.md, paddingBottom: 48 } });
