# 任务：沙盘地形接真 DEM — 基于风机坐标自动选取范围渲染真实 3D 地形

项目根 = 当前目录（git repo）。先读 `PRD.md`、`TASK-SANDBOX.md`、
`docs/README-MapStage.md`（DEM 技术路线）和现有代码再动工。
当前状态：`frontend/src/sandbox/terrain.ts` 是程序化噪声地形 + 写死的
`TURBINE_XZ` 风机点位；`SandboxScene.tsx` / `SandboxView.tsx` 渲染沙盘大屏。
本次要把"假山"换成"真地形"。

## 目标
用户在沙盘页选择某个风场（数据来自 `/api/turbines` / `/api/wind-farms`，
字段含 lat/lng）后：
1. 以该风场机群包围盒为中心，自动计算范围（含 margin，约 4-8 km 边长），
   拉取覆盖该范围的真实 DEM 高程数据，渲染成三维地形。
2. 每台风机按真实 lat/lng 等比投影到地形表面对应位置（Web Mercator 线性映射
   到场景 XZ 平面即可，风场尺度下曲率可忽略），贴地放置（y = terrainHeight）。
3. 地形配色保持现有沙盘风格（分层绿色色带 + 森林噪点 + 斜切底座），
   底座裙边沿 DEM 范围矩形切出。
4. 相机自动 fit 到机群范围（overview 视角初始帧框住全部风机）。

## DEM 技术路线（参考 MapStage，README 在 docs/）
- 用 **Mapterhorn** DEM，terrarium 编码（RGB→elevation = R*256 + G + B/256 - 32768）。
  瓦片 URL 参考格式 `https://elevation-tiles-prod.mapterhorn.com/terrarium/{z}/{x}/{y}.png`
  ——**动手前先验证 URL 可用**：curl 一张瓦片确认 200 且是 PNG。若该域名
  不可用/403，换 AWS terrain tiles
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
  或其他公开 terrarium DEM 源，URL 收敛到 `frontend/src/sandbox/demSource.ts`
  一个文件里（常量 + 可被 env/常量覆盖），不要散落。
- 层级选择：风场范围 4-8 km 对应 z≈13-14（每瓦片约 4.9km/z12, 2.4km/z13），
  按 bounds 计算 (z, 瓦片矩阵)，拉 3x3 ~ 5x5 张，在 canvas 上拼接解码成
  Float32 高度网格（如 256x256 或 512x512），再喂给现有地形构建管线。
- 拉取放在**前端**直接 fetch（Mapterhorn/AWS 均开 CORS；若实测发现 CORS 拦，
  改走后端新增 `/api/terrain-tile/{z}/{x}/{y}` 透明代理 + 缓存到内存/磁盘，
  后端改动只允许新增接口）。
- 失败兜底：DEM 拉取失败（离线/CORS/超时 10s）→ 回退现有程序化噪声地形 +
  toast 提示"实时高程不可用，已切换程序地形"，风机仍按真实坐标投影摆位。
- 水平比例：场景 XZ 平面 1 单位 ≈ 30 m（保持现有 TERRAIN_SIZE 量级），
  高度夸张系数做成常量（默认 1.0 真实比例，山体不够震撼可调 1.5-2x）。
- 卫星影像贴图（可选加分项，时间不够就跳过）：EOX Sentinel-2 瓦片做地表
  纹理叠在色带之上（透明度可调）；同样先 curl 验证 URL。

## 现有代码接线点
- `frontend/src/sandbox/terrain.ts`：保留 `terrainHeight(x,z)` 接口不变
  （其他模块靠它贴地），内部实现换成"采样 DEM 高度网格双线性插值"，
  兜底模式才是原噪声函数。
- `TURBINE_XZ` 写死数组删除，改为运行时从风场机组真实坐标计算（见上）。
- `SandboxView.tsx` 风场选择器：现在 `turbines.slice(0, 12)` 取前 12 台展示。
  改为：顶部加风场下拉（来自 /api/wind-farms 或从 turbines 聚合
  wind_farm_id），切换风场 → DEM 重拉 + 风机重摆 + 相机 refit。
- 展示机组数：不再写死 12 台，选中风场的全部机组（霍林河/呼浩特风场约
  10-30 台均可），状态矩阵/柱状图/遥测面板尺寸自适应。
- loading 状态：DEM 拉取期间沙盘中央显示进度态（"正在加载高程数据…"）。

## 约束
- three ^0.178 / pmtiles ^4.3 已在 package.json，优先用现有依赖，不新增重量级依赖。
- 后端不破坏既有 /api 契约；vendor-neutral 不写死供应商名（公共瓦片源 URL 除外）。
- 每完成一个阶段 git commit。

## 自测（必须，不要停在理论上能跑）
1. 后端 8000 / 前端 5173 起服务，curl `/api/turbines` 200。
2. 先 curl 验证 DEM 瓦片 URL 可用（200 + PNG），把验证命令写进 README。
3. `npm run build` 通过。
4. headless Chrome 截图（命令见 TASK-SANDBOX.md §自测）确认：
   - 地形有真实山脊走向（不再是纯对称噪声山）；
   - 风机落在山脊/坡面上且随所选风场坐标分布（换风场后点位明显变化）；
   - 无 CORS/控制台致命错误（截图前用 --dump-dom 或日志确认无 red error）。
5. 离线兜底路径：临时把 DEM 域名改成不可达，确认回退程序地形不白屏。
