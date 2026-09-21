# Wind Twin · 风场数字孪生 3D 沙盘

一个以真实地理空间为入口的风电规划数字孪生原型：MapLibre 3D 地形沙盘 + 后端数据驱动的风场运营断面 + 确定性产能规划 + 自然语言场景操作 + 自包含 HTML 报告。

## 功能概览

### 3D 数字孪生
- `/` 默认进入程序化 three.js 地形沙盘：ridged/value noise 山体、等高色带、instanced 森林、
  斜切沙盘底座、道路/输电线/升压站和 12 台可点击风机。
- `/gis` 保留原 MapLibre 卫星影像与规划视图，通过顶部 tab 往返切换。
- EOX Sentinel-2 卫星底图、Mapterhorn Terrarium DEM、hillshade 与 3D terrain。
- OpenFreeMap / OSM 矢量水系与行政边界；内置华北行政区、风场边界、升压站。
- 144 台确定性种子风机，Three.js MapLibre custom layer 渲染塔筒与旋转叶片。
- 164 台后端种子风机（8 个华北风场 + 纳雍 20 台 100.56 MW 示范机群）。
- 2025Q1—2029Q4 顶部时间轴同时驱动沙盘状态、功率、遥测与图表。
- 状态视觉：运行偏蓝绿、预警橙色、故障红色高亮；后端功率驱动发光强度。
- 项目容量 3D 柱体、工厂/升压站点位、物流路线、告警圈。
- 省级容量热力、计划路线流动动画、图层开关、区域聚焦、风机/项目详情弹窗。
- 风机详情包含周期遥测、功率曲线和未消除告警。

### 规划沙盘
- 创建 Scenario：区域、周期、需求、目标。
- 确定性启发式分配器同时生成 Plan A / B / C：
  - A：产能均衡
  - B：物流成本优先
  - C：交付风险优先
- 输出分配、产能利用率、缺口、平均运距、物流成本指数、风险与交付周期。
- 方案切换会同步项目柱体颜色与物流路线显示。

### AI 与报告
- 后端规则引擎先完成意图识别、业务数据聚合、图表与 3D scene action 生成。
- 支持配置通用 LLM（标准 chat completion JSON 协议）增强叙述与 action；LLM 未配置或失败时自动规则兜底。
- 自然语言示例：
  - “只显示容量超过500MW的内蒙古储备项目”
  - “显示故障风机”
  - “比较方案A和方案B”
- 报告接口返回结构化 section / ECharts option，并渲染内嵌 ECharts runtime 的自包含 HTML；浏览器打印即可导出 PDF。

## 目录

```text
backend/    FastAPI + SQLAlchemy + SQLite + seed + planning + AI/report
frontend/   React 18 + Vite + TypeScript + MapLibre GL JS + Three.js + ECharts
docs/       PRD 与参考资料
```

## 快速启动

### 1. 后端

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

首次启动会自动创建 SQLite 数据库并写入确定性示例数据。启动时也会自动修复旧库中
纳雍机群缺失的 T20 及其运行断面。数据库文件：

```text
backend/data/wind_twin.db
```

如需强制重建种子数据：

```bash
cd backend
source .venv/bin/activate
python -c 'from app.seed import run_seed; print(run_seed(True))'
```

API docs: <http://127.0.0.1:8000/docs>

### 2. 前端

```bash
cd frontend
npm install
npm run dev
```

打开：<http://127.0.0.1:5173>

Vite dev server 已代理 `/api` 到 `127.0.0.1:8000`。

## LLM 环境变量

复制 `backend/.env.example` 后按需填写。未填写时系统自动走规则引擎。

```env
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
LLM_TIMEOUT_SECONDS=20
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

`LLM_BASE_URL` 需兼容标准 chat completion JSON 请求/响应结构；代码不绑定任何模型或供应商。

## 验证命令

### 前端构建

```bash
npm --prefix frontend run build
```

### 时间轴与风机详情

沙盘页拖动右上角时间轴后，接口、状态矩阵、KPI 和功率图应切换到同一周期；
GIS 页风机弹窗应包含 20 个季度功率点。核心接口：

```bash
curl -fsS 'http://127.0.0.1:8000/api/turbines?period=2026-Q2&wind_farm_id=wf-nayong' | python3 -m json.tool | head
curl -fsS http://127.0.0.1:8000/api/turbines/wf-nayong-T20/history | python3 -m json.tool | head
```

### 3D 沙盘视觉冒烟

后端与前端 dev server 运行后，用 software WebGL 截图确认首屏不是黑屏或平面地图：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --use-gl=swiftshader --enable-unsafe-swiftshader \
  --screenshot=/tmp/sb.png --window-size=1600,900 --timeout=15000 \
  http://127.0.0.1:5173/
```

本仓库实测截图已包含 terrain、instanced 森林、风机、WT 标签、工具条和完整仪表盘布局。

### 真实 DEM / 地形沙盘

沙盘页现在支持按风场切换。前端用风机 Web-Mercator 包围盒选择 terrarium DEM
瓦片矩阵，拼接后解码为 Float32 高度网格，再按 `1 scene unit ≈ 30 m`
投影到 XZ；风机坐标使用同一投影并贴地。当前风场种子数据的机群实际跨度
约 30-45 km，因此加载器会自动扩展到约 50 km 方形范围并选择 z11；
小于 8 km 的机群会自动选择 z13-z14。

公共 terrarium 瓦片源顺序为：Mapterhorn，然后 AWS Open Terrain Tiles。
若主源不可用，单张瓦片会自动落到 fallback。可用下面的命令验证 200 和 PNG：

```bash
# 当前环境实测可用的 fallback source（HTTP 200, image/png）
curl -L -sS -o /tmp/terrain-tile.png -w '%{http_code} %{content_type}\n' \
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/13/6710/3104.png'
file /tmp/terrain-tile.png

# Mapterhorn 参考源；本仓库当前网络返回 SSL/connection error 时自动用 fallback
curl -L -sS -o /tmp/terrain-tile.png -w '%{http_code} %{content_type}\n' \
  'https://elevation-tiles-prod.mapterhorn.com/terrarium/13/6710/3104.png'
file /tmp/terrain-tile.png
```

可用 `frontend/.env.local` 覆盖公共源：

```env
VITE_DEM_TILE_URL_TEMPLATE=https://your.example/terrarium/{z}/{x}/{y}.png
```

离线兜底：临时启动前端
`VITE_DEM_TILE_URL_TEMPLATE='https://127.0.0.1:9/{z}/{x}/{y}.png' npx vite --port 5174`。
等待约 10 秒后应出现“实时高程不可用，已切换程序地形”，左上角显示
`PROCEDURAL FALLBACK`，页面不白屏且风机仍按真实坐标投影。

### 后端核心 API 冒烟

后端运行后执行：

```bash
curl -fsS http://127.0.0.1:8000/api/health
curl -fsS http://127.0.0.1:8000/api/overview

curl -fsS 'http://127.0.0.1:8000/api/turbines?period=2027-Q3' | python3 -m json.tool | head

curl -fsS -X POST http://127.0.0.1:8000/api/scenarios \
  -H 'content-type: application/json' \
  -d '{"name":"华北2027-2029","region_id":"north-china","start_year":2027,"end_year":2029,"demand_mw":1200,"objective":"balanced"}'

# 用上一条返回的 id 替换 {scenario_id}
curl -fsS -X POST http://127.0.0.1:8000/api/scenarios/{scenario_id}/plan

curl -fsS -X POST http://127.0.0.1:8000/api/ai/command \
  -H 'content-type: application/json' \
  -d '{"question":"只显示容量超过500MW的内蒙古储备项目"}'

curl -fsS -X POST http://127.0.0.1:8000/api/reports \
  -H 'content-type: application/json' \
  -d '{"question":"分析华北未来三年风电项目需求和产能匹配情况"}'
```

已在本仓库当前环境实测通过：

- `/api/overview`：164 台风机。
- `/api/turbines?period=2027-Q3`：164 台，且包含运行断面数据。
- `/api/turbines/wf-nayong-T20/history`：返回 20 个季度断面和告警。
- scenario + planning：返回 Plan A / B / C。
- AI command：返回 `SET_FILTER` / `FOCUS_REGION` action 与图表 option。
- report HTML：约 1.1 MB 自包含文件，内嵌 ECharts runtime。
- `npm --prefix frontend run build`：通过。

## 核心接口

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/overview` | 总览 KPI |
| GET | `/api/regions` | 行政/业务区域 |
| GET | `/api/wind-farms` | 风场与统计 |
| GET | `/api/turbines?period=2027-Q3` | 风机 + 运行数据 |
| GET | `/api/turbines/{id}/history` | 风机周期遥测与告警 |
| GET | `/api/projects` | 项目 |
| GET | `/api/transport-routes` | 物流路线 |
| POST | `/api/scenarios` | 创建 Scenario |
| POST | `/api/scenarios/{id}/plan` | 生成 Plan A/B/C |
| GET | `/api/scenarios/{id}/plans` | 方案结果 |
| POST | `/api/ai/command` | 自然语言 → answer/actions/charts |
| POST | `/api/reports` | 生成报告 |
| GET | `/api/reports/{id}/html` | 自包含 HTML 报告 |

## 地图与数据来源

- 卫星底图：EOX Sentinel-2 cloudless public WMTS。
- DEM / hillshade / terrain：Mapterhorn，Terrarium encoding。
- 水系与行政矢量：OpenFreeMap / OpenMapTiles / OpenStreetMap。
- 业务数据：内置确定性示例 seed，坐标集中在内蒙古、河北、山西等华北区域。

运行时会访问上述公共瓦片源；商用部署前请确认各数据源授权与配额。

## 当前版本边界

- 使用 SQLite 与 lat/lng 字段，模型已预留后续迁移 PostGIS 的空间字段空间。
- 报告 HTML / 打印 PDF 已可用；PPTX 导出为后续扩展接口。
- 行政/风场边界使用确定性示意多边形，生产环境应替换为正式 GIS 数据。
