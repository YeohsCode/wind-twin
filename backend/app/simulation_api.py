from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .database import get_db
from .models import SimulationEntity
from .schemas import SimulationEntityIn, SimulationTickIn
from .simulation import ENTITY_TYPES, advance, ensure_default_entities, get_state

router = APIRouter(prefix="/api/simulation", tags=["simulation"])


def serialize_state(state):
    return {
        "current_time": state.current_time,
        "tick_count": state.tick_count,
        "step_hours": state.step_hours,
    }


@router.get("/entities")
def list_entities(db: Session = Depends(get_db)):
    return ensure_default_entities(db)


@router.post("/entities")
def upsert_entity(payload: SimulationEntityIn, db: Session = Depends(get_db)):
    if payload.type not in ENTITY_TYPES:
        raise HTTPException(400, f"Unsupported entity type: {payload.type}")
    get_state(db)
    entity = db.get(SimulationEntity, payload.id)
    values = payload.model_dump()
    if entity is None:
        entity = SimulationEntity(**values)
        db.add(entity)
    else:
        values["payload"] = {**entity.payload, **payload.payload}
        for key, value in values.items():
            setattr(entity, key, value)
    db.commit()
    db.refresh(entity)
    return entity


@router.delete("/entities/{entity_id}")
def delete_entity(entity_id: str, db: Session = Depends(get_db)):
    entity = db.get(SimulationEntity, entity_id)
    if entity is None:
        raise HTTPException(404, "Simulation entity not found")
    db.delete(entity)
    db.commit()
    return {"status": "deleted", "id": entity_id}


@router.post("/tick")
def tick(payload: SimulationTickIn, db: Session = Depends(get_db)):
    state, entities = advance(
        db,
        steps=payload.steps,
        step_hours=payload.step_hours,
        start_time=payload.start_time,
    )
    return {"state": serialize_state(state), "entities": entities}
