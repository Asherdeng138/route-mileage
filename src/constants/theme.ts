import { useColorScheme } from 'react-native';

/**
 * 配色仿照 Apple 人机界面指南的系统颜色（iOS 分组列表风格）：
 * 浅灰分组背景 + 白色圆角卡片、无描边，系统蓝作为操作色，系统红 / 绿 / 橙表示状态。
 */
const light = {
  bg: '#F2F2F7', // systemGroupedBackground
  card: '#FFFFFF', // secondarySystemGroupedBackground
  text: '#000000', // label
  textSecondary: '#6C6C70', // secondaryLabel（加深一点，保证对比度）
  border: '#D1D1D6', // separator
  primary: '#007AFF', // systemBlue
  primaryText: '#FFFFFF',
  primarySoft: '#E5F0FF',
  record: '#FF3B30', // systemRed
  recordSoft: '#FFECEB',
  success: '#248A3D', // systemGreen（文字用深一档）
  successSoft: '#E6F6EA',
  warning: '#C93400', // systemOrange（文字用深一档）
  warningSoft: '#FFF2E0',
  personal: '#6C6C70',
  personalSoft: '#EEEEF0',
  input: '#F2F2F7', // tertiarySystemFill 近似
  switchOn: '#34C759',
  segmentBg: '#E9E9EB',
  segmentActive: '#FFFFFF',
};

const dark: typeof light = {
  bg: '#000000',
  card: '#1C1C1E',
  text: '#FFFFFF',
  textSecondary: '#98989F',
  border: '#38383A',
  primary: '#0A84FF',
  primaryText: '#FFFFFF',
  primarySoft: '#0A2440',
  record: '#FF453A',
  recordSoft: '#3A1A18',
  success: '#30D158',
  successSoft: '#11301B',
  warning: '#FF9F0A',
  warningSoft: '#3A2A10',
  personal: '#98989F',
  personalSoft: '#2C2C2E',
  input: '#2C2C2E',
  switchOn: '#30D158',
  segmentBg: '#1C1C1E',
  segmentActive: '#636366',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 10, md: 12, lg: 16, pill: 999 } as const;

/** iOS 字号层级（Large Title 34 / Title2 22 / Headline 17 / Body 17 / Subhead 15 / Footnote 13 / Caption 12） */
export const type = {
  largeTitle: { fontSize: 34, fontWeight: '700' as const, letterSpacing: 0.3 },
  title2: { fontSize: 22, fontWeight: '700' as const },
  headline: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 17 },
  subhead: { fontSize: 15 },
  footnote: { fontSize: 13 },
  caption: { fontSize: 12 },
};
