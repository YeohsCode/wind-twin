# 任务：按 PRD 实现风场数字孪生 3D 沙盘系统（网页版）

项目根就是当前目录（git repo），完整需求见 `PRD.md`，先通读再动工。

## 参考素材（已放到本目录，直接读）
- `docs/PRD.md` — 原始需求文档（根目录 `PRD.md` 同一份）
- `docs/README-MapStage.md` — MapStage (github.com/hopechen067/MapStage, 406⭐, MIT) 的 README。地图/3D 地形技术路线参考它：MapLibre GL JS（globe/map 投影）+ EOX Sentinel-2 卫星底图 + Mapterhorn DEM（Terrarium encoding）做 hillshade/3D terrain + OpenFreeMap 矢量水系。用它的思路做风场底图和 3D 地形，不需要整库照搬。
- `docs/ppt-master-report-approach.md` — PPT Master skill 的实现思路摘要。报告模块参考它：数据驱动 HTML 报告（图表 + 叙述文本 + 一键导出打印为 PDF），后续可扩展 PPTX。

## 技术栈（PRD §6）
- 前端：React 18 + Vite + TypeScript；MapLibre GL JS（地图/3D 地形，参考 MapStage 路线）；ECharts（图表）；Three.js 或 maplibre custom layer 做风机 3D 模型与数据驱动的视觉特效（功率→亮度、故障→红色高亮、容量→柱体高度、区域热力、物流动态路线）。
- 后端：Python FastAPI + SQLAlchemy + SQLite（先不上 PostGIS，用 lat/lng 字段即可，schema 留迁移空间）；内置 mock 数据种子（Region / WindFarm / Turbine / Substation / Factory / Project / ProductionCapacity / Demand / OperationData / Alert / TransportRoute / Scenario / PlanningResult / Report，见 PRD §6）。风场/风机数据放华北（内蒙古、河北等），DEM/底图用公共瓦片源。
- 规划算法：实现一个确定性的启发式分配器（产能均衡/物流成本/交付风险三个目标），输入 Scenario 参数，输出 PlanningResult JSON，支持 Plan A/B/C 多方案对比。
- AI 分析：后端留 `*_BASE_URL + *_API_KEY + *_MODEL` env 配置的 LLM 调用（vendor-neutral，不要写死任何供应商名/模型名），提供规则兜底：LLM 不可用时用模板+规划结果自动生成报告。自然语言→场景操作做一个意图→操作(JSON action)的映射层，前端收到 action 直接改 3D scene（如"只显示容量超过500MW的项目"→过滤）。
- 报告导出：HTML 报告（自包含，内嵌 ECharts 图）+ 浏览器打印导出 PDF；报告模板风格参考 PPT Master 的版式思路。

## 交付要求
1. monorepo：`backend/`（FastAPI，uvicorn 可跑）+ `frontend/`（Vite）。README 写清启动命令和端口。
2. UI 要现代好看：深色科技风仪表盘（可参考 Tesla/能源行业数字孪生大屏风格），侧边图层控制面板、顶部时间轴、风机详情弹窗。整体协调，不是裸 HTML。
3. **必须自测**：后端起服务 curl 实测核心 API（数据、scenario、planning、AI 报告接口）；前端 `npm run build` 通过；写 README 的验证命令。不要停在"理论上能跑"。
4. 每完成一个阶段 git commit。
5. 代码中不要写死任何具体模型名/供应商名，全部走 env 配置。

按 PRD 的 MVP 验收标准（§8）尽量覆盖：3D 地形+行政区+风场边界+100+风机+风机状态/面板+图层控制+时间轴；Scenario 创建→规划→A/B/C 对比→3D 展示；自然语言查询→图表→报告。
