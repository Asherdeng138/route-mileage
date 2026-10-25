# 里程记录 App：框架规划

## 1. 目标
出差开私家车时，记录每一次行程：**日期、起点到终点、实际路线（地图轨迹）、里程、出差事由**。按月汇总后导出报表交给公司报销。

## 2. 两种记录方式（都要支持）
| 方式 | 怎么用 | 适合 |
|---|---|---|
| **A. GPS 实时记录** | 出发时按「开始」，到达时按「结束」，手机在后台记录 GPS 轨迹 | 日常出差，路线真实、可作证据 |
| **B. 手动补录** | 选日期，输入起点、终点（可加途经点），App 调用 Google 地图自动算路线和里程 | 忘了开记录、或事后补登 |

## 3. 功能模块
1. **行程记录（Tracking）**
   - 开始 / 暂停 / 结束；锁屏、切到导航 App 时继续后台记录
   - 每 5–10 秒或每移动 20–50 米记一个点（经纬度、时间、精度、速度）
   - 过滤误差点（精度差于 50 米的点丢弃、停车时的漂移不计入）
   - 里程 = 相邻轨迹点距离累加（Haversine 公式）；可选用 Google Roads API 把轨迹贴合到实际道路
2. **地点识别**
   - 起点 / 终点坐标用 Google Geocoding API 自动转成地址
   - 手动输入地点时用 Google Places 自动补全（输入几个字就出地址 / 店名）
   - 常用地点：家、公司、常去客户（比如各门店、总部），识别后直接显示名称
3. **行程详情与编辑**
   - **日期**：GPS 记录自动取当天；手动补录时用日期选择器，可改
   - 地图显示轨迹线、起终点标记
   - 填写：出差事由、客户 / 项目、备注、是否往返
   - 分类：公务 / 私人（只有公务计入报销）
   - 里程可手动修正（保留原始 GPS 里程作对照）
4. **列表与统计**
   - 按月分组的行程列表
   - 本月 / 本税年公务里程、预估可报金额
5. **报表导出**
   - 选时间段 → 导出 Excel/CSV 和 PDF（每条行程：日期、起点、终点、事由、英里数、金额；PDF 可附路线缩略图）
   - 格式尽量贴合公司报销表
6. **设置**
   - 单位：英里 / 公里
   - 报销费率（可改）：默认按 HMRC AMAP，2026/27 税年起前 10,000 英里 55p/英里，超出部分 25p/英里
   - 税年起算日 4 月 6 日（用于累计 10,000 英里门槛）
   - 家和固定办公地址（家 ↔ 固定办公室的通勤按 HMRC 规定不能报销，App 可提醒）
   - 数据备份 / 恢复

## 4. 页面结构
```
底部导航
├── 首页：大「开始记录」按钮 + 本月里程/金额卡片 + 最近 3 条行程
│     └── 记录中页面：实时地图、已行驶里程、用时、「结束」按钮
│           └── 结束后：确认起终点、填事由、选公务/私人 → 保存
├── 行程：按月列表（可筛选公务/私人）
│     ├── 行程详情：地图轨迹 + 信息 + 编辑
│     └── ＋ 手动补录：起点 / 途经点 / 终点 / 日期 → 自动算路线
├── 报表：选月份 → 汇总 → 导出 Excel / PDF / 分享
└── 设置：单位、费率、常用地点、备份
```

## 5. 数据模型
```
Trip 行程
  id, date (必填，YYYY-MM-DD), start_time, end_time
  start_place, start_address, start_lat, start_lng
  end_place,   end_address,   end_lat,   end_lng
  distance_gps, distance_final (实际报销用), unit
  purpose 事由, client 客户, notes
  category (business / personal), source (gps / manual)
  claimed (是否已报销), claim_id

TrackPoint 轨迹点
  id, trip_id, lat, lng, timestamp, accuracy, speed

Place 常用地点
  id, name, address, lat, lng, radius, type (home / office / client)

Claim 报销单
  id, period_start, period_end, total_miles, total_amount, exported_at, status
```

## 6. 技术选型（建议）
| 层 | 选择 | 理由 |
|---|---|---|
| 框架 | **Expo（React Native + TypeScript）** | 一套代码同时出 iPhone 和安卓；可在 Windows 上开发 |
| 后台定位 | expo-location + expo-task-manager | 用手机 GPS 定位，支持锁屏后台记录 |
| 地图 | react-native-maps（Google 地图） | 显示轨迹线和标记 |
| 地址 / 算路线 | Google Maps Platform | 准确度高，英国地址和门店名覆盖好 |
| 本地数据库 | expo-sqlite | 离线可用，数据在自己手机上 |
| 导出 | CSV / xlsx 生成 + expo-print 出 PDF + 系统分享 | 直接邮件或发给财务 |
| 云同步（后期） | Supabase 或 Firebase | 换手机不丢数据、电脑端查看 |

### 用到的 Google API
| API | 用途 |
|---|---|
| Maps SDK（Android / iOS） | App 里显示地图和路线 |
| Geocoding API | GPS 坐标 → 地址（起点 / 终点） |
| Places API（Autocomplete） | 手动补录时输入地点自动补全 |
| Routes API | 手动补录时按起点 / 途经点 / 终点算驾车路线和里程 |
| Roads API（可选） | 把 GPS 轨迹贴合到道路，里程更准 |

> 定位本身用手机自带 GPS（免费、最准），Google API 负责把坐标变成地址、算路线、显示地图。
> 需要在 Google Cloud Console 建项目、开启以上 API、生成 API Key 并绑定结算账户。个人使用量一般在免费额度内。
> API Key 要限制为只允许本 App 使用，不写进公开代码。

> 注意：网页版（PWA）无法在锁屏后台持续记录 GPS，所以需要做成手机原生 App。
> iPhone 装自己做的 App 需要 Apple 开发者账号（99 美元/年）；安卓可直接安装 APK。

## 7. 项目目录
```
Route/
├── app/                      # 页面（Expo Router）
│   ├── (tabs)/index.tsx      # 首页
│   ├── (tabs)/trips.tsx      # 行程列表
│   ├── (tabs)/reports.tsx    # 报表
│   ├── (tabs)/settings.tsx   # 设置
│   ├── trip/[id].tsx         # 行程详情
│   ├── trip/new.tsx          # 手动补录
│   └── recording.tsx         # 记录中
├── src/
│   ├── db/                   # 数据库表结构、读写
│   ├── tracking/             # 后台定位任务、过滤、里程计算
│   ├── services/google/      # Geocoding、Places、Routes、Roads 调用封装
│   ├── reports/              # CSV / Excel / PDF 生成
│   ├── components/           # 地图、行程卡片等组件
│   └── utils/                # 单位换算、费率计算、日期/税年
└── PLAN.md
```

## 8. 开发阶段
**第 1 阶段（MVP，能用来报销）**
- GPS 开始/结束记录 + 后台定位
- 行程保存、列表、详情地图
- 填事由、公务/私人分类
- 月度汇总 + CSV 导出

**第 2 阶段（好用）**
- 手动补录 + 自动算路线
- 常用地点识别
- PDF 报表（含路线图）、Excel 导出
- 费率与税年累计计算

**第 3 阶段（省心）**
- 自动检测开车（连上车载蓝牙或检测到车速自动开始）
- 云端备份同步
- 报销状态跟踪（已提交 / 已到账）

## 9. 待确认
- [ ] 手机是 iPhone 还是安卓？
- [ ] 公司报销表有固定格式吗？（有样表最好）
- [ ] 公司按 HMRC 费率报，还是有自己的费率？
- [ ] 只自己用，还是以后可能给同事用？
- [ ] 申请 Google Maps Platform API Key
