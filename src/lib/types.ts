import type { YearBasis } from './dates';

export type Category = 'business' | 'personal';
export type TripSource = 'gps' | 'manual';
export type TripStatus = 'recording' | 'completed';
export type DistanceUnit = 'mi' | 'km';
export type PlaceType = 'home' | 'office' | 'client' | 'other';
export type GeocodeStatus = 'ok' | 'pending' | 'failed';
export type RouteMapStatus = 'none' | 'pending' | 'ok' | 'failed';
/** 信号中断补算：none 不需要 / 未处理；pending 等联网；done 已补算；off 用户撤销；failed 查询失败（可重试） */
export type GapFillStatus = 'none' | 'pending' | 'done' | 'off' | 'failed';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Trip {
  id: number;
  /** 行程日期，本地时间 YYYY-MM-DD */
  date: string;
  startTime: number | null;
  endTime: number | null;
  startName: string | null;
  startAddress: string | null;
  startLat: number | null;
  startLng: number | null;
  endName: string | null;
  endAddress: string | null;
  endLat: number | null;
  endLng: number | null;
  /** GPS 实测里程（米） */
  distanceGpsM: number;
  /** 报销用里程（米）。默认等于 GPS 里程，手动修改后以此为准 */
  distanceM: number;
  distanceEdited: boolean;
  purpose: string | null;
  client: string | null;
  notes: string | null;
  category: Category;
  source: TripSource;
  status: TripStatus;
  roundTrip: boolean;
  /** 手动补录的单程里程（米）；往返时报销里程 = 单程 × 2。GPS 行程为 null */
  oneWayM: number | null;
  /** 途经地点（按顺序），用于生成报表里的 "From A to B to C" */
  via: string[];
  /** 报表路线描述（手工改写后优先使用）；为空则由起点 / 途经 / 终点自动生成 */
  reportDesc: string | null;
  /** 地址解析状态：pending 未解析，failed 解析失败（已保留坐标，可重试或手填） */
  geocodeStatus: GeocodeStatus;
  /** 用户已确认这条「家 ↔ 固定办公室」行程确属公务（不是通勤） */
  commuteConfirmed: boolean;
  /** 附加的路线截图（例如 Google 地图截图），导出 Word 时作为路线图 */
  mapImageUri: string | null;
  mapImageW: number | null;
  mapImageH: number | null;
  /** 行程结束后自动生成的 OpenStreetMap 路线图（PNG，App 私有目录） */
  routeMapUri: string | null;
  routeMapW: number | null;
  routeMapH: number | null;
  /** none：不需要 / 无法生成；pending：等联网生成；ok：已生成；failed：生成失败（可重试） */
  routeMapStatus: RouteMapStatus;
  claimedAt: number | null;
  /** 确认报销时所属的报销快照 */
  claimId: number | null;
  /** 归档时间（已报销后归档，从行程列表隐藏） */
  archivedAt: number | null;
  /** 移到「最近删除」的时间（可恢复） */
  deletedAt: number | null;
  /** 永久删除的时间：只保留日期和里程（年度累计用），界面上不再显示 */
  purgedAt: number | null;
  /** 信号中断补算增加的里程（米，路线 − 直线）；已计入 distanceM（除非手动修正过） */
  gapFillM: number;
  gapFillStatus: GapFillStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TrackPoint extends LatLng {
  ts: number;
  accuracy: number | null;
  speed: number | null;
}

export interface Place {
  id: number;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  radiusM: number;
  type: PlaceType;
}

export interface AppSettings {
  unit: DistanceUnit;
  /** 可选：写入导出文件的作者信息（样板正文没有姓名栏） */
  employeeName: string;
  companyName: string;
  /** 「本年累计」口径 */
  yearBasis: YearBasis;
  /** Word 中相同路线、相同里程的多次行程合并成一段（如样板 "2026/09/02&2026/09/04 …"） */
  groupSameRoutes: boolean;
  /** 没有附加截图时，在 Word 中插入路线图（有地图用地图，没有则用轨迹预览） */
  embedTrackPreview: boolean;
  /** 使用 OpenStreetMap 在线地图（记录页实时地图、行程结束后生成路线图） */
  onlineMaps: boolean;
  /** 使用 Google Places 识别起终点附近的地点（需要 API Key） */
  googleEnabled: boolean;
  /** Google 每月调用上限（App 端硬上限），超过后自动改用免费来源 */
  googleMonthlyLimit: number;
  /** 信号中断时按 Google 驾车路线补算里程 */
  gapFill: boolean;
  /** 停留多少分钟自动结束行程（0 = 不自动结束） */
  autoEndMinutes: number;
  /** 地图：Google 原生地图（需要构建时 Key + Maps SDK for Android）或 OpenStreetMap */
  mapProvider: 'google' | 'osm';
}
