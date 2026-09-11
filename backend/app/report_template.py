import json
from datetime import datetime
from pathlib import Path


def _svg_bar(values, labels, color):
    if not values:
        return '<div class="fallback">暂无图表数据</div>'
    max_value = max(values) or 1
    bars = []
    width_slot = 720 / max(len(values), 1)
    for i, value in enumerate(values):
        width = max(12, width_slot - 18)
        height = max(3, int(value / max_value * 180))
        x = 70 + i * width_slot
        center = x + width / 2
        bars.append(f'<rect x="{x:.0f}" y="{235-height}" width="{width:.0f}" height="{height}" rx="5" fill="{color}"/>')
        bars.append(f'<text x="{center:.0f}" y="258" text-anchor="middle" class="axis">{labels[i]}</text>')
        bars.append(f'<text x="{center:.0f}" y="{228-height}" text-anchor="middle" class="value">{value:.0f}</text>')
    return f'<svg viewBox="0 0 800 270" role="img">{"".join(bars)}</svg>'


def render_report_html(title, question, context, sections, source):
    asset = Path(__file__).parent / "assets" / "echarts.min.js"
    runtime_js = asset.read_text(encoding="utf-8") if asset.exists() else ""
    cards = []
    initializers = []
    for index, section in enumerate(sections):
        chart_id = f"chart-{index}"
        spec = section["chart_spec"]
        if runtime_js:
            chart_html = f'<div id="{chart_id}" class="chart"></div>'
            initializer = 'echarts.init(document.getElementById("' + chart_id + '"), "dark").setOption(' + json.dumps(spec, ensure_ascii=False, separators=(",", ":")) + ');'
            initializers.append(initializer)
        else:
            series = spec.get("series", [{}])[0].get("data", [])
            values = [item if isinstance(item, (int, float)) else item.get("value", 0) for item in series]
            labels = spec.get("xAxis", {}).get("data", [])
            chart_html = '<div class="chart fallback">' + _svg_bar(values, labels, "#38bdf8") + "</div>"
        cards.append('<section class="report-card"><h2>' + section["title"] + "</h2><p>" + section["narrative"] + "</p>" + chart_html + "</section>")
    demand = context.get("demand", [])
    capacity = context.get("capacity", [])
    gap = sum(c - d for d, c in zip(demand, capacity))
    status = context.get("turbine_status", {})
    runtime = ""
    if runtime_js:
        runtime = "<script>" + runtime_js + "</script><script>" + "".join(initializers) + "</script>"
    return """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>""" + title + """</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{color-scheme:dark;--bg:#040b18;--panel:#071120;--line:rgba(56,189,248,.22);--text:#dbeafe;--muted:#94a3b8}
body{margin:0;background:radial-gradient(circle at 85% 0,#0b324d 0,transparent 32%),var(--bg);color:var(--text);font:15px/1.65 Avenir Next,"PingFang SC","Microsoft YaHei",sans-serif}
header{padding:54px 7vw 34px;border-bottom:1px solid var(--line);background:linear-gradient(90deg,rgba(4,11,24,.9),transparent)}
h1{font-size:38px;margin:0 0 12px;letter-spacing:.5px} h2{font-size:20px;color:#7dd3fc;margin:0 0 14px}
header p{color:var(--muted);margin:5px 0} main{padding:28px 7vw 60px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px}
.kpis{grid-column:1/-1;display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.kpi{border:1px solid var(--line);background:linear-gradient(145deg,rgba(7,17,32,.96),rgba(4,11,24,.72));padding:22px;border-radius:12px}
.kpi b{display:block;font-size:28px;color:#fff} .report-card{border:1px solid var(--line);background:var(--panel);padding:24px;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.25)}
.chart,.fallback{height:320px;margin-top:12px} .axis{fill:#94a3b8;font-size:11px} .value{fill:#e0f2fe;font-size:10px}
footer{padding:20px 7vw;color:#64748b;border-top:1px solid var(--line)}
@media print{body{background:white;color:#111}header,main{padding-left:0;padding-right:0}.report-card{break-inside:avoid;border-color:#ddd;background:white;box-shadow:none}.kpi,.chart,.fallback{color:#111}.axis{fill:#666}.value{fill:#111}}
@media(max-width:900px){main{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(2,1fr)}}
</style></head><body><header><div>WIND TWIN · """ + source.upper() + """ REPORT</div><h1>""" + title + """</h1>
<p>分析问题：""" + question + """</p><p>生成时间：""" + datetime.now().strftime("%Y-%m-%d %H:%M") + """</p></header>
<main><div class="kpis">
<div class="kpi"><span>项目容量</span><b>""" + f"{context.get('project_capacity', 0):,}" + """ MW</b></div>
<div class="kpi"><span>运行风机</span><b>""" + str(status.get("running", 0)) + """</b></div>
<div class="kpi"><span>当前功率</span><b>""" + str(context.get("current_power_mw", 0)) + """ MW</b></div>
<div class="kpi"><span>供给缺口</span><b>""" + f"{gap:.0f}" + """ MW</b></div>
</div>""" + "".join(cards) + """</main><footer>本报告由业务数据与规划结果生成；图表可直接在浏览器打印导出 PDF。</footer>""" + runtime + "</body></html>"
