import json
from collections import Counter
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, HTTPException


router = APIRouter(prefix="/api/realwind", tags=["real wind"])
PICKS_PATH = Path(__file__).resolve().parents[2] / "data" / "uswind_picks.json"

FARM_METADATA = {
    "hale-wind": {"name": "Hale Wind", "state": "Texas"},
    "sagamore-wind": {"name": "Sagamore Wind", "state": "New Mexico"},
    "traverse-wind": {"name": "Traverse Wind", "state": "Oklahoma"},
    "high-banks": {"name": "High Banks Wind Project", "state": "Kansas"},
    "western-spirit": {"name": "Western Spirit", "state": "New Mexico"},
}


@lru_cache(maxsize=1)
def selected_turbines() -> dict[str, tuple[dict, ...]]:
    with PICKS_PATH.open(encoding="utf-8") as source:
        payload = json.load(source)
    return {
        farm_id: tuple(payload[metadata["name"]])
        for farm_id, metadata in FARM_METADATA.items()
        if metadata["name"] in payload
    }


@router.get("/farms")
def farms():
    all_turbines = selected_turbines()
    return [
        {
            "id": farm_id,
            "name": metadata["name"],
            "state": metadata["state"],
            "lat": sum(turbine["lat"] for turbine in turbines) / len(turbines),
            "lng": sum(turbine["lon"] for turbine in turbines) / len(turbines),
            "turbineCount": len(turbines),
            "capacityMw": round(sum(turbine["cap_kw"] for turbine in turbines) / 1000, 1),
            "dominantManufacturer": Counter(turbine["manu"] for turbine in turbines).most_common(1)[0][0],
            "dominantModel": Counter(turbine["model"] for turbine in turbines).most_common(1)[0][0],
            "commissioningYear": Counter(turbine["year"] for turbine in turbines).most_common(1)[0][0],
            "source": "USGS USWTDB v9.0 (2026-06-26)",
        }
        for farm_id, metadata in FARM_METADATA.items()
        if (turbines := all_turbines.get(farm_id))
    ]


@router.get("/farms/{farm_id}/turbines")
def farm_turbines(farm_id: str):
    turbines = selected_turbines().get(farm_id)
    if turbines is None:
        raise HTTPException(status_code=404, detail="Real wind farm not found")
    metadata = FARM_METADATA[farm_id]
    return [
        {
            "id": f"{farm_id}-{index + 1}",
            "farmId": farm_id,
            "farmName": metadata["name"],
            "state": metadata["state"],
            "lat": turbine["lat"],
            "lon": turbine["lon"],
            "capKw": turbine["cap_kw"],
            "hubHeightM": turbine["hh_m"],
            "rotorDiameterM": turbine["rd_m"],
            "manufacturer": turbine["manu"],
            "model": turbine["model"],
            "year": turbine["year"],
        }
        for index, turbine in enumerate(turbines)
    ]
