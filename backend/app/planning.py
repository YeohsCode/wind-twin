import math
from sqlalchemy.orm import Session
from .models import Factory, Project, ProductionCapacity, Scenario


PLANS = [
    ("A", "Plan A · 产能均衡", "balanced", {"cost": 0.35, "utilization": 0.35, "risk": 0.30}),
    ("B", "Plan B · 物流优先", "logistics_cost", {"cost": 0.72, "utilization": 0.18, "risk": 0.10}),
    ("C", "Plan C · 交付风险优先", "delivery_risk", {"cost": 0.22, "utilization": 0.24, "risk": 0.54}),
]


def _distance(a: Factory, b: Project) -> float:
    dx = (b.lng - a.lng) * 111.32 * math.cos(math.radians((a.lat + b.lat) / 2))
    dy = (b.lat - a.lat) * 110.57
    return max(35, round(math.sqrt(dx * dx + dy * dy)))


def _risk_score(distance_km: int, route_risk: str) -> float:
    base = min(distance_km / 1000, 1) * 0.65
    bonus = {"low": 0.06, "medium": 0.22, "high": 0.42}[route_risk]
    return min(0.98, base + bonus)


def run_planning(db: Session, scenario: Scenario) -> list[dict]:
    selected_ids = scenario.factory_ids or [f.id for f in db.query(Factory).all()]
    factories = db.query(Factory).filter(Factory.id.in_(selected_ids)).order_by(Factory.id).all()
    region_filter = (Project.region_id == scenario.region_id if scenario.region_id != "north-china"
                     else Project.region_id.in_(["inner-mongolia", "hebei", "shanxi"]))
    projects = db.query(Project).filter(
        region_filter,
        Project.planned_year >= scenario.start_year,
        Project.planned_year <= scenario.end_year,
    ).order_by(Project.planned_year, Project.demand_index.desc(), Project.capacity_mw.desc()).all()

    # Prioritize projects until the selected portfolio covers the configured demand.
    chosen: list[Project] = []
    total = 0
    for project in projects:
        if total >= scenario.demand_mw:
            break
        chosen.append(project)
        total += project.capacity_mw

    periods = [f"{y}-Q{q}" for y in range(scenario.start_year, scenario.end_year + 1) for q in range(1, 5)]
    capacities = db.query(ProductionCapacity).filter(
        ProductionCapacity.factory_id.in_(selected_ids), ProductionCapacity.period.in_(periods)
    ).all()
    capacity_by_factory = {f.id: sum(c.available_mw for c in capacities if c.factory_id == f.id) for f in factories}
    routes = {}
    from .models import TransportRoute
    for route in db.query(TransportRoute).all():
        routes[(route.factory_id, route.project_id)] = route

    results: list[dict] = []
    for plan_key, plan_name, objective, weights in PLANS:
        remaining = {f.id: capacity_by_factory[f.id] for f in factories}
        assigned_count = {f.id: 0 for f in factories}
        assigned_mw = {f.id: 0.0 for f in factories}
        allocations = []
        unmet = 0.0
        for project in chosen:
            min_count = min(assigned_count.values()) if assigned_count else 0
            candidates = []
            for factory in factories:
                if objective == "balanced" and remaining[factory.id] > 0 and assigned_count[factory.id] > min_count:
                    continue
                route = routes.get((factory.id, project.id))
                distance = route.distance_km if route else _distance(factory, project)
                risk = _risk_score(distance, route.risk_level if route else "medium")
                cap_score = min(remaining[factory.id] / max(project.capacity_mw, 1), 1.35) / 1.35
                cost_score = 1 - min(distance / 1000, 1)
                risk_score = 1 - risk
                total_capacity = max(sum(capacity_by_factory.values()), 1)
                target_share = 1 / max(len(factories), 1)
                assigned_share = (assigned_mw[factory.id] + project.capacity_mw) / total_capacity
                balance_score = 1 - min(abs(assigned_share - target_share) * 3.0, 1)
                if objective == "balanced":
                    score = 0.70 * balance_score + 0.15 * cost_score + 0.10 * risk_score + cap_score * 0.05
                elif objective == "logistics_cost":
                    score = 0.76 * cost_score + 0.14 * balance_score + 0.10 * risk_score
                else:
                    score = 0.62 * risk_score + 0.24 * balance_score + 0.14 * cost_score
                score -= assigned_count[factory.id] * (0.08 if objective == "balanced" else 0.003)
                candidates.append((score, factory, distance, risk, route))
            if objective == "balanced":
                # The balanced heuristic rotates factories until each has work, then uses proximity.
                factory_candidate = min(candidates, key=lambda x: (x[1].id, -x[2]))
                score, factory, distance, risk, route = factory_candidate
            else:
                score, factory, distance, risk, route = max(candidates, key=lambda x: (x[0], -x[2], x[1].id))
            alloc_mw = min(float(project.capacity_mw), max(0.0, remaining[factory.id]))
            if alloc_mw < project.capacity_mw:
                unmet += project.capacity_mw - alloc_mw
            remaining[factory.id] -= alloc_mw
            assigned_mw[factory.id] += alloc_mw
            assigned_count[factory.id] += 1
            lead_days = 35 + int(distance / 8) + (24 if risk > 0.5 else 8)
            allocations.append({
                "project_id": project.id,
                "project_name": project.name,
                "factory_id": factory.id,
                "factory_name": factory.name,
                "project_lat": project.lat,
                "project_lng": project.lng,
                "factory_lat": factory.lat,
                "factory_lng": factory.lng,
                "assigned_mw": round(alloc_mw, 1),
                "project_capacity_mw": project.capacity_mw,
                "distance_km": distance,
                "transport_risk": round(risk, 3),
                "route_risk": route.risk_level if route else "medium",
                "lead_time_days": lead_days,
                "delivery_period": f"{max(scenario.start_year, project.delivery_year)}-Q{2 if distance < 450 else 4}",
            })

        allocated = sum(a["assigned_mw"] for a in allocations)
        weighted_distance = sum(a["assigned_mw"] * a["distance_km"] for a in allocations) / max(allocated, 1)
        weighted_risk = sum(a["assigned_mw"] * a["transport_risk"] for a in allocations) / max(allocated, 1)
        utilization = {f.id: assigned_mw[f.id] / max(capacity_by_factory[f.id], 1) for f in factories}
        fulfillment = allocated / max(sum(p.capacity_mw for p in chosen), 1)
        total_cost = sum(a["assigned_mw"] * a["distance_km"] for a in allocations)
        metrics = {
            "demand_mw": scenario.demand_mw,
            "allocated_mw": round(allocated, 1),
            "unmet_mw": round(unmet, 1),
            "fulfillment": round(fulfillment, 4),
            "avg_distance_km": round(weighted_distance, 1),
            "logistics_cost_index": round(total_cost / 1000, 1),
            "delivery_risk": round(weighted_risk, 3),
            "high_risk_routes": sum(1 for a in allocations if a["transport_risk"] > 0.55),
            "avg_lead_time_days": round(sum(a["lead_time_days"] * a["assigned_mw"] for a in allocations) / max(allocated, 1), 1),
            "factory_utilization": {f.id: round(utilization[f.id], 4) for f in factories},
            "factory_capacity_mw": {f.id: round(capacity_by_factory[f.id], 1) for f in factories},
        }
        objective_score = (
            weights["cost"] * min(weighted_distance / 1000, 1) +
            weights["utilization"] * (1 - abs(sum(utilization.values()) / max(len(utilization), 1) - 0.88)) +
            weights["risk"] * weighted_risk
        )
        results.append({
            "plan_key": plan_key,
            "plan_name": plan_name,
            "objective": objective,
            "is_primary": objective == scenario.objective,
            "score": round(1 - min(max(objective_score, 0), 1), 4),
            "metrics": metrics,
            "allocations": allocations,
            "factory_summary": [
                {"factory_id": f.id, "factory_name": f.name, "lat": f.lat, "lng": f.lng,
                 "assigned_mw": round(assigned_mw[f.id], 1), "capacity_mw": round(capacity_by_factory[f.id], 1),
                 "utilization": round(utilization[f.id], 4)}
                for f in factories
            ],
        })
    return results
