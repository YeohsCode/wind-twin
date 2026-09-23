import csv
from dataclasses import asdict
import json
import math
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .database import get_db
from .models import Turbine
from .realwind_api import FARM_METADATA, selected_turbines
from .wind_model import WindFarm, WindTurbine


router = APIRouter(prefix="/api/wind", tags=["unified wind"])
DATA_PATH = Path(__file__).resolve().parents[2] / "data"
MAX_TURBINES = 8000


def optional_int(value: str | None) -> Optional[int]:
    return int(value) if value else None


def optional_float(value: str | None) -> Optional[float]:
    return float(value) if value else None


def turbine_dict(turbine: WindTurbine) -> dict:
    return {key: value for key, value in asdict(turbine).items() if value is not None}


def farm_dict(farm: WindFarm) -> dict:
    return {key: value for key, value in asdict(farm).items() if value is not None}


def normalized_country(raw_country: str) -> str:
    codes = {"CHN": "CN", "USA": "US"}
    return codes.get(raw_country.upper(), raw_country.upper())


@lru_cache(maxsize=1)
def wri_wind_farms() -> tuple[WindFarm, ...]:
    path = DATA_PATH / "gppd_v1.1.0.csv"
    with path.open(encoding="utf-8-sig", newline="") as source:
        return tuple(
            WindFarm(
                id=row["gppd_idnr"],
                source="wri",
                name=row["name"],
                country=normalized_country(row["country"]),
                lat=float(row["latitude"]),
                lng=float(row["longitude"]),
                capacityMw=float(row["capacity_mw"]) if row["capacity_mw"] else None,
                commissioningYear=optional_int(row["commissioning_year"]),
            )
            for row in csv.DictReader(source)
            if row.get("fuel1") == "Wind" and row.get("country") == "CHN"
        )


def usgs_wind_farms() -> tuple[WindFarm, ...]:
    farms = []
    for farm_id, metadata in FARM_METADATA.items():
        turbines = selected_turbines().get(farm_id)
        if not turbines:
            continue
        farms.append(WindFarm(
            id=farm_id,
            source="usgs",
            name=metadata["name"],
            country="US",
            lat=sum(item["lat"] for item in turbines) / len(turbines),
            lng=sum(item["lon"] for item in turbines) / len(turbines),
            capacityMw=round(sum(item["cap_kw"] for item in turbines) / 1000, 1),
            turbineCount=len(turbines),
            commissioningYear=optional_int(str(dominant_value(turbines, "year"))),
        ))
    return tuple(farms)


def dominant_value(turbines, key):
    return Counter(item[key] for item in turbines).most_common(1)[0][0]


def usgs_turbines(farm_id: Optional[str] = None) -> tuple[WindTurbine, ...]:
    selections = selected_turbines()
    wanted = selections.keys() & {farm_id} if farm_id else selections.keys()
    result = []
    for selected_id in sorted(wanted):
        for index, item in enumerate(selections[selected_id], start=1):
            result.append(WindTurbine(
                id=f"{selected_id}-{index}",
                source="usgs",
                lat=item["lat"],
                lng=item["lon"],
                capKw=item["cap_kw"],
                hubHeightM=item["hh_m"],
                rotorDiameterM=item["rd_m"],
                manufacturer=item["manu"],
                model=item["model"],
                commissioningYear=optional_int(str(item["year"])),
                farmId=selected_id,
            ))
    return tuple(result)


def simulated_turbines(db: Session) -> tuple[WindTurbine, ...]:
    return tuple(
        WindTurbine(
            id=item.id,
            source="sim",
            lat=item.lat,
            lng=item.lng,
            capKw=item.rated_power_kw,
            hubHeightM=item.height_m,
            model=item.model,
            farmId=item.wind_farm_id,
            name=item.name,
        )
        for item in db.query(Turbine).order_by(Turbine.id).all()
    )


@lru_cache(maxsize=1)
def osm_index() -> tuple[dict[tuple[int, int], tuple[WindTurbine, ...]], tuple[WindTurbine, ...]]:
    path = DATA_PATH / "cn_osm_turbines.json"
    with path.open(encoding="utf-8") as source:
        raw = json.load(source)
    buckets: dict[tuple[int, int], list[WindTurbine]] = defaultdict(list)
    turbines: list[WindTurbine] = []
    for index, item in enumerate(raw):
        lat = float(item["lat"])
        lng = float(item["lon"])
        turbine = WindTurbine(
            id=f"osm-{index}",
            source="osm",
            lat=lat,
            lng=lng,
            capKw=optional_float(str(item["cap_kw"])) if item.get("cap_kw") is not None else None,
            hubHeightM=optional_float(str(item["hh_m"])) if item.get("hh_m") is not None else None,
            rotorDiameterM=optional_float(str(item["rd_m"])) if item.get("rd_m") is not None else None,
            manufacturer=item.get("manu"),
            model=item.get("model"),
            name=item.get("name"),
        )
        buckets[(math.floor(lng), math.floor(lat))].append(turbine)
        turbines.append(turbine)
    return {key: tuple(value) for key, value in buckets.items()}, tuple(turbines)


def aggregate_turbines(turbines: list[WindTurbine], west: float, south: float,
                       east: float, north: float, zoom: Optional[int]) -> list[WindTurbine]:
    if len(turbines) <= MAX_TURBINES:
        return turbines
    span = max(east - west, north - south, 0.001)
    divisions = max(1, math.ceil(math.sqrt(len(turbines) / MAX_TURBINES)))
    cell_size = max(span / divisions, 0.01)
    if zoom is not None:
        cell_size = max(cell_size, 360 / (256 * 2 ** max(0, zoom)) * 8)
    groups: dict[tuple[int, int], list[WindTurbine]] = defaultdict(list)
    for turbine in turbines:
        groups[(math.floor(turbine.lng / cell_size), math.floor(turbine.lat / cell_size))].append(turbine)
    aggregated = []
    for (cell_x, cell_y), members in groups.items():
        count = len(members)
        first = members[0]
        cap = [item.capKw for item in members if item.capKw is not None]
        hub = [item.hubHeightM for item in members if item.hubHeightM is not None]
        rotor = [item.rotorDiameterM for item in members if item.rotorDiameterM is not None]
        aggregated.append(WindTurbine(
            id=f"osm-grid-{cell_x}-{cell_y}",
            source="osm",
            lat=sum(item.lat for item in members) / count,
            lng=sum(item.lng for item in members) / count,
            capKw=round(sum(cap) / len(cap), 1) if cap else None,
            hubHeightM=round(sum(hub) / len(hub), 1) if hub else None,
            rotorDiameterM=round(sum(rotor) / len(rotor), 1) if rotor else None,
            manufacturer=first.manufacturer,
            model=first.model,
            name=f"OSM 聚合点位 · {count} 台",
            aggregateCount=count,
        ))
    return aggregated[:MAX_TURBINES]


def bbox_values(value: str) -> tuple[float, float, float, float]:
    try:
        west, south, east, north = (float(part) for part in value.split(","))
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=400, detail="bbox must be w,s,e,n") from error
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise HTTPException(status_code=400, detail="invalid bbox")
    return west, south, east, north


@router.get("/farms")
def farms(country: Optional[str] = None) -> list[dict]:
    all_farms = wri_wind_farms() + usgs_wind_farms()
    if country:
        wanted = normalized_country(country)
        all_farms = tuple(farm for farm in all_farms if farm.country == wanted)
    return [farm_dict(farm) for farm in all_farms]


@router.get("/turbines")
def turbines(
    source: Optional[str] = None,
    bbox: Optional[str] = None,
    zoom: Optional[int] = Query(default=None, ge=0, le=24),
    farmId: Optional[str] = None,
    db: Session = Depends(get_db),
) -> list[dict]:
    if farmId:
        if not selected_turbines().get(farmId):
            raise HTTPException(status_code=404, detail="Wind farm not found")
        return [turbine_dict(item) for item in usgs_turbines(farmId)]
    if source == "sim":
        return [turbine_dict(item) for item in simulated_turbines(db)]
    if source != "osm":
        return []
    if bbox is None:
        raise HTTPException(status_code=400, detail="bbox is required for OSM turbines")
    west, south, east, north = bbox_values(bbox)
    index, _ = osm_index()
    candidates = [
        turbine
        for cell_x in range(math.floor(west), math.floor(east) + 1)
        for cell_y in range(math.floor(south), math.floor(north) + 1)
        for turbine in index.get((cell_x, cell_y), ())
        if west <= turbine.lng <= east and south <= turbine.lat <= north
    ]
    result = aggregate_turbines(candidates, west, south, east, north, zoom)
    return [turbine_dict(item) for item in result]
