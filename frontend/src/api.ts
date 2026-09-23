const BASE = ''
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...init })
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return response.json()
}
export const api = {
  overview: () => request<any>('/api/overview'),
  regions: () => request<any[]>('/api/regions'),
  windFarms: () => request<any[]>('/api/wind-farms'),
  realWindFarms: () => request<import('./types').RealWindFarm[]>('/api/realwind/farms'),
  realWindTurbines: (farmId: string) => request<import('./types').RealWindTurbine[]>(`/api/realwind/farms/${encodeURIComponent(farmId)}/turbines`),
  mapFeatures: (windFarmId?: string) =>
    request<any>(`/api/map-features${windFarmId ? `?wind_farm_id=${encodeURIComponent(windFarmId)}` : ''}`),
  turbines: (period: string, windFarmId?: string) =>
    request<any[]>(`/api/turbines?period=${encodeURIComponent(period)}${windFarmId ? `&wind_farm_id=${encodeURIComponent(windFarmId)}` : ''}`),
  turbineHistory: (turbineId: string) => request<TurbineHistory>(`/api/turbines/${encodeURIComponent(turbineId)}/history`),
  factories: () => request<any[]>('/api/factories'),
  projects: () => request<any[]>('/api/projects'),
  substations: () => request<any[]>('/api/substations'),
  alerts: () => request<any[]>('/api/alerts'),
  routes: () => request<any[]>('/api/transport-routes'),
  capacity: (period: string) => request<any[]>(`/api/production-capacity?period=${encodeURIComponent(period)}`),
  demands: () => request<any[]>('/api/demands'),
  createScenario: (body: any) => request<any>('/api/scenarios', { method: 'POST', body: JSON.stringify(body) }),
  runPlan: (id: number) => request<{scenarioId:number; plans:any[]}>(`/api/scenarios/${id}/plan`, { method: 'POST' }),
  aiCommand: (question: string, currentPeriod: string) => request<any>('/api/ai/command', { method: 'POST', body: JSON.stringify({ question, current_period: currentPeriod }) }),
  createReport: (body: any) => request<any>('/api/reports', { method: 'POST', body: JSON.stringify(body) }),
  simulationEntities: () => request<import('./types').SimulationEntity[]>('/api/simulation/entities'),
  simulationReset: (preset = 'nayong-72h') =>
    request<import('./types').SimulationTickResult>(`/api/simulation/reset?preset=${encodeURIComponent(preset)}`, { method: 'POST' }),
  simulationUpsert: (entity: import('./types').SimulationEntity) =>
    request<import('./types').SimulationEntity>('/api/simulation/entities', {
      method: 'POST',
      body: JSON.stringify(entity),
    }),
  simulationTick: (steps = 1, hourStep = 1) =>
    request<import('./types').SimulationTickResult>('/api/simulation/tick', { method: 'POST', body: JSON.stringify({ steps, hour_step: hourStep }) }),
  simulationTimeseries: (hours = 72) => request<import('./types').SimulationTimeseries>(`/api/simulation/timeseries?hours=${hours}`),
}

export type TurbineHistory = {
  turbine: { id: string; name: string; model: string; rated_power_kw: number; status: string }
  operations: Array<{ period: string; power_kw: number; wind_speed: number; availability: number; status: string }>
  alerts: Array<{ id: number; level: string; title: string; detail: string; occurred_at: string }>
}
