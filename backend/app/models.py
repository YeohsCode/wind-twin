from datetime import date, datetime, timezone
from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .database import Base


def utcnow():
    return datetime.now(timezone.utc)


class Region(Base):
    __tablename__ = "regions"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    parent_id: Mapped[str | None] = mapped_column(String, nullable=True)
    level: Mapped[str] = mapped_column(String)
    center_lat: Mapped[float] = mapped_column(Float)
    center_lng: Mapped[float] = mapped_column(Float)
    boundary: Mapped[list] = mapped_column(JSON, default=list)


class WindFarm(Base):
    __tablename__ = "wind_farms"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    region_id: Mapped[str] = mapped_column(ForeignKey("regions.id"))
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    elevation_m: Mapped[int] = mapped_column(Integer, default=1000)
    boundary: Mapped[list] = mapped_column(JSON, default=list)
    commissioned_on: Mapped[date] = mapped_column(Date)
    turbines: Mapped[list["Turbine"]] = relationship(back_populates="wind_farm")


class Turbine(Base):
    __tablename__ = "turbines"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    wind_farm_id: Mapped[str] = mapped_column(ForeignKey("wind_farms.id"))
    name: Mapped[str] = mapped_column(String)
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    model: Mapped[str] = mapped_column(String)
    rated_power_kw: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String, default="running")
    height_m: Mapped[int] = mapped_column(Integer, default=110)
    wind_farm: Mapped[WindFarm] = relationship(back_populates="turbines")


class Substation(Base):
    __tablename__ = "substations"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    region_id: Mapped[str] = mapped_column(ForeignKey("regions.id"))
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    voltage_kv: Mapped[int] = mapped_column(Integer)


class Factory(Base):
    __tablename__ = "factories"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    region_id: Mapped[str] = mapped_column(ForeignKey("regions.id"))
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    annual_capacity_mw: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String, default="normal")
    load_percent: Mapped[float] = mapped_column(Float, default=75)


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    region_id: Mapped[str] = mapped_column(ForeignKey("regions.id"))
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    capacity_mw: Mapped[int] = mapped_column(Integer)
    phase: Mapped[str] = mapped_column(String, default="储备")
    status: Mapped[str] = mapped_column(String, default="planning")
    planned_year: Mapped[int] = mapped_column(Integer)
    delivery_year: Mapped[int] = mapped_column(Integer)
    demand_index: Mapped[float] = mapped_column(Float, default=1)


class ProductionCapacity(Base):
    __tablename__ = "production_capacity"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    factory_id: Mapped[str] = mapped_column(ForeignKey("factories.id"))
    period: Mapped[str] = mapped_column(String, index=True)
    capacity_mw: Mapped[float] = mapped_column(Float)
    available_mw: Mapped[float] = mapped_column(Float)
    used_mw: Mapped[float] = mapped_column(Float, default=0)


class Demand(Base):
    __tablename__ = "demands"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    region_id: Mapped[str] = mapped_column(ForeignKey("regions.id"))
    year: Mapped[int] = mapped_column(Integer, index=True)
    scenario: Mapped[str] = mapped_column(String, default="base")
    demand_mw: Mapped[int] = mapped_column(Integer)
    wind_speed_avg: Mapped[float] = mapped_column(Float)
    policy_support: Mapped[float] = mapped_column(Float)


class OperationData(Base):
    __tablename__ = "operation_data"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    turbine_id: Mapped[str] = mapped_column(ForeignKey("turbines.id"), index=True)
    period: Mapped[str] = mapped_column(String, index=True)
    power_kw: Mapped[float] = mapped_column(Float)
    wind_speed: Mapped[float] = mapped_column(Float)
    availability: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String)


class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    level: Mapped[str] = mapped_column(String)
    source_type: Mapped[str] = mapped_column(String)
    source_id: Mapped[str] = mapped_column(String, index=True)
    title: Mapped[str] = mapped_column(String)
    detail: Mapped[str] = mapped_column(Text)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)


class TransportRoute(Base):
    __tablename__ = "transport_routes"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    factory_id: Mapped[str] = mapped_column(ForeignKey("factories.id"))
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"))
    distance_km: Mapped[int] = mapped_column(Integer)
    capacity_ton: Mapped[int] = mapped_column(Integer)
    risk_level: Mapped[str] = mapped_column(String, default="low")
    geometry: Mapped[list] = mapped_column(JSON, default=list)


class Scenario(Base):
    __tablename__ = "scenarios"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String)
    description: Mapped[str] = mapped_column(Text, default="")
    region_id: Mapped[str] = mapped_column(ForeignKey("regions.id"))
    start_year: Mapped[int] = mapped_column(Integer)
    end_year: Mapped[int] = mapped_column(Integer)
    demand_mw: Mapped[int] = mapped_column(Integer)
    objective: Mapped[str] = mapped_column(String, default="balanced")
    factory_ids: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String, default="draft")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class PlanningResult(Base):
    __tablename__ = "planning_results"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scenario_id: Mapped[int] = mapped_column(ForeignKey("scenarios.id"), index=True)
    plan_key: Mapped[str] = mapped_column(String)
    plan_name: Mapped[str] = mapped_column(String)
    objective: Mapped[str] = mapped_column(String)
    result: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Report(Base):
    __tablename__ = "reports"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String)
    report_type: Mapped[str] = mapped_column(String, default="产能规划")
    question: Mapped[str] = mapped_column(Text)
    content: Mapped[dict] = mapped_column(JSON)
    html: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String, default="rule")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class SimulationEntity(Base):
    __tablename__ = "simulation_entities"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    type: Mapped[str] = mapped_column(String, index=True)
    position: Mapped[list] = mapped_column(JSON, default=list)
    target_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    progress: Mapped[float] = mapped_column(Float, default=0)
    status: Mapped[str] = mapped_column(String, default="idle", index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class SimulationState(Base):
    __tablename__ = "simulation_state"
    id: Mapped[str] = mapped_column(String, primary_key=True, default="default")
    current_time: Mapped[datetime] = mapped_column(DateTime)
    tick_count: Mapped[int] = mapped_column(Integer, default=0)
    step_hours: Mapped[int] = mapped_column(Integer, default=1)
