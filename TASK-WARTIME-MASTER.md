# Wind-Twin 战区推演 · 总体功能清单与顺序 Plan

> 依据：PRD.md + 现状（HEAD fbcb767：GIS 下钻/中国地图、3D 沙盘 DEM、period 时间轴、路线动画、风机 history）。
> Codex 按下方 Plan 顺序执行，每个 Plan 一个 TASK-WT-P*.md，完成后 build + 自测 + commit，再进下一个。

---

## 总体功能清单（目标态）

### A. 实体与协议层
- [x] A1 实体类型体系：塔筒运输队 / 吊装机 / 零部件生产设备（塔段·机舱·叶片）/ 储能单元 / 输电线路 / 风场机位
- [x] A2 统一实体协议：`{id, type, position, target_id, progress, status, payload}`，后端唯一真源
- [x] A3 `simulation_entities` 表 + `/api/simulation/entities`（读写）
- [x] A4 `/api/simulation/tick`：推进仿真一步（时间参数化，小时级步长）

### B. 仿真内核（规则驱动，确定性可重放）
- [x] B1 生产：工厂设备按速率产出塔段/机舱/叶片 → 工厂库存
- [x] B2 运输：库存 >= 套件 → 运输队出发，沿运输路线移动（复用现有 routes 数据），按距离计耗时
- [x] B3 吊装：运输队到达机位 → 吊装机就位 → 吊装进度环（塔筒→机舱→叶片三阶段）
- [x] B4 发电：吊装完成机组并入风场，按 period/风速生成出力（复用 operation 数据）
- [x] B5 储能：风场 surplus 充电、低谷放电，SOC 状态可视化
- [x] B6 电价：供需差驱动的小时级电价曲线（确定性公式，不接外部行情）
- [x] B7 输电：线路潮流 = 沿线风场出力 + 储能放 - 负荷，粗细/颜色映射

### C. 前端表现（GIS 中国地图层级为主）
- [x] C1 实体图标层：六类实体用可区分图标 + 状态着色（借鉴 milsymbol 符号思路）
- [x] C2 运输动画：车队沿路线移动（复用流动虚线引擎，改为可跟随实体）
- [x] C3 吊装动画：机位进度环 + 3D 沙盘侧塔筒升起（若成本低则做，高则 GIS 优先）
- [x] C4 电力流动画：输电线流动粗细随潮流实时变
- [x] C5 电价条带：底部小时级电价曲线，与时间轴联动
- [x] C6 储能面板：SOC 液柱 + 充放箭头
- [x] C7 实体详情卡：点击实体 → 侧栏显示 payload/进度/归属

### D. 推演控制
- [x] D1 播放/暂停/倍速（1x/10x/100x）/跳转到时刻
- [x] D2 场景预设：如"纳雍示范场全链路 72 小时推演"
- [x] D3 干预动作：暂停某工厂/加速某运输队（改实体 payload 即生效）
- [x] D4 推演回放：任意时刻快照可回看（实体状态全量可从 tick 重算）

### E. 明确不进本期（后续迭代）
- Pandapower 真潮流 / RL agent 调度对战（Panopticon 式）/ WebSocket 实时推送 / 多人对战

---

## 顺序 Plan（codex 依次执行）

### Plan 1 — 实体协议 + 仿真内核骨架（A1-A4, B1-B4）
- 建表/接口/tick 推进逻辑，规则仿真跑通"生产→运输→吊装→并网发电"闭环
- 自测：curl 全接口 200，tick 推进后实体状态/progress 断言，单测或脚本验证闭环到达
- commit: `3b55226` · `feat(wt-plan1): simulation entity protocol + rule-based kernel`

### Plan 2 — 储能 + 电价 + 输电（B5-B7）
- SOC/充放/电价曲线/线路潮流并入 tick；输出小时级时间序列接口
- 自测：72 小时推演序列 curl 校验数值边界（SOC 0-1、电价非负、潮流守恒粗检）
- commit: `2b71543` · `feat(wt-plan2): storage, price, power-flow in kernel`

### Plan 3 — GIS 地图实体动画（C1, C2, C4, C5, C7）
- 中国地图层级：实体图标、车队移动、电力流动、电价条带、详情卡
- 自测：build + CDP 截图验证实体出现在地图且随 tick 移动
- commit: `1b57b7b` · `feat(wt-plan3): map entity animation layer`

### Plan 4 — 推演控制 + 3D 沙盘联动（D1-D4, C3, C6）
- 播放控制条、场景预设、干预动作、储能面板、沙盘塔筒升起动画
- 自测：倍速/跳转后实体一致；CDP 截图沙盘吊装进度
- commit: `8b7cd33` · `feat(wt-plan4): replay controls + sandbox linkage`

### Plan 5 — 场景打磨 + 文档
- 纳雍 72 小时默认推演剧本、README 验证命令、TASK-COMPLETION 补对照
- commit: 本次 `docs(wt-plan5): scenario + docs`（以 HEAD 为准）
- 收口：默认纳雍 72h、GIS 战区视角/图层、3D DEM-ready 门控与推演 HUD 布局
- 验证：`python3 -m unittest discover -s tests -v`、`npm --prefix frontend run build`、
  TestClient 72h 纳雍并网断言、GIS + 3D CDP 截图
