/**
 * 共用界面组件，风格参照 iOS：分组背景上的白色圆角卡片、无描边，
 * 系统蓝按钮、灰色说明文字、iOS 式分段控件和绿色开关。各页面都用这些组件，改这里即可统一风格。
 */
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { radius, space, type, useTheme } from '@/constants/theme';
import { formatDateLong, parseISODate, toISODate } from '@/lib/dates';

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: t.card }, style]}>{children}</View>;
}

/** 分组标题（iOS 列表上方的灰色小字） */
export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={styles.sectionRow}>
      <Text style={[styles.sectionTitle, { color: t.textSecondary }]}>{children}</Text>
      {right}
    </View>
  );
}

/** 页面大标题（iOS Large Title） */
export function LargeTitle({ children, subtitle }: { children: ReactNode; subtitle?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 2, marginTop: space.sm }}>
      {subtitle ? <Text style={[type.footnote, { color: t.textSecondary, fontWeight: '600' }]}>{subtitle}</Text> : null}
      <Text style={[type.largeTitle, { color: t.text }]}>{children}</Text>
    </View>
  );
}

type ButtonKind = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  loading,
  style,
  big,
}: {
  title: string;
  onPress: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  big?: boolean;
}) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.primary : kind === 'danger' ? t.record : kind === 'secondary' ? t.primarySoft : 'transparent';
  const fg = kind === 'primary' || kind === 'danger' ? '#FFFFFF' : t.primary;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        big && styles.buttonBig,
        kind === 'ghost' && styles.buttonGhost,
        { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
        style,
      ]}>
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.buttonText, big && styles.buttonTextBig, kind === 'ghost' && { fontWeight: '400' }, { color: fg }]}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: t.textSecondary }]}>{label}</Text>
      {children}
      {hint ? <Text style={[styles.hint, { color: t.textSecondary }]}>{hint}</Text> : null}
    </View>
  );
}

export function Input(props: TextInputProps & { style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return (
    <TextInput
      placeholderTextColor={t.textSecondary}
      selectionColor={t.primary}
      {...props}
      style={[
        styles.input,
        { backgroundColor: t.input, color: t.text },
        props.multiline && { minHeight: 80, textAlignVertical: 'top', paddingTop: 12 },
        props.style,
      ]}
    />
  );
}

/** iOS 分段控件：灰色底槽 + 白色滑块 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const t = useTheme();
  return (
    <View style={[styles.segment, { backgroundColor: t.segmentBg }]}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(o.value)}
            style={[styles.segmentItem, active && [styles.segmentActive, { backgroundColor: t.segmentActive }]]}>
            <Text style={[styles.segmentText, { color: t.text }, active && { fontWeight: '600' }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chips({ items, onPick }: { items: string[]; onPick: (v: string) => void }) {
  const t = useTheme();
  if (!items.length) return null;
  return (
    <View style={styles.chips}>
      {items.map((v) => (
        <Pressable
          key={v}
          onPress={() => onPick(v)}
          style={({ pressed }) => [styles.chip, { backgroundColor: t.primarySoft, opacity: pressed ? 0.6 : 1 }]}>
          <Text style={[styles.chipText, { color: t.primary }]} numberOfLines={1}>
            {v}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function SwitchRow({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  const t = useTheme();
  return (
    <View style={styles.switchRow}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.rowLabel, { color: t.text }]}>{label}</Text>
        {hint ? <Text style={[styles.hint, { color: t.textSecondary }]}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: t.switchOn, false: t.segmentBg }} thumbColor="#FFFFFF" />
    </View>
  );
}

/** 日期选择（安卓系统日期对话框） */
export function DateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useTheme();
  const open = () =>
    DateTimePickerAndroid.open({
      value: parseISODate(value),
      mode: 'date',
      maximumDate: new Date(),
      onChange: (event, date) => {
        if (event.type === 'set' && date) onChange(toISODate(date));
      },
    });
  return (
    <Pressable accessibilityRole="button" onPress={open} style={[styles.input, styles.dateField, { backgroundColor: t.input }]}>
      <Text style={[styles.dateText, { color: t.text }]}>{formatDateLong(value)}</Text>
      <Text style={{ color: t.primary, fontSize: 17 }}>修改</Text>
    </Pressable>
  );
}

export function Badge({ label, tone }: { label: string; tone: 'business' | 'personal' | 'success' | 'warning' | 'record' }) {
  const t = useTheme();
  const map = {
    business: [t.primarySoft, t.primary],
    personal: [t.personalSoft, t.personal],
    success: [t.successSoft, t.success],
    warning: [t.warningSoft, t.warning],
    record: [t.recordSoft, t.record],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeText, { color: fg }]}>{label}</Text>
    </View>
  );
}

export function Notice({ tone = 'warning', children }: { tone?: 'warning' | 'info'; children: ReactNode }) {
  const t = useTheme();
  const bg = tone === 'warning' ? t.warningSoft : t.card;
  const fg = tone === 'warning' ? t.warning : t.textSecondary;
  return (
    <View style={[styles.notice, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: 15, lineHeight: 21 }}>{children}</Text>
    </View>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  const t = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: t.textSecondary }]}>{label}</Text>
      <Text style={[styles.statValue, { color: t.text }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {sub ? <Text style={[styles.hint, { color: t.textSecondary }]}>{sub}</Text> : null}
    </View>
  );
}

export function MonthSwitcher({
  label,
  onPrev,
  onNext,
  nextDisabled,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={[styles.monthRow, { backgroundColor: t.card }]}>
      <Pressable onPress={onPrev} hitSlop={12} style={styles.monthBtn} accessibilityLabel="上个月">
        <Text style={[styles.monthArrow, { color: t.primary }]}>‹</Text>
      </Pressable>
      <Text style={[styles.monthLabel, { color: t.text }]}>{label}</Text>
      <Pressable
        onPress={onNext}
        disabled={nextDisabled}
        hitSlop={12}
        style={[styles.monthBtn, nextDisabled && { opacity: 0.25 }]}
        accessibilityLabel="下个月">
        <Text style={[styles.monthArrow, { color: t.primary }]}>›</Text>
      </Pressable>
    </View>
  );
}

export const styles = StyleSheet.create({
  card: {
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.md,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginTop: space.md,
    marginBottom: -space.xs,
    paddingHorizontal: space.lg,
  },
  sectionTitle: { fontSize: 13, letterSpacing: 0.2 },
  button: {
    minHeight: 50,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonBig: { minHeight: 58, borderRadius: radius.lg },
  buttonGhost: { minHeight: 44 },
  buttonText: { fontSize: 17, fontWeight: '600' },
  buttonTextBig: { fontSize: 19 },
  field: { gap: 6 },
  label: { fontSize: 13 },
  hint: { fontSize: 13, lineHeight: 18 },
  input: {
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 17,
    minHeight: 46,
  },
  dateField: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dateText: { fontSize: 17 },
  segment: { flexDirection: 'row', borderRadius: 9, padding: 2 },
  segmentItem: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 7 },
  segmentActive: {
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  segmentText: { fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, maxWidth: 240 },
  chipText: { fontSize: 15 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rowLabel: { fontSize: 17 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, alignSelf: 'flex-start' },
  badgeText: { fontSize: 12, fontWeight: '600' },
  notice: { borderRadius: radius.md, padding: space.lg },
  stat: { flex: 1, gap: 2 },
  statLabel: { fontSize: 13 },
  statValue: { fontSize: 28, fontWeight: '700', fontVariant: ['tabular-nums'] },
  monthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: radius.md,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
  },
  monthBtn: { paddingHorizontal: space.md, paddingVertical: space.xs },
  monthArrow: { fontSize: 30, fontWeight: '400', lineHeight: 34 },
  monthLabel: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
});
