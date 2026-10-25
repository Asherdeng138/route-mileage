/**
 * 信号中断补算：行程结束后（或之后联网时）查询每段中断两端之间的 Google 驾车路线，
 * 选用时最接近的一条，把多出来的里程计入行程（规则见 src/lib/gaps.ts）。
 */
import { applyGapFill, listGaps, listPendingGapTrips, saveGapSpans, setGapResult } from '@/db/gaps';
import { getAppSettings } from '@/db/settings';
import { getPoints, getTrip } from '@/db/trips';
import { chooseRoute, findGaps } from '@/lib/gaps';
import type { GapFillStatus, TrackPoint } from '@/lib/types';

import { googleRoutes } from './google';
import { generateRouteMap } from './routeMap';

const REASON: Record<string, string> = {
  'no-key': '没有 Google Key',
  quota: '本月 Google 路线查询次数已用完（下个月自动恢复）',
};

/** 把 Google 的英文错误翻译成用户能处理的说明 */
function friendly(message: string | undefined): string {
  const m = message ?? '';
  if (/has not been used|SERVICE_DISABLED|is disabled/i.test(m)) return 'Google Cloud 项目里还没有启用 Routes API。启用后等几分钟，再点「重试」。';
  if (/blocked|API_KEY_SERVICE_BLOCKED/i.test(m)) return 'Key 的「API 限制」里没有勾选 Routes API。勾选保存后等几分钟，再点「重试」。';
  if (/billing/i.test(m)) return 'Google Cloud 结算账户有问题，请在 Google Cloud 检查结算。';
  return m || '未知错误';
}

/**
 * 补算一条行程。force：用户手动点「补算」（包括之前撤销过、或设置里关闭了自动补算）。
 * 返回补算后的状态；没有网络时保持 pending，下次打开 App 再试。
 */
export async function fillTripGaps(tripId: number, opts: { force?: boolean } = {}): Promise<GapFillStatus> {
  const trip = await getTrip(tripId);
  if (!trip || trip.source !== 'gps' || trip.status !== 'completed') return 'none';
  if (trip.claimedAt != null || trip.deletedAt != null || trip.purgedAt != null) return trip.gapFillStatus;
  if (trip.gapFillStatus === 'off' && !opts.force) return 'off';
  if (!opts.force && !(await getAppSettings()).gapFill) return trip.gapFillStatus;

  const points = await getPoints(tripId);
  await saveGapSpans(tripId, findGaps(points));
  const byTs = new Map<number, TrackPoint>(points.map((p) => [p.ts, p]));

  for (const g of await listGaps(tripId)) {
    if (g.status !== 'pending' && g.status !== 'failed') continue;
    const from = byTs.get(g.startTs);
    const to = byTs.get(g.endTs);
    if (!from || !to) {
      await setGapResult(g.id, { status: 'check', reason: 'no-points' });
      continue;
    }
    const r = await googleRoutes(from, to);
    if (r.status === 'offline') break; // 没网：保持等待，下次再试
    if (r.status !== 'ok') {
      await setGapResult(g.id, { status: 'failed', reason: REASON[r.status] ?? friendly(r.message) });
      break; // Key / 额度 / 接口错误对后面的路段也一样
    }
    const choice = chooseRoute({ gapSec: (g.endTs - g.startTs) / 1000, straightM: g.straightM }, r.routes);
    if (choice.kind === 'filled') {
      await setGapResult(g.id, {
        status: 'filled',
        routeM: choice.route.distanceM,
        routeS: choice.route.durationSec,
        path: choice.route.path,
        reason: choice.reason,
      });
    } else {
      await setGapResult(g.id, { status: 'check', reason: choice.reason });
    }
  }
  await applyGapFill(tripId, { force: opts.force });
  return (await getTrip(tripId))?.gapFillStatus ?? 'none';
}

/** 打开 App 时补算之前没网时没补算的行程（每次最多几条）。返回补算完成的行程 id */
export async function retryPendingGapFills(limit = 3): Promise<number[]> {
  if (!(await getAppSettings()).gapFill) return [];
  const done: number[] = [];
  for (const t of await listPendingGapTrips(limit)) {
    const status = await fillTripGaps(t.id);
    if (status === 'done') {
      done.push(t.id);
      await generateRouteMap(t.id).catch(() => undefined); // 路线图换成含补算路段的
    } else if (status === 'pending') {
      break; // 大概率没网
    }
  }
  return done;
}

/**
 * 行程结束后：先补算信号中断（最多等 waitMs，让行程页打开时就显示补算后的里程），
 * 再在后台生成（含补算虚线的）路线图。
 */
export async function afterTripFinished(tripId: number, waitMs = 0): Promise<void> {
  const filling = fillTripGaps(tripId).catch((e) => console.warn('[route] gap fill failed', e));
  const rest = filling.then(() => generateRouteMap(tripId)).catch(() => undefined);
  if (waitMs > 0) await Promise.race([filling, new Promise((r) => setTimeout(r, waitMs))]);
  else await rest;
}
