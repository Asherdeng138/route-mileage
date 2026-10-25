/**
 * GPS 记录与过滤的全部阈值集中在这里（单元测试覆盖 src/lib/geo.ts 中的过滤逻辑）。
 *
 * 取舍：过滤太松，停车时的漂移会累加成「假里程」；过滤太严，慢速 / 弯道会少算。
 * 下一个点与「上一个被接受的点」比较距离，所以慢速时被跳过的点不会丢里程，
 * 只是等累计位移超过阈值后再一起计入。
 */
export const FILTER = {
  /** 精度差于该值（米）的点丢弃 */
  maxAccuracyM: 50,
  /** 与上一个有效点的最小位移（米），低于此视为原地漂移 */
  minStepM: 15,
  /** 精度较差时提高最小位移：阈值 = max(minStepM, 精度 × 系数)，但不超过 maxDriftStepM */
  accuracyStepFactor: 0.8,
  maxDriftStepM: 35,
  /**
   * 静止判定：报告速度或「与上一有效点之间的平均速度」低于该值（米/秒，约 1.8 mph），
   * 且位移小于 精度 × stationaryAccuracyFactor 时，视为停车漂移。
   * 真实的慢速移动不会丢：位移累积超过该范围后会一次性计入。
   */
  stationarySpeedMps: 0.8,
  stationaryAccuracyFactor: 3,
  /** 隐含速度超过该值（米/秒，约 157 mph）视为跳点 */
  maxSpeedMps: 70,
  /** 两点间隔超过该秒数时不做速度检查（隧道、地下停车场后恢复信号） */
  gapResetSec: 120,
} as const;

/**
 * 行驶中（高精度 GPS）的采样，传给 expo-location startLocationUpdatesAsync。
 * 省电优化 #5（2026-10-24）：每 5 秒 / 10 米 → 每 8 秒；市区转弯仍能看出路线形状。
 * 不设最小距离（0）：安卓设了最小距离后停车时完全不回调，停车判定（切低功耗 / 提醒 / 自动结束）就无法工作。
 * GPS 在两种设置下都一直开着，停车时多几次回调几乎不耗电，且 2 分钟后就切到低功耗。
 */
export const LOCATION_UPDATES = {
  timeIntervalMs: 8000,
  distanceIntervalM: 0,
  /** 省电优化 #3：App 在后台 / 锁屏时，系统把定位点攒起来，每 60 秒交给 App 一次（GPS 照常采样） */
  deferredUpdatesIntervalMs: 60000,
} as const;

/**
 * 省电优化 #2：停车后切到低功耗定位（不用 GPS，用 Wi-Fi / 基站，每 30 秒一次），检测到再次移动立即切回高精度。
 * 代价：重新起步后最多约 30–60 秒的路段按直线计入。
 */
export const LOW_POWER_UPDATES = {
  timeIntervalMs: 30000,
  distanceIntervalM: 0,
  deferredUpdatesIntervalMs: 30000,
} as const;

/** 停车判定（src/lib/stillness.ts） */
export const STILL = {
  /** 高精度模式：离「停车点」超过 max(该值, 定位精度) 算移动 */
  moveRadiusM: 40,
  /** 低功耗模式（Wi-Fi / 基站定位误差大）：离停车点超过 max(该值, 2 × 精度) 才算移动 */
  lowPowerMoveRadiusM: 150,
  /** 报告速度超过该值（米/秒，约 11 km/h）直接算移动 */
  moveSpeedMps: 3,
  /** 停住超过该秒数切到低功耗 */
  lowPowerAfterSec: 120,
  /** 停住超过该分钟数提醒一次「是否已到达」（自动结束开启时为其一半，最多 10 分钟） */
  remindAfterMin: 10,
} as const;

/** 省电优化 #1：停留多少分钟后自动结束行程（设置里可改，0 = 不自动结束） */
export const DEFAULT_AUTO_END_MIN = 20;

/** 记录页：最近一次定位超过该秒数，提示「定位暂时丢失」 */
export const STALE_FIX_SEC = 90;
/** 省电优化 #4：记录页刷新间隔、权限检查间隔（只在 App 处于前台时刷新） */
export const RECORDING_REFRESH_MS = 5000;
export const PERMISSION_CHECK_MS = 30000;
/** 开始 / 结束时取当前位置的超时 */
export const CURRENT_FIX_TIMEOUT_MS = 8000;

/**
 * 信号中断补算（src/lib/gaps.ts）：两个相邻 GPS 点之间断开太久、离得太远时，
 * 用 Google 驾车路线中「预计用时最接近实际断开时间」的那条路线的长度代替直线。
 */
export const GAP_FILL = {
  /** 断开至少多少秒才补算 */
  minGapSec: 60,
  /** 两端直线距离至少多少米才补算（更近的直线误差很小） */
  minStraightM: 300,
  /** 路线预计用时 ≤ 断开时间 × 该系数 + slackSec 才算「来得及开完」（允许比 Google 预计开得快一些） */
  feasibleFactor: 1.25,
  feasibleSlackSec: 60,
  /** 断开时间超过最长可行路线用时的这个倍数：中途多半停过车，改用 Google 推荐路线，而不是更长的绕路 */
  stoppedFactor: 2,
  /** 平均速度上限（米/秒，约 90 mph），超过则不合理 */
  maxSpeedMps: 40.2,
} as const;
