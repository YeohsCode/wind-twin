import json
import re
from datetime import datetime
from pathlib import Path
import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session
from .config import get_settings
from .report_template import render_report_html
from .models import *


REGION_WORDS = {
    "内蒙古": "inner-mongolia", "内蒙": "inner-mongolia",
    "河北": "hebei", "山西": "shanxi", "华北": "north-china",
}
STATUS_WORDS = {"在建": "construction", "核准": "approved", "储备": "reserve"}


def _status_counts(db: Session, period: str | None = "2027-Q3"):
    q = db.query(OperationData)
    if period:
        q = q.filter(OperationData.period == period)
    rows = q.all()
    counts = {"running": 0, "warning": 0, "fault": 0}
    power = sum(x.power_kw for x in rows)
    for row in rows:
        counts[row.status] = counts.get(row.status, 0) + 1
    return counts, power


def _projection_context(db: Session):
    demands = db.query(Demand).filter(Demand.region_id == "north-china").order_by(Demand.year).all()
    capacities = db.query(ProductionCapacity).all()
    years = sorted({x.year for x in demands})
    cap_by_year = {}
    for cap in capacities:
        year = int(cap.period[:4])
        cap_by_year[year] = cap_by_year.get(year, 0) + cap.available_mw
    return {
        "years": years,
        "demand": [next((x.demand_mw for x in demands if x.year == y), 0) for y in years],
        "capacity": [round(cap_by_year.get(y, 0), 1) for y in years],
        "project_count": db.query(Project).count(),
        "project_capacity": db.query(Project.capacity_mw).all() and sum(x[0] for x in db.query(Project.capacity_mw).all()),
    }


def rule_actions(question: str, db: Session) -> tuple[list[dict], dict, str]:
    actions: list[dict] = []
    filters: dict = {}
    focus = None
    for word, rid in REGION_WORDS.items():
        if word in question:
            if rid != "north-china":
                filters["regionId"] = rid
            focus = rid
            actions.append({"type": "FOCUS_REGION", "payload": {"regionId": rid}})
            break
    capacity = re.search(r"(?:容量|规模)[^\d]{0,8}(\d{3,4})\s*mw", question, re.I)
    if capacity:
        filters["minCapacity"] = int(capacity.group(1))
    elif "500MW" in question.upper():
        filters["minCapacity"] = 500
    for word, status in STATUS_WORDS.items():
        if word in question:
            filters["status"] = status
            break
    if "故障" in question or "告警" in question or "异常" in question:
        filters["onlyAlert"] = True
        actions.append({"type": "HIGHLIGHT_ALERTS", "payload": {"enabled": True}})
    if "方案" in question and ("A" in question or "B" in question or "C" in question):
        plans = sorted({x for x in ("A", "B", "C") if x in question})
        actions.append({"type": "COMPARE_PLANS", "payload": {"plans": plans}})
    if "图层" in question:
        actions.append({"type": "SHOW_LAYERS", "payload": {"layers": ["regions", "windFarms", "projects", "routes"]}})
    if filters:
        actions.insert(0, {"type": "SET_FILTER", "payload": filters})
    if not actions:
        actions.append({"type": "SHOW_LAYERS", "payload": {"layers": ["regions", "windFarms", "projects", "factories", "routes"]}})
    counts, power = _status_counts(db)
    context = {
        **_projection_context(db),
        "turbine_status": counts,
        "current_power_mw": round(power / 1000, 1),
    }
    narrative = []
    if filters:
        narrative.append("已在 3D 场景应用筛选：" + "、".join(f"{k}={v}" for k, v in filters.items()))
    narrative.append(f"当前风机运行 {counts.get('running', 0)} 台、预警 {counts.get('warning', 0)} 台、故障 {counts.get('fault', 0)} 台。")
    if context["years"]:
        gap = [c - d for d, c in zip(context["demand"], context["capacity"])]
        narrative.append(f"{context['years'][0]}—{context['years'][-1]}年供给减需求合计约 {sum(gap):.0f} MW。")
    return actions, context, " ".join(narrative)


async def call_llm(question: str, context: dict) -> tuple[str, list[dict]]:
    settings = get_settings()
    if not settings.llm_ready:
        return "", []
    system = (
        "你是风电数字孪生分析助手。只依据给定数据回答，不编造数字。"
        "返回严格 JSON：{\"answer\":\"中文分析\",\"actions\":[{\"type\":\"SET_FILTER|SHOW_LAYERS|FOCUS_REGION|HIGHLIGHT_ALERTS|COMPARE_PLANS\",\"payload\":{}}]}"
    )
    body = {
        "model": settings.llm_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps({"question": question, "context": context}, ensure_ascii=False)},
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }
    headers = {"Authorization": f"Bearer {settings.llm_api_key}", "Content-Type": "application/json"}
    url = settings.llm_base_url.rstrip("/") + "/chat/completions"
    async with httpx.AsyncClient(timeout=settings.llm_timeout_seconds) as client:
        response = await client.post(url, json=body, headers=headers)
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    return parsed.get("answer", ""), parsed.get("actions", [])


def chart_specs(db: Session, question: str):
    counts, _ = _status_counts(db)
    context = _projection_context(db)
    options = {
        "supplyDemand": {
            "title": {"text": "需求与产能匹配", "textStyle": {"color": "#dbeafe"}},
            "tooltip": {"trigger": "axis"},
            "legend": {"textStyle": {"color": "#94a3b8"}},
            "xAxis": {"type": "category", "data": context["years"]},
            "yAxis": {"type": "value", "name": "MW"},
            "series": [
                {"name": "需求", "type": "bar", "data": context["demand"], "itemStyle": {"color": "#38bdf8"}},
                {"name": "产能", "type": "bar", "data": context["capacity"], "itemStyle": {"color": "#22d3ee"}},
            ],
        },
        "turbineStatus": {
            "title": {"text": "风机状态", "textStyle": {"color": "#dbeafe"}},
            "tooltip": {},
            "xAxis": {"type": "category", "data": ["运行", "预警", "故障"]},
            "yAxis": {"type": "value"},
            "series": [{"type": "bar", "data": [
                {"value": counts["running"], "itemStyle": {"color": "#22c55e"}},
                {"value": counts["warning"], "itemStyle": {"color": "#f59e0b"}},
                {"value": counts["fault"], "itemStyle": {"color": "#ef4444"}},
            ]}],
        },
    }
    selected = ["supplyDemand"]
    if "故障" in question or "运营" in question or "风机" in question:
        selected.insert(0, "turbineStatus")
    return [{"key": key, "option": options[key]} for key in selected]


def _svg_bar(values: list[float], labels: list[str], color: str) -> str:
    if not values:
        return ""
    max_v = max(values) or 1
    bars = []
    for i, value in enumerate(values):
        width = 720 / max(len(values), 1) - 18
        height = max(3, int(value / max_v * 180))
        x = 70 + i * (720 / max(len(values), 1))
        bars.append(f'<rect x="{x:.0f}" y="{235-height}" width="{width:.0f}" height="{height}" rx="5" fill="{color}"/>')
        bars.append(f'<text x="{x + width / 2:.0f}" y="258" text-anchor="middle" class="axis">{labels[i]}</text>')
        bars.append(f'<text x="{x + width / 2:.0f}" y="{228-height}" text-anchor="middle" class="value">{value:.0f}</text>')
    return f'<svg viewBox="0 0 800 270" role="img">{" ".join(bars)}</svg>'



async def generate_report(db: Session, payload) -> Report:
    actions, context, rule_answer = rule_actions(payload.question, db)
    llm_answer, _ = await call_llm(payload.question, context)
    planning_note = ""
    scenario = None
    if payload.scenario_id:
        scenario = db.get(Scenario, payload.scenario_id)
        if scenario:
            from .planning import run_planning
            plans = run_planning(db, scenario)
            best = min(plans, key=lambda x: x["score"])
            context["scenario"] = {"name": scenario.name, "demand_mw": scenario.demand_mw}
            context["plans"] = [{k: v for k, v in p.items() if k != "allocations"} for p in plans]
            planning_note = (f"方案 {best['plan_key']} 综合得分 {best['score']:.3f}，"
                             f"分配 {best['metrics']['allocated_mw']:.0f} MW，平均运距 {best['metrics']['avg_distance_km']:.0f} km。")
    narrative = llm_answer or rule_answer
    sections = [
        {"title": "总体判断", "narrative": narrative + (" " + planning_note if planning_note else ""),
         "chart_spec": {"backgroundColor": "transparent", "xAxis": {"type": "category", "data": context["years"]},
                        "yAxis": {"type": "value"}, "series": [{"type": "bar", "data": context["demand"]}]}},
        {"title": "需求与产能", "narrative": "按年聚合区域需求与可用产能，用于识别结构性缺口。",
         "chart_spec": {"backgroundColor": "transparent", "tooltip": {"trigger": "axis"},
                        "xAxis": {"type": "category", "data": context["years"]}, "yAxis": {"type": "value"},
                        "series": [{"name": "需求", "type": "bar", "data": context["demand"]},
                                   {"name": "产能", "type": "bar", "data": context["capacity"]}]}},
    ]
    html = render_report_html(payload.title, payload.question, context, sections, "rule" if not llm_answer else "llm")
    report = Report(title=payload.title, report_type=payload.report_type, question=payload.question,
                    content={"sections": sections, "context": context}, html=html,
                    source="llm" if llm_answer else "rule")
    db.add(report)
    db.commit()
    db.refresh(report)
    return report
