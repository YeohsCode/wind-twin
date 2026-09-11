from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from .config import get_settings
from .database import Base, engine, get_db
from .models import *
from .schemas import ScenarioIn, AICommandIn, ReportIn
from .planning import run_planning
from .seed import run_seed
from .services import rule_actions, call_llm, chart_specs, generate_report

app = FastAPI(title="Wind Energy Planning Digital Twin API", version="0.1.0")
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origin_list or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup():
    Base.metadata.create_all(engine)
    run_seed()


def serialize_model(obj, excludes=()):
    return {c.name: getattr(obj, c.name) for c in obj.__table__.columns if c.name not in excludes}


@app.get("/api/health")
def health(db: Session = Depends(get_db)):
    return {"status": "ok", "llmConfigured": settings.llm_ready, "turbines": db.query(Turbine).count()}


@app.get("/api/overview")
def overview(db: Session = Depends(get_db)):
    turbines = db.query(Turbine).all()
    statuses = {"running": 0, "warning": 0, "fault": 0}
    for t in turbines:
        statuses[t.status] += 1
    projects = db.query(Project).all()
    return {
        "regions": db.query(Region).count(), "windFarms": db.query(WindFarm).count(),
        "turbines": len(turbines), "statusCounts": statuses,
        "projects": len(projects), "projectCapacityMw": sum(p.capacity_mw for p in projects),
        "factories": db.query(Factory).count(), "alerts": db.query(Alert).filter(Alert.resolved.is_(False)).count(),
        "periods": [f"{y}-Q{q}" for y in range(2025, 2030) for q in range(1, 5)],
    }


@app.get("/api/regions")
def regions(db: Session = Depends(get_db)):
    return db.query(Region).all()


@app.get("/api/wind-farms")
def wind_farms(db: Session = Depends(get_db)):
    farms = db.query(WindFarm).all()
    return [{
        **serialize_model(farm), "turbineCount": len(farm.turbines),
        "capacityMw": sum(t.rated_power_kw for t in farm.turbines) / 1000,
        "statusCounts": {s: sum(1 for t in farm.turbines if t.status == s) for s in ("running", "warning", "fault")},
    } for farm in farms]


@app.get("/api/turbines")
def turbines(period: str | None = None, wind_farm_id: str | None = None, status: str | None = None,
             db: Session = Depends(get_db)):
    query = db.query(Turbine)
    if wind_farm_id:
        query = query.filter(Turbine.wind_farm_id == wind_farm_id)
    if status:
        query = query.filter(Turbine.status == status)
    rows = query.all()
    operations = {op.turbine_id: op for op in db.query(OperationData).filter(OperationData.period == (period or "2027-Q3"))}
    farms = {f.id: f for f in db.query(WindFarm).all()}
    return [{
        **serialize_model(t), "windFarmName": farms[t.wind_farm_id].name, "regionId": farms[t.wind_farm_id].region_id,
        "operation": serialize_model(operations[t.id]) if t.id in operations else None,
    } for t in rows if not status or t.status == status]


@app.get("/api/factories")
def factories(db: Session = Depends(get_db)):
    return db.query(Factory).all()


@app.get("/api/projects")
def projects(region_id: str | None = None, min_capacity: int | None = None, status: str | None = None,
             db: Session = Depends(get_db)):
    q = db.query(Project)
    if region_id:
        q = q.filter(Project.region_id == region_id)
    if min_capacity:
        q = q.filter(Project.capacity_mw >= min_capacity)
    if status:
        q = q.filter(Project.status == status)
    return q.all()


@app.get("/api/substations")
def substations(db: Session = Depends(get_db)):
    return db.query(Substation).all()


@app.get("/api/alerts")
def alerts(resolved: bool = False, db: Session = Depends(get_db)):
    return db.query(Alert).filter(Alert.resolved == resolved).order_by(Alert.occurred_at.desc()).all()


@app.get("/api/transport-routes")
def transport_routes(factory_id: str | None = None, db: Session = Depends(get_db)):
    q = db.query(TransportRoute)
    if factory_id:
        q = q.filter(TransportRoute.factory_id == factory_id)
    return q.all()


@app.get("/api/demands")
def demands(db: Session = Depends(get_db)):
    return db.query(Demand).order_by(Demand.year).all()


@app.get("/api/production-capacity")
def production_capacity(period: str | None = None, factory_id: str | None = None, db: Session = Depends(get_db)):
    q = db.query(ProductionCapacity)
    if period:
        q = q.filter(ProductionCapacity.period == period)
    if factory_id:
        q = q.filter(ProductionCapacity.factory_id == factory_id)
    return q.order_by(ProductionCapacity.period).all()


@app.post("/api/scenarios")
def create_scenario(payload: ScenarioIn, db: Session = Depends(get_db)):
    if payload.end_year < payload.start_year:
        raise HTTPException(422, "end_year must not be earlier than start_year")
    if payload.objective not in ("balanced", "logistics_cost", "delivery_risk"):
        raise HTTPException(422, "invalid objective")
    scenario = Scenario(**payload.model_dump(), status="ready")
    db.add(scenario)
    db.commit()
    db.refresh(scenario)
    return scenario


@app.get("/api/scenarios")
def list_scenarios(db: Session = Depends(get_db)):
    return db.query(Scenario).order_by(Scenario.created_at.desc()).all()


@app.get("/api/scenarios/{scenario_id}")
def get_scenario(scenario_id: int, db: Session = Depends(get_db)):
    scenario = db.get(Scenario, scenario_id)
    if not scenario:
        raise HTTPException(404, "Scenario not found")
    return scenario


@app.post("/api/scenarios/{scenario_id}/plan")
def plan_scenario(scenario_id: int, db: Session = Depends(get_db)):
    scenario = db.get(Scenario, scenario_id)
    if not scenario:
        raise HTTPException(404, "Scenario not found")
    results = run_planning(db, scenario)
    db.query(PlanningResult).filter(PlanningResult.scenario_id == scenario_id).delete()
    for item in results:
        db.add(PlanningResult(scenario_id=scenario_id, plan_key=item["plan_key"], plan_name=item["plan_name"],
                              objective=item["objective"], result=item))
    scenario.status = "planned"
    db.commit()
    return {"scenarioId": scenario_id, "plans": results}


@app.get("/api/scenarios/{scenario_id}/plans")
def scenario_plans(scenario_id: int, db: Session = Depends(get_db)):
    rows = db.query(PlanningResult).filter(PlanningResult.scenario_id == scenario_id).order_by(PlanningResult.plan_key).all()
    return [{
        **serialize_model(row, excludes=("result",)),
        **row.result,
    } for row in rows]


@app.post("/api/ai/command")
async def ai_command(payload: AICommandIn, db: Session = Depends(get_db)):
    actions, context, answer = rule_actions(payload.question, db)
    source = "rule"
    try:
        llm_answer, llm_actions = await call_llm(payload.question, context)
        if llm_answer:
            answer = llm_answer
            source = "llm"
            known = {a["type"] for a in actions}
            actions.extend(a for a in llm_actions if a.get("type") not in known)
    except Exception:
        pass
    return {"answer": answer, "actions": actions, "context": context, "charts": chart_specs(db, payload.question), "source": source}


@app.post("/api/reports")
async def create_report(payload: ReportIn, db: Session = Depends(get_db)):
    report = await generate_report(db, payload)
    return {**serialize_model(report, excludes=("html",)), "html": report.html}


@app.get("/api/reports")
def reports(db: Session = Depends(get_db)):
    return db.query(Report.id, Report.title, Report.report_type, Report.source, Report.created_at).order_by(Report.created_at.desc()).all()


@app.get("/api/reports/{report_id}")
def get_report(report_id: int, db: Session = Depends(get_db)):
    report = db.get(Report, report_id)
    if not report:
        raise HTTPException(404, "Report not found")
    return serialize_model(report)


@app.get("/api/reports/{report_id}/html")
def get_report_html(report_id: int, db: Session = Depends(get_db)):
    report = db.get(Report, report_id)
    if not report:
        raise HTTPException(404, "Report not found")
    from fastapi.responses import HTMLResponse
    return HTMLResponse(report.html)
