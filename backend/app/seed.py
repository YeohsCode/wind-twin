import math
from datetime import date
from sqlalchemy.orm import Session
from .database import Base, engine, SessionLocal
from .models import *


PERIODS = [f"{y}-Q{q}" for y in (2025, 2026, 2027, 2028, 2029) for q in (1, 2, 3, 4)]

REGIONS = [
    ("north-china", "华北", None, "country", 41.0, 113.0,
     [[35.5, 105.5], [43.5, 105.5], [43.5, 120.5], [35.5, 120.5], [35.5, 105.5]]),
    ("inner-mongolia", "内蒙古", "north-china", "province", 41.8, 111.5,
     [[37.4, 97.5], [46.5, 97.5], [46.5, 126.0], [37.4, 126.0], [37.4, 97.5]]),
    ("hebei", "河北", "north-china", "province", 38.4, 115.5,
     [[36.0, 113.4], [42.6, 113.4], [42.6, 119.9], [36.0, 119.9], [36.0, 113.4]]),
    ("shanxi", "山西", "north-china", "province", 37.6, 112.3,
     [[34.6, 110.2], [40.8, 110.2], [40.8, 114.6], [34.6, 114.6], [34.6, 110.2]]),
]

WIND_FARMS = [
    ("wf-hohhot", "呼和浩特北风电场", "inner-mongolia", 41.05, 111.45, 1450),
    ("wf-baotou", "包头山地风电场", "inner-mongolia", 40.72, 110.10, 1580),
    ("wf-xilingol", "锡林郭勒草原风电场", "inner-mongolia", 43.15, 116.08, 1240),
    ("wf-ordos", "鄂尔多斯高原风电场", "inner-mongolia", 39.62, 109.78, 1360),
    ("wf-zhangjiakou", "张家口坝上风电场", "hebei", 40.95, 114.88, 1520),
    ("wf-chengde", "承德围场风电场", "hebei", 41.85, 117.75, 1180),
    ("wf-tangshan", "唐山沿海风电场", "hebei", 39.32, 118.42, 20),
    ("wf-datum", "大同采煤沉陷区风电基地", "shanxi", 40.10, 113.28, 1080),
]

SUBSTATIONS = [
    ("ss-hohhot-500", "呼和浩特500kV站", "inner-mongolia", 40.98, 111.68, 500),
    ("ss-baotou-500", "包头500kV站", "inner-mongolia", 40.65, 109.95, 500),
    ("ss-xilingol-500", "锡林浩特500kV站", "inner-mongolia", 43.22, 116.35, 500),
    ("ss-zjk-500", "张家口500kV站", "hebei", 40.82, 114.95, 500),
    ("ss-chengde-500", "承德500kV站", "hebei", 41.75, 117.90, 500),
    ("ss-datum-500", "大同500kV站", "shanxi", 40.02, 113.45, 500),
]

FACTORIES = [
    ("F-A", "A 塔筒与整机基地", "hebei", 39.12, 117.20, 680, "normal", 82),
    ("F-B", "B 内蒙古制造基地", "inner-mongolia", 40.58, 109.96, 620, "busy", 91),
    ("F-C", "C 张家口叶片基地", "hebei", 40.78, 114.86, 520, "normal", 68),
]

PROJECT_NAMES = [
    "宏远一期", "宏远二期", "北疆示范", "青峰山地", "云中平原", "长风基地",
    "金原风电", "瀚海一期", "腾格里东", "天润园区", "永昌风电", "北方走廊",
    "黑山梁", "塞北绿电", "坝上更新", "滦河源", "雾灵山地", "曹妃甸海上",
    "桑干河谷", "恒山北麓",
]


def square(lat: float, lng: float, radius_deg: float):
    return [[lat - radius_deg, lng - radius_deg], [lat - radius_deg, lng + radius_deg],
            [lat + radius_deg, lng + radius_deg], [lat + radius_deg, lng - radius_deg],
            [lat - radius_deg, lng - radius_deg]]


def route_points(a_lat, a_lng, b_lat, b_lng, bend=0.06):
    mid_lat = (a_lat + b_lat) / 2 + bend
    mid_lng = (a_lng + b_lng) / 2 - bend / 2
    return [[a_lat, a_lng], [mid_lat, mid_lng], [b_lat, b_lng]]


def distance_km(a_lat, a_lng, b_lat, b_lng):
    dx = (b_lng - a_lng) * 111.32 * math.cos(math.radians((a_lat + b_lat) / 2))
    dy = (b_lat - a_lat) * 110.57
    return max(35, int(math.sqrt(dx * dx + dy * dy)))


def run_seed(force: bool = False) -> int:
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        if not force and db.query(Region).count():
            return db.query(Turbine).count()
        if force:
            for table in reversed(Base.metadata.sorted_tables):
                db.execute(table.delete())
        for rid, name, parent, level, lat, lng, boundary in REGIONS:
            db.add(Region(id=rid, name=name, parent_id=parent, level=level, center_lat=lat,
                          center_lng=lng, boundary=boundary))
        rng = 7
        for fid, name, rid, lat, lng, elev in WIND_FARMS:
            db.add(WindFarm(id=fid, name=name, region_id=rid, lat=lat, lng=lng, elevation_m=elev,
                            boundary=square(lat, lng, 0.18), commissioned_on=date(2018 + (rng % 5), 6, 15)))
            for i in range(18):
                tid = f"{fid}-T{i + 1:02d}"
                rng = (rng * 1103515245 + 12345) % 2147483648
                tilt = -0.13 + (i % 6) * 0.045
                status = "warning" if rng % 29 == 0 else ("fault" if rng % 47 == 0 else "running")
                db.add(Turbine(
                    id=tid, wind_farm_id=fid, name=f"{name[-3:]}-{i + 1:02d}",
                    lat=lat + math.sin(i * 0.82) * 0.115 + tilt * 0.25,
                    lng=lng + math.cos(i * 0.67) * 0.135 + tilt * 0.15,
                    model=["WT-3600", "WT-4500", "WT-5200"][i % 3],
                    rated_power_kw=[3600, 4500, 5200][i % 3], status=status,
                    height_m=105 + (i % 4) * 8,
                ))
        for item in SUBSTATIONS:
            db.add(Substation(id=item[0], name=item[1], region_id=item[2], lat=item[3], lng=item[4], voltage_kv=item[5]))
        for fid, name, rid, lat, lng, cap, status, load in FACTORIES:
            db.add(Factory(id=fid, name=name, region_id=rid, lat=lat, lng=lng,
                           annual_capacity_mw=cap, status=status, load_percent=load))
            for year in range(2025, 2030):
                for q in range(1, 5):
                    base = cap / 4
                    seasonal = [0.88, 0.96, 1.04, 1.10][q - 1] * (1 + (year - 2027) * 0.035)
                    available = round(base * seasonal, 1)
                    db.add(ProductionCapacity(factory_id=fid, period=f"{year}-Q{q}",
                                              capacity_mw=round(base, 1), available_mw=available,
                                              used_mw=round(available * (load / 100) * (0.88 + 0.04 * q), 1)))
        for i, name in enumerate(PROJECT_NAMES):
            farm = WIND_FARMS[i % len(WIND_FARMS)]
            year = 2027 + i % 3
            capacity = [180, 240, 320, 420, 500, 620, 720, 860][i % 8]
            db.add(Project(id=f"P-{i + 1:02d}", name=name, region_id=farm[2], lat=farm[3] + 0.22,
                           lng=farm[4] - 0.20 + i * 0.025, capacity_mw=capacity,
                           phase=["在建", "核准", "储备"][i % 3], status=["construction", "approved", "reserve"][i % 3],
                           planned_year=year, delivery_year=year, demand_index=0.85 + (i % 7) * 0.05))
        for rid in ("north-china",):
            for year in range(2025, 2030):
                db.add(Demand(region_id=rid, year=year, scenario="base", demand_mw=780 + (year - 2025) * 240,
                              wind_speed_avg=6.6 + (year % 3) * 0.18, policy_support=[0.72, 0.78, 0.88, 0.92, 0.95][year - 2025]))
        db.flush()
        farms = {x.id: x for x in db.query(WindFarm).all()}
        turbines = db.query(Turbine).all()
        for turbine in turbines:
            farm = farms[turbine.wind_farm_id]
            for pi, period in enumerate(PERIODS):
                factor = [0.58, 0.72, 0.84, 0.68, 0.62, 0.76, 0.88, 0.72,
                          0.66, 0.80, 0.90, 0.76, 0.70, 0.83, 0.93, 0.79,
                          0.74, 0.86, 0.95, 0.82][pi]
                seed_value = (hash(turbine.id + period) % 1000) / 1000
                output = turbine.rated_power_kw * factor * (0.82 + seed_value * 0.35)
                status = turbine.status
                if turbine.status == "fault":
                    output *= 0.08
                elif turbine.status == "warning":
                    output *= 0.66
                db.add(OperationData(turbine_id=turbine.id, period=period, power_kw=round(output, 1),
                                     wind_speed=round(5.4 + factor * 4.4 + seed_value, 2),
                                     availability=round(0.74 + factor * 0.24, 3), status=status))
        alerts = [
            ("critical", "turbine", "wf-baotou-T06", "齿轮箱温度超限", "齿轮箱油温连续 15 分钟超过阈值，建议停机检查。"),
            ("warning", "factory", "F-B", "工厂负荷偏高", "当前产能利用率超过 90%，交付排程存在瓶颈。"),
            ("warning", "turbine", "wf-zhangjiakou-T13", "偏航误差偏大", "偏航对风误差达到 12°，发电效率下降。"),
            ("critical", "project", "P-08", "大部件运输风险", "风电项目大部件运输路段施工，交付风险升高。"),
        ]
        for level, stype, sid, title, detail in alerts:
            db.add(Alert(level=level, source_type=stype, source_id=sid, title=title, detail=detail))
        facs = {x.id: x for x in db.query(Factory).all()}
        projects = db.query(Project).all()
        for i, project in enumerate(projects):
            for j, factory in enumerate(facs.values()):
                dist = distance_km(factory.lat, factory.lng, project.lat, project.lng)
                db.add(TransportRoute(id=f"TR-{i + 1:02d}-{chr(65 + j)}",
                                      name=f"{factory.name[0]} → {project.name}",
                                      factory_id=factory.id, project_id=project.id, distance_km=dist,
                                      capacity_ton=[800, 1200, 1600][(i + j) % 3],
                                      risk_level="high" if (i + j) % 7 == 0 or dist > 800 else
                                      ("medium" if (i + j) % 3 == 0 or dist > 430 else "low"),
                                      geometry=route_points(factory.lat, factory.lng, project.lat, project.lng,
                                                            0.04 + ((i + j) % 5) * 0.035)))
        db.commit()
        return db.query(Turbine).count()


if __name__ == "__main__":
    print(f"seeded turbines: {run_seed()}")
