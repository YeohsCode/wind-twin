export type Region = { id: string; name: string; parent_id?: string; level: string; center_lat: number; center_lng: number; boundary: number[][] }
export type Operation = { power_kw: number; wind_speed: number; availability: number; status: string; period: string }
export type Turbine = { id: string; wind_farm_id: string; name: string; lat: number; lng: number; model: string; rated_power_kw: number; status: 'running'|'warning'|'fault'; height_m: number; windFarmName?: string; regionId?: string; operation?: Operation|null }
export type WindFarm = { id: string; name: string; region_id: string; lat: number; lng: number; elevation_m: number; boundary: number[][]; turbineCount: number; capacityMw: number; statusCounts: Record<string, number> }
export type Factory = { id: string; name: string; region_id: string; lat: number; lng: number; annual_capacity_mw: number; status: string; load_percent: number }
export type Project = { id: string; name: string; region_id: string; lat: number; lng: number; capacity_mw: number; phase: string; status: string; planned_year: number; delivery_year: number; demand_index: number }
export type Substation = { id: string; name: string; region_id: string; lat: number; lng: number; voltage_kv: number }
export type Alert = { id: number; level: string; source_type: string; source_id: string; title: string; detail: string; occurred_at: string; resolved: boolean }
export type Route = { id: string; name: string; factory_id: string; project_id: string; distance_km: number; capacity_ton: number; risk_level: string; geometry: number[][] }
export type Allocation = { project_id: string; project_name: string; factory_id: string; factory_name: string; assigned_mw: number; project_capacity_mw: number; distance_km: number; transport_risk: number; route_risk: string; lead_time_days: number; delivery_period: string }
export type Plan = { plan_key: string; plan_name: string; objective: string; is_primary?: boolean; score: number; metrics: Record<string, any>; allocations: Allocation[]; factory_summary: any[] }
export type Scenario = { id: number; name: string; description: string; region_id: string; start_year: number; end_year: number; demand_mw: number; objective: string; factory_ids: string[]; status: string }
export type Overview = { regions:number; windFarms:number; turbines:number; statusCounts:Record<string,number>; projects:number; projectCapacityMw:number; factories:number; alerts:number; periods:string[] }
export type AIChart = { key:string; option:any }
export type AIResult = { answer:string; actions:SceneAction[]; context:any; charts:AIChart[]; source:string }
export type SceneAction = { type:'SET_FILTER'|'SHOW_LAYERS'|'FOCUS_REGION'|'HIGHLIGHT_ALERTS'|'COMPARE_PLANS'; payload:any }
export type MapFeature = {
  type: 'Feature'
  properties: { id: string; kind: 'wind_farm'|'turbine'|'substation'|'label'; name: string; status?: string; voltageKv?: number }
  geometry: { type: 'Point'|'Polygon'; coordinates: any }
}
export type MapFeatureCollection = { type: 'FeatureCollection'; features: MapFeature[] }
export type SimulationEntityType = 'transport_crew' | 'crane' | 'production_equipment' | 'storage_unit' | 'transmission_line' | 'wind_turbine_site'
export type SimulationEntity = {
  id: string
  type: SimulationEntityType
  name: string
  status: string
  position: [number, number]
  progress: number
  owner_id: string
  payload: Record<string, any>
  updated_at: string
}
export type SimulationState = { current_time: string; tick_count: number; step_hours: number }
export type SimulationTickResult = { state: SimulationState; entities: SimulationEntity[] }
export type SimulationTimeseries = {
  timestamps: string[]
  price_yuan_mwh: number[]
  load_mw: number[]
  gen_mw: number[]
  storage_delta: number[]
}
