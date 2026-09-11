# 任务：主视图改造 — three.js 3D 地形沙盘（对齐效果图）

项目根就是当前目录（git repo），先通读 `PRD.md` 和本文件再动工。前端已有
MapLibre + ECharts + three 依赖，后端 FastAPI 已跑通（端口 8000，/api/*）。

## 视觉参考（最重要，已放到 docs/）
- `docs/reference-3d-sandbox.jpg` — **目标效果图，逐块对齐它**。这是一张
  "兰璟能源·山地貌数字孪生中心" 风场 3D 沙盘大屏截图，核心要素：
  1. **中央 3D 地形沙盘**：程序化生成的绿色山体地形（分层等高线/梯田状色带 +
     深色森林斑点纹理），像一块"实体沙盘模型"，边缘有斜切基座（sand-table 底座），
     背景近黑。山脊上立着 12 台白色 3D 风机（塔筒 + 三叶片，部分叶片缓慢旋转），
     每台有标签牌（WT-01…WT-12），山脚有道路/输电线路连到一个小的升压站建筑。
  2. **顶部 KPI 栏**：全场实时功率 24.01 MW、累计发电 304.47 MWh、
     机组可利用率 91.7%、当日等效 167.46 万 + 全局总览 tab（01 全局总览 /
     02 机组监测 / 03 能源分析 / 04 运维中心）。
  3. **左栏**：风场气象卡（风速 9.6 m/s 罗盘 + 温度/湿度/空气密度）+
     场站运行效能卡（36.0 MW 环形图 91.7%、平均叶轮转速 11.8 rpm、
     集电系统效率 97.6%、日计划发电量进度条）。
  4. **右栏**：机组状态矩阵（12 格小方块，运行/预警/故障三色，点击联动）+
     选中机组实时遥测面板（WT-10：风速/转速/功率 2.19 MW + 运行 82% 进度点阵）。
  5. **底部**：出力趋势面积图（24H 预测功率 vs 实际功率，ECharts）+ 
     机舱功率分布柱状图（12 根柱，异常机舱高亮橙色）+ 运行事件列表（预警条目）。
  6. **沙盘下方工具条**：三指/俯视/巡航/旋转/俯仰/夜晚等视角模式按钮 +
     缩放控件 + 指北针 + 比例尺。

## 改造内容
把现有首页（MapLibre 卫星影像大地图）改为**新路由 /sandbox 或首页 tab**，
主视图用 **three.js** 实现上述 3D 沙盘场景；现有 GIS 规划视图保留，
挪到 /gis 或顶部 tab "02/03" 里，两个视图共享同一套后端数据与状态联动。

### three.js 沙盘场景具体要求
- 地形：程序化生成（simplex noise 多倍频叠加 ridged noise 做山脊），分层色带
  （山顶浅草绿→山腰深绿→谷底深色），叠加暗色森林噪点/instanced 小圆锥树，
  侧缘裙边做出沙盘模型底座的斜切面。不依赖外部 DEM 瓦片。
- 风机：程序化建模（圆柱塔筒+轮毂+3 叶片，叶尖细长），叶片动画（运行中缓慢旋转，
  故障停转），数据驱动：功率→塔筒指示灯/标签牌数值，故障→标签红色+机体高亮。
- 标签：CSS2DRenderer 或 sprite 做风机标牌（编号 + 实时 MW），可点击 raycaster
  选中→右栏遥测面板联动。
- 相机：OrbitControls（带阻尼），预设视角按钮：全景/俯视/巡航（自动环绕）/侧视，
  支持日夜切换（夜晚 = 天空盒变暗 + 风机警示灯闪烁）。
- 性能：12 台风机实例 + instanced 树，60fps 不吃力；resize 自适应。

### 数据接线
- 后端 `/api/turbines` 已有 136 台机组（含 status/rated_power_kw/lat/lng 等）。
  沙盘场景选一个风场（如 wf-hohhot）下的 12 台做展示位（山脊排布按样机图的
  WT-01…WT-12 命名），实时功率/转速/状态优先从后端取，没有的字段前端按
  rated power + 状态做确定性伪随机波形（正弦 + 噪声）补充，标注"模拟"。
- KPI 顶部栏、左栏气象/效能、右栏遥测、底部两个图表 + 事件列表，数据一律走
  `/api/overview`、`/api/turbines`、`/api/alerts` 等现有接口（先读
  backend/app/main.py 确认真实路由与字段，不要臆造）。

## 约束
- 技术栈不变：React 18 + Vite + TS + three ^0.178 + ECharts。不要引入
  react-three-fiber（原生 three 即可，避免多余依赖）。
- vendor-neutral：不写死任何供应商/模型名。
- 保持现有 /api 契约不变；后端只允许新增字段/接口，不破坏已有。

## 自测（必须，不要停在理论上能跑）
1. `cd backend && uvicorn app.main:app --port 8000` 起服务，curl
   `/api/overview` `/api/turbines` 确认 200。
2. `cd frontend && npm run build` 通过。
3. `npm run dev` 起前端，用 headless Chrome 截图主视图：
   `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new
   --use-gl=swiftshader --enable-unsafe-swiftshader --screenshot=/tmp/sb.png
   --window-size=1600,900 --virtual-time-budget=20000 http://127.0.0.1:5173/`
   确认画面是 3D 山体+风机（不是黑屏、不是平面地图）。
4. 每完成一个阶段 git commit。
