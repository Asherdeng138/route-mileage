/**
 * 轨迹质量：路线图是把 GPS 点按顺序连起来画的。点越密，路线越贴合实际道路（转弯、路口都能看出来）；
 * 中间如果有一段很久没有定位（隧道、地下停车场、手机省电限制、定位权限是「大致位置」），
 * 这一段只能按直线连接。这里找出这些中断，在界面上提示原因。
 */
import { haversineM } from './geo';
import type { TrackPoint } from './types';

/** 两点间隔超过这个秒数，算一次「定位中断」 */
export const GAP_WARN_SEC = 90;

export interface TrackGap {
  fromTs: number;
  seconds: number;
  /** 中断两端的直线距离（米） */
  meters: number;
}

export interface TrackQuality {
  points: number;
  durationSec: number;
  /** 平均每个点间隔多少秒 */
  avgIntervalSec: number | null;
  gaps: TrackGap[];
  /** 按直线连接的距离占全程的比例（0–1） */
  straightShare: number;
}

export function trackQuality(points: TrackPoint[]): TrackQuality {
  const gaps: TrackGap[] = [];
  let total = 0;
  let straight = 0;
  for (let i = 1; i < points.length; i++) {
    const dt = (points[i].ts - points[i - 1].ts) / 1000;
    const d = haversineM(points[i - 1], points[i]);
    total += d;
    if (dt > GAP_WARN_SEC) {
      gaps.push({ fromTs: points[i - 1].ts, seconds: dt, meters: d });
      straight += d;
    }
  }
  const durationSec = points.length > 1 ? (points[points.length - 1].ts - points[0].ts) / 1000 : 0;
  return {
    points: points.length,
    durationSec,
    avgIntervalSec: points.length > 1 ? durationSec / (points.length - 1) : null,
    gaps: gaps.sort((a, b) => b.seconds - a.seconds),
    straightShare: total > 0 ? straight / total : 0,
  };
}
