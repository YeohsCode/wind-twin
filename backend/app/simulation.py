from __future__ import annotations

from datetime import datetime, timedelta, timezone
from math import cos, radians, sin, sqrt
from sqlalchemy.orm.attributes import flag_modified

from sqlalchemy.orm import Session

from .models import (
    OperationData,
    Project,
    SimulationEntity,
    SimulationState,
    TransportRoute,
    Turbine,
    WindFarm,
)

ENTITY_TYPES = {
    "transport_crew",
    "crane",
    "production_equipment",
    "storage_unit",
    "transmission_line",
    "wind_turbine_site",
}
DEFAULT_TIME = datetime(2027, 1, 1, tzinfo=timezone.utc)
COMPONENTS = ("tower", "nacelle", "blade")
STAGES = {"tower": "塔筒", "nacelle": "机舱", "blade": "叶片"}
PRICE_BASE_YUAN_MWH = 520
PRICE_SUPPLY_DEMAND_FACTOR = 0.45


def utc_naive(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def get_state(db: Session, start_time: datetime | None = None) -> SimulationState:
    state = db.get(SimulationState, "default")
    if state is None:
        state = SimulationState(
            id="default",
            current_time=utc_naive(start_time or DEFAULT_TIME),
            tick_count=0,
            step_hours=1,
        )
        db.add(state)
        db.flush()
    return state


def _entity(db: Session, entity_id: str, entity_type: str, position: list[float],
            target_id: str | None, status: str, payload: dict, progress: float = 0) -> SimulationEntity:
    return SimulationEntity(
        id=entity_id,
        type=entity_type,
        position=position,
        target_id=target_id,
        progress=progress,
        status=status,
        payload=payload,
    )


def _route_for(db: Session, project_id: str) -> TransportRoute:
    route = (
        db.query(TransportRoute)
        .filter(TransportRoute.project_id == project_id)
        .order_by(TransportRoute.distance_km, TransportRoute.id)
        .first()
    )
    if route is None:
        raise ValueError(f"No transport route for project {project_id}")
    return route


def ensure_default_entities(db: Session) -> list[SimulationEntity]:
    entities = db.query(SimulationEntity).order_by(SimulationEntity.id).all()
    if entities:
        return entities
    get_state(db)
    project = db.query(Project).filter(Project.status == "construction").order_by(Project.id).first()
    if project is None:
        project = db.query(Project).order_by(Project.id).first()
    if project is None:
        return []
    route = _route_for(db, project.id)
    from .models import Factory

    factory = db.get(Factory, route.factory_id)
    farms = db.query(WindFarm).all()
    if not farms:
        raise ValueError("No wind farms available")
    farm = min(
        farms,
        key=lambda row: ((row.lat - project.lat) * 111) ** 2
        + ((row.lng - project.lng) * 111 * cos(radians(project.lat))) ** 2,
    )
    factory_position = [factory.lat, factory.lng]
    site_position = [project.lat, project.lng]
    route_payload = {"route_id": route.id, "distance_km": route.distance_km}
    db.add(_entity(
        db, "production-F-B", "production_equipment", factory_position, factory.id, "producing",
        {
            "factory_id": factory.id,
            "inventory": {"tower": 0, "nacelle": 0, "blade": 0},
            "rates_per_hour": {"tower": 0.25, "nacelle": 0.25, "blade": 0.25},
            "components": ["塔段", "机舱", "叶片"],
        },
    ))
    db.add(_entity(
        db, "transport-F-B-01", "transport_crew", factory_position, project.id, "idle",
        {
            **route_payload,
            "factory_id": factory.id,
            "speed_km_h": 35,
            "direction": "return",
            "elapsed_hours": 0,
            "cargo": None,
        },
    ))
    db.add(_entity(
        db, f"crane-{project.id}-01", "crane", factory_position, factory.id, "idle",
        {
            **route_payload,
            "speed_km_h": 55,
            "direction": "outbound",
            "elapsed_hours": 0,
            "stage": None,
            "stage_progress": 0,
        },
    ))
    db.add(_entity(
        db, f"site-{project.id}-01", "wind_turbine_site", site_position, project.id, "waiting",
        {
            "project_id": project.id,
            "wind_farm_id": farm.id,
            "required_components": list(COMPONENTS),
            "stock": {"tower": 0, "nacelle": 0, "blade": 0},
            "installed_units": 0,
            "stage": None,
            "stage_progress": 0,
            "completed_turbine_ids": [],
        },
    ))
    db.add(_entity(
        db, f"storage-{farm.id}", "storage_unit", [farm.lat, farm.lng], farm.id, "standby",
        {"wind_farm_id": farm.id, "capacity_mwh": 80, "soc": 0.5, "mode": "idle"},
    ))
    db.add(_entity(
        db, f"line-{farm.id}-{project.id}", "transmission_line", [farm.lat, farm.lng], project.id, "standby",
        {"from_id": farm.id, "to_id": project.id, "flow_mw": 0, "capacity_mw": 200},
        progress=0,
    ))
    db.commit()
    return db.query(SimulationEntity).order_by(SimulationEntity.id).all()


def _position_at(route: TransportRoute, fraction: float) -> list[float]:
    points = [point for point in route.geometry if len(point) >= 2]
    if not points:
        return [0, 0]
    fraction = min(1, max(0, fraction))
    if len(points) == 1 or fraction <= 0:
        return [points[0][0], points[0][1]]
    if fraction >= 1:
        return [points[-1][0], points[-1][1]]
    distances = []
    total = 0
    for (lat_a, lng_a), (lat_b, lng_b) in zip(points, points[1:]):
        distance = sqrt(((lat_b - lat_a) * 111) ** 2 + ((lng_b - lng_a) * 111 * cos(radians(lat_a))) ** 2)
        distances.append(distance)
        total += distance
    target = total * fraction
    traveled = 0
    for index, distance in enumerate(distances):
        if traveled + distance >= target:
            local = (target - traveled) / distance if distance else 0
            return [
                points[index][0] + (points[index + 1][0] - points[index][0]) * local,
                points[index][1] + (points[index + 1][1] - points[index][1]) * local,
            ]
        traveled += distance
    return [points[-1][0], points[-1][1]]


def _advance_traveler(db: Session, entity: SimulationEntity, hours: int) -> bool:
    payload = entity.payload
    distance = float(payload["distance_km"])
    speed = float(payload["speed_km_h"])
    total_hours = max(1, round(distance / speed))
    payload["elapsed_hours"] = int(payload.get("elapsed_hours", 0)) + hours
    elapsed = payload["elapsed_hours"]
    fraction = min(1, elapsed / total_hours)
    entity.progress = round(fraction * 100, 4)
    route = db.get(TransportRoute, entity.payload["route_id"])
    travel_fraction = 1 - fraction if payload["direction"] == "return" else fraction
    entity.position = _position_at(route, travel_fraction)
    if elapsed >= total_hours:
        payload["elapsed_hours"] = 0
        entity.progress = 0 if payload["direction"] == "return" else 100
        return True
    return False


def _quarter_start(value: datetime) -> str:
    return f"{value.year}-Q{(value.month - 1) // 3 + 1}"


def _normalize_production(entity: SimulationEntity) -> None:
    inventory = entity.payload.setdefault("inventory", {})
    rates = entity.payload.setdefault("rates_per_hour", {})
    for component in COMPONENTS:
        inventory.setdefault(component, 0)
        rates.setdefault(component, 0.25)


def _deterministic_profile(hour_index: int) -> tuple[float, float]:
    hour = hour_index % 24
    load_shape = 0.82 + 0.18 * cos((hour - 8) * 3.141592653589793 / 12)
    wind_shape = 0.72 + 0.28 * sin((hour_index % 72) * 3.141592653589793 / 36)
    return round(60 * load_shape, 6), round(60 * wind_shape, 6)


def _storage_runtimes(storage_rows: list[SimulationEntity]) -> dict[str, dict]:
    return {
        row.payload.get("wind_farm_id"): {
            "capacity": max(0, float(row.payload.get("capacity_mwh", 0))),
            "soc": min(1, max(0, float(row.payload.get("soc", 0)))),
        }
        for row in storage_rows if row.payload.get("wind_farm_id")
    }


def _storage_delta_mw(gen_mw: float, load_mw: float, hours: int,
                      runtimes: dict[str, dict]) -> tuple[float, dict[str, float], dict[str, str]]:
    net_mw = gen_mw - load_mw
    energy_delta_mwh = net_mw * hours
    active = {farm_id: state for farm_id, state in runtimes.items() if state["capacity"] > 0}
    if not active:
        return 0, {}, {}
    total_capacity = sum(state["capacity"] for state in active.values())
    total_energy = sum(state["soc"] * state["capacity"] for state in active.values())
    if energy_delta_mwh >= 0:
        accepted = min(energy_delta_mwh, total_capacity - total_energy)
        mode = "charge"
    else:
        accepted = max(energy_delta_mwh, -total_energy)
        mode = "discharge"
    accepted = round(accepted, 6)
    storage_deltas: dict[str, float] = {}
    modes: dict[str, str] = {}
    for farm_id, storage_state in active.items():
        share = storage_state["capacity"] / total_capacity
        farm_accepted = round(accepted * share, 6)
        storage_state["soc"] = round(
            min(1, max(0, (storage_state["soc"] * storage_state["capacity"] + farm_accepted) / storage_state["capacity"])),
            6,
        )
        storage_deltas[farm_id] = round(farm_accepted / hours, 6) if hours else 0
        modes[farm_id] = mode if abs(farm_accepted) > 1e-9 else "idle"
    return round(sum(storage_deltas.values()), 6), storage_deltas, modes


def _apply_storage(db: Session, gen_mw: float, load_mw: float, hours: int) -> float:
    storage_rows = db.query(SimulationEntity).filter(
        SimulationEntity.type == "storage_unit"
    ).order_by(SimulationEntity.id).all()
    runtimes = _storage_runtimes(storage_rows)
    total_delta, farm_deltas, modes = _storage_delta_mw(gen_mw, load_mw, hours, runtimes)
    for row in storage_rows:
        farm_id = row.payload.get("wind_farm_id")
        payload = row.payload
        if farm_id in runtimes:
            payload["soc"] = runtimes[farm_id]["soc"]
            payload["mode"] = modes[farm_id]
            payload["delta_mw"] = farm_deltas.get(farm_id, 0)
            row.status = "standby" if payload["mode"] == "idle" else "active"
        else:
            payload["soc"] = min(1, max(0, float(payload.get("soc", 0))))
            payload["mode"] = "idle"
            payload["delta_mw"] = 0
            row.status = "standby"
    _update_power_flow(db, gen_mw - total_delta)
    return total_delta


def _update_power_flow(db: Session, flow_mw: float) -> None:
    lines = db.query(SimulationEntity).filter(
        SimulationEntity.type == "transmission_line"
    ).order_by(SimulationEntity.id).all()
    for line in lines:
        capacity = max(0, float(line.payload.get("capacity_mw", 0)))
        line.payload["flow_mw"] = round(min(capacity, max(-capacity, flow_mw)), 6)
        line.status = "active" if abs(line.payload["flow_mw"]) > 1e-9 else "standby"


def _grid_snapshot(db: Session, state: SimulationState, apply_storage: bool = False) -> dict:
    start = state.current_time.replace(minute=0, second=0, microsecond=0)
    epoch = datetime(2027, 1, 1)
    hour_index = int((utc_naive(start) - epoch).total_seconds() // 3600)
    load_mw, gen_mw = _deterministic_profile(hour_index)
    if apply_storage:
        total_storage_delta = _apply_storage(db, gen_mw, load_mw, state.step_hours)
        storage_modes = {
            row.payload.get("wind_farm_id"): row.payload["mode"]
            for row in db.query(SimulationEntity).filter(SimulationEntity.type == "storage_unit").all()
        }
    else:
        storage_rows = db.query(SimulationEntity).filter(
            SimulationEntity.type == "storage_unit"
        ).order_by(SimulationEntity.id).all()
        runtimes = _storage_runtimes(storage_rows)
        total_storage_delta, _, storage_modes = _storage_delta_mw(gen_mw, load_mw, 1, runtimes)
    return {
        "load_mw": load_mw,
        "gen_mw": gen_mw,
        "storage_delta": total_storage_delta,
        "price_yuan_mwh": max(0, round(PRICE_BASE_YUAN_MWH + PRICE_SUPPLY_DEMAND_FACTOR * (load_mw - gen_mw - total_storage_delta), 6)),
        "storage_modes": storage_modes,
    }


def build_timeseries(db: Session, state: SimulationState, hours: int) -> dict:
    timestamps = []
    prices = []
    loads = []
    generation = []
    storage_deltas = []
    cursor = state.current_time.replace(minute=0, second=0, microsecond=0)
    epoch = datetime(2027, 1, 1)
    start_index = int((utc_naive(cursor) - epoch).total_seconds() // 3600)
    storage_rows = db.query(SimulationEntity).filter(
        SimulationEntity.type == "storage_unit"
    ).order_by(SimulationEntity.id).all()
    runtimes = _storage_runtimes(storage_rows)
    farm_ids = {row.id for row in db.query(WindFarm).all()}
    runtimes = {farm_id: value for farm_id, value in runtimes.items() if farm_id in farm_ids}
    for _ in range(hours):
        load_mw, gen_mw = _deterministic_profile(start_index)
        storage_delta, _, _ = _storage_delta_mw(gen_mw, load_mw, 1, runtimes)
        timestamps.append(cursor.replace(tzinfo=timezone.utc))
        prices.append(max(0, round(PRICE_BASE_YUAN_MWH + PRICE_SUPPLY_DEMAND_FACTOR * (load_mw - gen_mw - storage_delta), 6)))
        loads.append(load_mw)
        generation.append(gen_mw)
        storage_deltas.append(storage_delta)
        cursor += timedelta(hours=1)
        start_index += 1
    return {
        "timestamps": timestamps,
        "price_yuan_mwh": prices,
        "load_mw": loads,
        "gen_mw": generation,
        "storage_delta": storage_deltas,
    }


def _commission_turbine(db: Session, site: SimulationEntity, state: SimulationState) -> None:
    farm_id = site.payload["wind_farm_id"]
    sequence = len(site.payload["completed_turbine_ids"]) + 1
    turbine_id = f"{farm_id}-SIM-{sequence:03d}"
    rated_power_kw = 5000
    turbine = db.get(Turbine, turbine_id)
    if turbine is None:
        turbine = Turbine(
            id=turbine_id,
            wind_farm_id=farm_id,
            name=f"仿真机组-{sequence:03d}",
            lat=site.position[0],
            lng=site.position[1],
            model="WT-5000-SIM",
            rated_power_kw=rated_power_kw,
            status="running",
            height_m=110,
        )
        db.add(turbine)
        db.flush()

    period = _quarter_start(state.current_time)
    operation = (
        db.query(OperationData)
        .join(Turbine, Turbine.id == OperationData.turbine_id)
        .filter(Turbine.wind_farm_id == farm_id, OperationData.period == period)
        .order_by(OperationData.turbine_id)
        .first()
    )
    if operation is None:
        operation = (
            db.query(OperationData)
            .join(Turbine, Turbine.id == OperationData.turbine_id)
            .filter(Turbine.wind_farm_id == farm_id)
            .order_by(OperationData.period, OperationData.turbine_id)
            .first()
        )
    if operation is None:
        power_kw = 3200
        wind_speed = 8.0
        availability = 0.95
    else:
        reference_turbine = db.get(Turbine, operation.turbine_id)
        power_kw = min(
            float(rated_power_kw),
            rated_power_kw * operation.power_kw / max(1, reference_turbine.rated_power_kw),
        )
        wind_speed = operation.wind_speed
        availability = operation.availability
    existing = db.query(OperationData).filter(
        OperationData.turbine_id == turbine_id, OperationData.period == period
    ).first()
    if existing is None:
        operation_row = OperationData(
            turbine_id=turbine_id,
            period=period,
            power_kw=round(power_kw, 1),
            wind_speed=wind_speed,
            availability=availability,
            status="running",
        )
        db.add(operation_row)
        db.flush()
        operation_id = operation_row.id
    else:
        operation_id = existing.id
    site.payload["completed_turbine_ids"].append(turbine_id)
    site.payload["latest_operation_id"] = operation_id


def _advance_one_tick(db: Session, state: SimulationState) -> None:
    hours = state.step_hours
    entities = {row.id: row for row in db.query(SimulationEntity).all()}
    production = next(iter(row for row in entities.values() if row.type == "production_equipment"), None)
    transport = next(iter(row for row in entities.values() if row.type == "transport_crew"), None)
    crane = next(iter(row for row in entities.values() if row.type == "crane"), None)
    site = next(iter(row for row in entities.values() if row.type == "wind_turbine_site"), None)
    if production is None or transport is None or crane is None or site is None:
        return
    _normalize_production(production)

    if transport.status == "moving":
        if _advance_traveler(db, transport, hours):
            if transport.payload["direction"] == "outbound":
                for component in COMPONENTS:
                    site.payload["stock"][component] += 1
                transport.status = "idle"
                transport.payload["cargo"] = None
                transport.payload["direction"] = "return"
            else:
                transport.status = "idle"
    elif transport.status == "returning":
        transport.status = "moving"

    if crane.status == "moving":
        arrived = _advance_traveler(db, crane, hours)
        if arrived:
            if crane.payload["direction"] == "outbound":
                crane.status = "installing"
            else:
                crane.status = "idle"
                crane.payload["direction"] = "outbound"
                crane.target_id = crane.payload.get("factory_id", crane.target_id)
    elif crane.status == "installing":
        stage = site.payload.get("stage") or COMPONENTS[0]
        site.payload["stage"] = stage
        site.payload["stage_progress"] += hours / 3
        if site.payload["stage_progress"] >= 1:
            site.payload["stock"][stage] -= 1
            site.payload["stage_progress"] = 0
            next_index = COMPONENTS.index(stage) + 1
            if next_index >= len(COMPONENTS):
                site.payload["stage"] = None
                site.payload["installed_units"] += 1
                site.progress = 100
                site.status = "online"
                _commission_turbine(db, site, state)
                crane.status = "idle"
                crane.payload["direction"] = "return"
            else:
                next_stage = COMPONENTS[next_index]
                site.payload["stage"] = next_stage
    elif crane.status == "idle" and crane.payload["direction"] == "outbound" and sum(site.payload["stock"].values()) >= 3:
        crane.target_id = site.id
        crane.status = "moving"
        crane.payload["direction"] = "outbound"
    elif crane.status == "idle" and crane.payload["direction"] == "return":
        crane.status = "moving"
        crane.payload["direction"] = "outbound"

    if production.status == "producing":
        inventory = production.payload["inventory"]
        rates = production.payload["rates_per_hour"]
        for component in COMPONENTS:
            inventory[component] = round(inventory[component] + rates[component] * hours, 6)

    if (
        transport.status == "idle"
        and transport.payload["direction"] == "return"
        and all(production.payload["inventory"][component] >= 1 for component in COMPONENTS)
    ):
        production.payload["dispatch_count"] = int(production.payload.get("dispatch_count", 0)) + 1
        production.payload["last_dispatch_inventory"] = dict(production.payload["inventory"])
        for component in COMPONENTS:
            production.payload["inventory"][component] -= 1
        transport.status = "moving"
        transport.payload["cargo"] = {component: 1 for component in COMPONENTS}
        transport.payload["direction"] = "outbound"
        transport.target_id = site.id

    _grid_snapshot(db, state, apply_storage=True)

    for row in entities.values():
        flag_modified(row, "payload")
        row.updated_at = utc_naive(state.current_time)
    state.tick_count += 1
    state.current_time += timedelta(hours=hours)


def advance(db: Session, steps: int = 1, step_hours: int = 1,
            start_time: datetime | None = None) -> tuple[SimulationState, list[SimulationEntity]]:
    ensure_default_entities(db)
    state = get_state(db, start_time)
    state.step_hours = step_hours
    for _ in range(steps):
        _advance_one_tick(db, state)
    db.commit()
    db.refresh(state)
    entities = db.query(SimulationEntity).order_by(SimulationEntity.id).all()
    return state, entities
