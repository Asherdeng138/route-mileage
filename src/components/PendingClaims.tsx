import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { space, useTheme } from '@/constants/theme';
import { confirmClaim, type ClaimRecord } from '@/db/claims';
import { ARCHIVE_DAYS, TRASH_DAYS } from '@/lib/archive';
import { formatDateShort, monthLabel } from '@/lib/dates';
import { formatPence, formatTenths } from '@/lib/money';

import { Button, Card } from './ui';

export type ConfirmResult = 'cancel' | 'confirmed';

/**
 * 确认公司已报销：报表锁定，行程标记为已报销并移到底部「归档」（报表里只留未报销的）。
 * 在归档里保留 30 天，之后移到「最近删除」再保留 30 天才自动删除；本年累计里程不受影响。
 */
export function confirmReimbursed(claim: Pick<ClaimRecord, 'id' | 'month' | 'tripIds' | 'totalPence' | 'totalTenths'>): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    Alert.alert(
      '公司已经报销了？',
      `${monthLabel(claim.month)} · ${claim.tripIds.length} 条行程 · ${formatTenths(claim.totalTenths)} 英里 · ${formatPence(claim.totalPence)}\n\n` +
        `确认后这份报表锁定，和它的行程一起移到底部的「归档」，报表里就不再显示。\n\n` +
        `在「归档」保留 ${ARCHIVE_DAYS} 天，之后移到「最近删除」再保留 ${TRASH_DAYS} 天才自动删除（本年累计里程不受影响）。在「归档」里随时可以撤销。`,
      [
        { text: '取消', style: 'cancel', onPress: () => resolve('cancel') },
        {
          text: '确认已报销',
          onPress: async () => {
            try {
              await confirmClaim(claim.id);
              resolve('confirmed');
            } catch (e) {
              Alert.alert('操作失败', (e as Error).message);
              resolve('cancel');
            }
          },
        },
      ],
      { cancelable: true, onDismiss: () => resolve('cancel') },
    );
  });
}

/** 等待公司报销的导出记录（所有月份），每份一个「已报销」按钮 */
export function PendingClaimsCard({ claims, onChanged }: { claims: ClaimRecord[]; onChanged: () => void }) {
  const t = useTheme();
  const [busy, setBusy] = useState<number | null>(null);
  if (!claims.length) return null;

  const onConfirm = async (c: ClaimRecord) => {
    setBusy(c.id);
    try {
      const r = await confirmReimbursed(c);
      if (r !== 'cancel') onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card style={{ gap: space.sm }}>
      <Text style={[styles.title, { color: t.text }]}>等待公司报销</Text>
      <Text style={[styles.hint, { color: t.textSecondary }]}>已导出、还没报销的报表。公司付款后点「已报销」，报表会移到底部「归档」。</Text>
      {claims.map((c, i) => (
        <View key={c.id} style={[styles.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.month, { color: t.text }]}>
              {monthLabel(c.month)} · {formatPence(c.totalPence)}
            </Text>
            <Text style={[styles.hint, { color: t.textSecondary }]}>
              {c.tripIds.length} 条 · {formatTenths(c.totalTenths)} 英里 · 导出于 {formatDateShort(new Date(c.createdAt).toISOString().slice(0, 10))}
            </Text>
          </View>
          <Button title="已报销" onPress={() => onConfirm(c)} loading={busy === c.id} style={styles.btn} />
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 17, fontWeight: '600' },
  hint: { fontSize: 13, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingTop: space.sm },
  month: { fontSize: 16, fontWeight: '600' },
  btn: { minHeight: 40, paddingHorizontal: space.lg },
});
