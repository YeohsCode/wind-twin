from datetime import datetime
from pydantic import BaseModel, Field


class ScenarioIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    region_id: str = "north-china"
    start_year: int = 2027
    end_year: int = 2029
    demand_mw: int = Field(gt=0, default=1200)
    objective: str = "balanced"
    factory_ids: list[str] = []


class AICommandIn(BaseModel):
    question: str = Field(min_length=2, max_length=500)
    current_period: str | None = None


class ReportIn(BaseModel):
    title: str = "风电产能规划分析报告"
    report_type: str = "产能规划"
    question: str = "分析华北未来三年风电项目需求和产能匹配情况"
    scenario_id: int | None = None
