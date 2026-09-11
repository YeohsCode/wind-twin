# PPT Master 报告实现思路（摘要）

来源: github.com/macrochen/ppt-master-skill (基于 macrochen/ppt-master 工作流)。
核心思想: 把报告当**设计项目**做，而不是纯文本转 PPT。

## 工作流要点（供本系统报告模块借鉴）
1. **Strategist / Executor 两段式**: Strategist 先做内容规划（受众、叙事结构、每页信息密度、图表选型），Executor 再逐页产出版式。对应本系统: AI 报告先由 LLM 产出"报告大纲 + 每节图表类型/数据源"的结构化 JSON，再由模板引擎渲染。
2. **版式先行**: 每页有固定版式栅格（16:9、标题区/图区/注释区分离），视觉统一。对应本系统: HTML 报告用统一版式系统（深色主题、章节封面页 + 内容页 + 数据页 + 结论页）。
3. **SVG/矢量中间产物**: PPT Master 用 SVG 做中间产物保证可编辑与高清导出。本系统对应: 报告内嵌 ECharts（矢量，打印/导出 PDF 不糊）。
4. **多输出格式**: 最终可导出 .pptx / HTML / 图片。本系统按 PRD §4 要求: HTML（自包含单文件，内嵌数据与图表 JS）/ 打印为 PDF（@media print 样式 + page-break 控制）/ 预留 PPTX 导出接口。

## 本系统报告模块落地方案
- 报告 = 结构化 JSON（sections[]，每节: title / narrative / chart_spec(ECharts option) / table_data）
- 渲染器把 JSON → 自包含 HTML（内联 echarts.min.js + 数据 + 版式 CSS），深色/浅色双主题
- 报告类型枚举: 运营分析 / 项目分析 / 区域分析 / 产能规划 / 方案对比 / 风险分析 / 推荐方案（对应 PRD §4）
- LLM 负责叙述文本与"自动选图表"（bar/line/heatmap/map…），确定性数据由后端 SQL 聚合提供，LLM 不得编数
- PPTX 导出: 预留接口，V2 用 pptxgenjs 从同一 JSON 生成
