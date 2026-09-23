import { useCallback, useEffect, useMemo, useState } from 'react'
import TwinMap from '../components/TwinMap'
import Chart from '../components/Chart'
import { api } from '../api'
import type { AIResult, Alert, Factory, Plan, Project, RealWindFarm, RealWindTurbine, Region, Route, SceneAction, SimulationEntity, SimulationState, SimulationTimeseries, Substation, Turbine, WindFarm } from '../types'
import type { TurbineHistory } from '../api'

const ALL_LAYERS = { regions: false, heat: false, windFarms: true, farmBoundary: false, turbines: false, projects: false, factories: false, substations: true, routes: true, alerts: false, entities: true, powerFlow: true, realWind: false }
const DEFAULT_PERIOD = '2027-Q3'
const ROUTE_DASH_FRAMES = [[0, 2, 1.5, 0.5], [0.5, 1.5, 2, 0], [1, 1, 1.5, 0.5], [1.5, 0.5, 1, 1.5]]
const PLAYBACK_INTERVALS = { 1: 5000, 10: 500, 60: 120, 100: 40 } as const
const SIM_PRESETS = [
  { key: 'nayong-72h', label: '纳雍示范场 72h 全链路推演' },
  { key: 'urgent-48h', label: '抢装交付 48h 高节奏推演' },
  { key: 'storage-cycle-96h', label: '储能调节 96h 循环推演' },
] as const

export default function GisView() {
  const [overview, setOverview] = useState<any>(null)
  const [regions, setRegions] = useState<Region[]>([])
  const [farms, setFarms] = useState<WindFarm[]>([])
  const [allTurbines, setAllTurbines] = useState<Turbine[]>([])
  const [factories, setFactories] = useState<Factory[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [substations, setSubstations] = useState<Substation[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [entities, setEntities] = useState<SimulationEntity[]>([])
  const [realFarms, setRealFarms] = useState<RealWindFarm[]>([])
  const [realTurbines, setRealTurbines] = useState<RealWindTurbine[]>([])
  const [simulationState, setSimulationState] = useState<SimulationState | null>(null)
  const [timeseries, setTimeseries] = useState<SimulationTimeseries | null>(null)
  const [selectedEntity, setSelectedEntity] = useState<SimulationEntity | null>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<1 | 10 | 60 | 100>(1)
  const [presetKey, setPresetKey] = useState<(typeof SIM_PRESETS)[number]['key']>('nayong-72h')
  const [jumpHours, setJumpHours] = useState(24)
  const [simError, setSimError] = useState('')
  const [period, setPeriod] = useState(DEFAULT_PERIOD)
  const [layers, setLayers] = useState({ ...ALL_LAYERS })
  const [filters, setFilters] = useState<any>({})
  const [focusRegion, setFocusRegion] = useState<string | null>(null)
  const [focusFarm, setFocusFarm] = useState<string | null>(null)
  const [selectedTurbine, setSelectedTurbine] = useState<Turbine | null>(null)
  const [turbineHistory, setTurbineHistory] = useState<TurbineHistory | null>(null)
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [scenario, setScenario] = useState({ name: '华北 2027—2029', region_id: 'north-china', start_year: 2027, end_year: 2029, demand_mw: 1200, objective: 'balanced' })
  const [activeScenarioId, setActiveScenarioId] = useState<number | null>(null)
  const [plans, setPlans] = useState<Plan[]>([])
  const [activePlanKey, setActivePlanKey] = useState<string>('A')
  const [ai, setAi] = useState<AIResult | null>(null)
  const [question, setQuestion] = useState('分析华北未来三年风电项目需求和产能匹配情况')
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')
  const [collapsed, setCollapsed] = useState({ left: false, right: false })
  const togglePanel = (key: 'left' | 'right') => setCollapsed(current => ({ ...current, [key]: !current[key] }))

  useEffect(() => {
    let mounted = true
    async function load() {
      const overview = await api.overview()
      const initialPeriod = overview.periods?.includes(period) ? period : overview.periods?.[0] ?? DEFAULT_PERIOD
      const [rg, wf, tf, fc, pr, ss, rt, al] = await Promise.all([
        api.regions(), api.windFarms(), api.turbines(initialPeriod), api.factories(),
        api.projects(), api.substations(), api.routes(), api.alerts(),
      ])
      const [simulationResult, simulationTimeseries] = await Promise.all([
        api.simulationReset('nayong-72h'), api.simulationTimeseries(72),
      ])
      api.realWindFarms().then(value => { if (mounted) setRealFarms(value) }).catch(() => undefined)
      if (!mounted) return
      setOverview(overview); setPeriod(initialPeriod); setRegions(rg); setFarms(wf); setAllTurbines(tf); setFactories(fc); setProjects(pr)
      setSubstations(ss); setRoutes(rt); setAlerts(al)
      setEntities(simulationResult.entities); setSimulationState(simulationResult.state)
      setTimeseries(simulationTimeseries)
      setFocusRegion('north-china'); setFocusFarm('wf-nayong'); setPlaying(true)
    }
    load().catch(() => setToast('后端服务未连接，请先启动 API'))
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (!layers.realWind || realTurbines.length || !realFarms.length) return
    let mounted = true
    Promise.all(realFarms.map(farm => api.realWindTurbines(farm.id)))
      .then(values => { if (mounted) setRealTurbines(values.flat()) })
      .catch(() => { if (mounted) setToast('USGS 实测风场加载失败') })
    return () => { mounted = false }
  }, [layers.realWind, realFarms, realTurbines.length])

  const loadPeriod = useCallback(async (value: string) => {
    setPeriod(value)
    setBusy('更新时间断面')
    const turbines = await api.turbines(value)
    setAllTurbines(turbines)
    setBusy('')
  }, [])

  useEffect(() => {
    if (!selectedTurbine) {
      setTurbineHistory(null)
      return
    }
    let mounted = true
    setTurbineHistory(null)
    api.turbineHistory(selectedTurbine.id)
      .then(result => { if (mounted) setTurbineHistory(result) })
      .catch(() => { if (mounted) setTurbineHistory(null) })
    return () => { mounted = false }
  }, [selectedTurbine])

  const activePlan = useMemo(() => plans.find(plan => plan.plan_key === activePlanKey) ?? null, [plans, activePlanKey])
  const selectedFarm = useMemo(() => farms.find(f => f.id === focusFarm) ?? null, [farms, focusFarm])
  const provinceFarms = useMemo(() => focusRegion ? farms.filter(f => f.region_id === focusRegion) : farms, [farms, focusRegion])
  const scopedFarmIds = useMemo(() => new Set(provinceFarms.map(f => f.id)), [provinceFarms])
  const level: 'country' | 'province' | 'farm' = focusFarm ? 'farm' : focusRegion ? 'province' : 'country'
  const farmLivePower = useMemo(() => focusFarm
    ? allTurbines.filter(t => t.wind_farm_id === focusFarm).reduce((sum, t) => sum + (t.operation?.power_kw ?? 0), 0) / 1000
    : 0, [allTurbines, focusFarm])
  const filteredTurbines = useMemo(() => allTurbines.filter(t => {
    if (focusFarm && t.wind_farm_id !== focusFarm) return false
    if (!focusFarm && !focusRegion && false) return false
    if (filters.regionId && t.regionId !== filters.regionId) return false
    if (filters.status && t.status !== filters.status) return false
    if (filters.onlyAlert && !alerts.some(a => a.source_id === t.id)) return false
    return true
  }), [allTurbines, filters, alerts, focusFarm])

  const filteredProjects = useMemo(() => projects.filter(p => {
    if (level === 'farm') return false
    if (level === 'province' && !scopedFarmIds.has(p.region_id) && p.region_id !== focusRegion) return false
    if (filters.regionId && p.region_id !== filters.regionId) return false
    if (filters.minCapacity && p.capacity_mw < filters.minCapacity) return false
    if (filters.status && p.status !== filters.status) return false
    return true
  }), [projects, filters, level, focusRegion, scopedFarmIds])

  const visibleRoutes = useMemo(() => {
    if (!activePlan) return routes
    const keys = new Set(activePlan.allocations.map(a => `${a.factory_id}:${a.project_id}`))
    return routes.filter(route => keys.has(`${route.factory_id}:${route.project_id}`))
  }, [routes, activePlan])

  const currentPower = filteredTurbines.reduce((sum, t) => sum + (t.operation?.power_kw ?? 0), 0) / 1000
  const currentPeriodCapacity = activePlan?.metrics?.allocated_mw ?? filteredProjects.reduce((s, p) => s + p.capacity_mw, 0)
  const planA = plans.find(p => p.plan_key === 'A')
  const planB = plans.find(p => p.plan_key === 'B')
  const planC = plans.find(p => p.plan_key === 'C')

  const drillRegion = (id: string) => {
    const region = regions.find(r => r.id === id)
    if (!region) return
    if (region.level === 'province') setFocusRegion(id)
  }
  const drillFarm = (id: string) => setFocusFarm(id)
  const breadcrumbTo = (target: 'country' | 'province' | 'farm') => {
    if (target === 'country') { setFocusFarm(null); setFocusRegion(null) }
    else if (target === 'province') setFocusFarm(null)
  }

  const applyActions = (actions: SceneAction[]) => {
    for (const action of actions) {
      if (action.type === 'SET_FILTER') setFilters(action.payload)
      if (action.type === 'SHOW_LAYERS') {
        const next = Object.fromEntries(Object.keys(ALL_LAYERS).map(key => [key, action.payload.layers.includes(key)])) as typeof ALL_LAYERS
        setLayers(next)
      }
      if (action.type === 'FOCUS_REGION') setFocusRegion(action.payload.regionId)
      if (action.type === 'HIGHLIGHT_ALERTS') setLayers(current => ({ ...current, alerts: action.payload.enabled !== false, turbines: true }))
      if (action.type === 'COMPARE_PLANS' && plans.length) setActivePlanKey(action.payload.plans?.[0] ?? 'A')
    }
  }

  const runAI = async () => {
    setBusy('AI 分析中')
    try {
      const result = await api.aiCommand(question, period)
      setAi(result); applyActions(result.actions)
      const focusAction = result.actions.find((a: SceneAction) => a.type === 'FOCUS_REGION')
      if (focusAction) setFocusRegion(focusAction.payload.regionId ?? null)
      setToast(`已执行场景操作 · ${result.source === 'llm' ? 'LLM' : '规则引擎'}`)
    } catch (error) { setToast('AI 分析失败') }
    setBusy('')
  }

  const runPlanning = async () => {
    setBusy('规划计算中')
    try {
      const created = await api.createScenario(scenario)
      setActiveScenarioId(created.id)
      const result = await api.runPlan(created.id)
      setPlans(result.plans); setActivePlanKey('A'); setToast('已生成 Plan A/B/C 并同步 3D')
    } catch (error) { setToast('规划失败，请检查后端') }
    setBusy('')
  }

  const generateReport = async () => {
    setBusy('生成报告')
    try {
      const report = await api.createReport({
        title: '华北风电产能规划分析报告', report_type: '产能规划', question,
        scenario_id: activeScenarioId,
      })
      window.open(`/api/reports/${report.id}/html`, '_blank')
      setToast('报告已打开，使用浏览器打印可导出 PDF')
    } catch (error) { setToast('报告生成失败') }
    setBusy('')
  }

  const applySimulationResult = (result: import('../types').SimulationTickResult) => {
    setEntities(result.entities)
    setSimulationState(result.state)
    setSelectedEntity(current => result.entities.find(entity => entity.id === current?.id) ?? null)
    return result
  }

  const simulationHour = simulationState ? Math.max(0, simulationState.tick_count * simulationState.step_hours) : 0

  const selectPreset = async (key: typeof presetKey) => {
    setPresetKey(key); setBusy('重置推演场景')
    try {
      const result = applySimulationResult(await api.simulationReset(key))
      if (key === 'storage-cycle-96h') setSelectedEntity(result.entities.find(entity => entity.type === 'storage_unit') ?? null)
      if (key === 'nayong-72h') {
        setFocusRegion('north-china'); setFocusFarm('wf-nayong')
        setLayers({ ...ALL_LAYERS })
      }
      setSimError(''); setPlaying(true)
    } catch { setSimError('场景重置失败') }
    setBusy('')
  }

  const replayFromZero = async () => {
    setBusy('回到 0 点')
    try {
      applySimulationResult(await api.simulationReset(presetKey))
      setSimError(''); setPlaying(true)
    } catch { setSimError('回放重置失败') }
    setBusy('')
  }

  const jumpToHour = async () => {
    const target = Math.max(0, Math.floor(jumpHours))
    setBusy(`跳转 T+${target}h`)
    try {
      if (target < simulationHour) applySimulationResult(await api.simulationReset(presetKey))
      if (target > simulationHour) {
        const result = applySimulationResult(await api.simulationTick(1, target - simulationHour))
        setTimeseries(await api.simulationTimeseries(72))
        void result
      }
      if (target === simulationHour) applySimulationResult(await api.simulationReset(presetKey))
      setSimError('')
    } catch { setSimError('时刻跳转失败') }
    setBusy('')
  }

  const updateEntityPayload = async (patch: Record<string, any>) => {
    if (!selectedEntity) return
    const next: SimulationEntity = { ...selectedEntity, payload: { ...selectedEntity.payload, ...patch } }
    setSelectedEntity(next)
    try {
      const updated = await api.simulationUpsert(next)
      setEntities(current => current.map(entity => entity.id === updated.id ? updated : entity))
      setSelectedEntity(updated)
      setSimError('')
    } catch { setSimError('干预写入失败') }
  }

  useEffect(() => {
    if (!playing) return
    let active = true
    const advance = async () => {
      try {
        const result = await api.simulationTick(1, 1)
        const series = await api.simulationTimeseries(72)
        if (!active) return
        setEntities(result.entities)
        setSimulationState(result.state)
        setTimeseries(series)
        setSimError('')
        setSelectedEntity(current => result.entities.find(entity => entity.id === current?.id) ?? current)
      } catch {
        if (active) { setPlaying(false); setSimError('推演服务连接失败') }
      }
    }
    advance()
    const timer = window.setInterval(advance, PLAYBACK_INTERVALS[speed])
    return () => { active = false; window.clearInterval(timer) }
  }, [playing, speed])

  const status = overview?.statusCounts ?? {}
  const entityLabel = (entity: SimulationEntity) => ({
    transport_crew: '运输队', crane: '吊装机', production_equipment: '生产设备',
    storage_unit: '储能', transmission_line: '输电线路', wind_turbine_site: '机位',
  }[entity.type] ?? entity.type)
  const ownerLabel = selectedEntity ? selectedEntity.target_id ?? selectedEntity.id : '—'
  const priceOption = useMemo(() => ({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', valueFormatter: (value: number) => `${value?.toFixed(1)} 元/MWh` },
    legend: { data: ['小时电价'], textStyle: { color: '#7ea8bd', fontSize: 10 }, right: 4, top: 0, itemWidth: 12, itemHeight: 6 },
    grid: { left: 40, right: 10, top: 22, bottom: 22 },
    xAxis: { type: 'category', boundaryGap: false, data: (timeseries?.timestamps ?? []).map(value => new Date(value).toISOString().slice(5, 16).replace('T', ' ')), axisLine: { lineStyle: { color: 'rgba(125,211,252,.25)' } }, axisLabel: { color: '#67879b', fontSize: 9 } },
    yAxis: { type: 'value', name: '元/MWh', nameTextStyle: { color: '#67879b' }, axisLabel: { color: '#67879b', fontSize: 9 }, splitLine: { lineStyle: { color: 'rgba(125,211,252,.08)' } } },
    series: [{
      name: '小时电价', type: 'line', smooth: true, symbol: 'none',
      lineStyle: { width: 2, color: '#facc15', shadowColor: 'rgba(250,204,21,.36)', shadowBlur: 12 },
      areaStyle: { color: 'rgba(250,204,21,.13)' },
      data: timeseries?.price_yuan_mwh ?? [],
      markPoint: timeseries?.price_yuan_mwh?.length ? { data: [{ coord: [0, timeseries.price_yuan_mwh[0]], value: timeseries.price_yuan_mwh[0].toFixed(0) }], symbolSize: 42, itemStyle: { color: '#facc15' }, label: { color: '#04121e', fontSize: 9 } } : undefined,
    }],
  }), [timeseries])
  return (
    <div className="app-shell">
      <TwinMap
        regions={regions} farms={farms} turbines={layers.turbines ? filteredTurbines : []}
        factories={factories} projects={filteredProjects} substations={substations}
        routes={visibleRoutes} alerts={alerts} activePlan={activePlan} layers={layers} period={period}
        entities={entities} selectedEntityId={selectedEntity?.id}
        realFarms={realFarms} realTurbines={layers.realWind ? realTurbines : []}
        focusRegion={focusRegion} focusFarm={focusFarm}
        onSelectTurbine={setSelectedTurbine} onSelectProject={setSelectedProject}
        onSelectRegion={drillRegion} onSelectFarm={drillFarm}
        onSelectEntity={setSelectedEntity}
      />

      <div className="level-crumbs">
        <button className={!focusRegion && !focusFarm ? 'active' : ''} onClick={() => breadcrumbTo('country')}>中国</button>
        {focusRegion && <><span>›</span><button className={!focusFarm ? 'active' : ''} onClick={() => breadcrumbTo('province')}>{regions.find(r => r.id === focusRegion)?.name}</button></>}
        {focusFarm && <><span>›</span><button className={focusFarm ? 'active' : ''}>{selectedFarm?.name}</button></>}
      </div>

      <header className="topbar">
        <div className="brand"><span>WIND TWIN</span><small>风电规划数字孪生</small></div>
        <div className="kpis">
          <div className="kpi"><label>运行 / 预警 / 故障</label><b>{status.running ?? 0} / {status.warning ?? 0} / {status.fault ?? 0}</b></div>
          <div className="kpi"><label>当前功率</label><b>{currentPower.toFixed(1)} MW</b></div>
          <div className="kpi"><label>项目容量</label><b>{currentPeriodCapacity.toLocaleString()} MW</b></div>
          <div className="kpi"><label>规划方案</label><b>{activePlan ? activePlan.plan_key : '—'}</b></div>
        </div>
        <div className="timeline">
          <input type="range" min="0" max={(overview?.periods?.length ?? 20) - 1} value={overview?.periods?.indexOf(period) ?? 10} onChange={event => loadPeriod(overview.periods[event.target.value])} />
          <span>{period}</span>
        </div>
      </header>

      <div className="sim-control">
        <button className={playing ? 'active' : ''} onClick={() => setPlaying(value => !value)}>{playing ? '暂停' : '播放'}</button>
        <div className="speed-group" role="group" aria-label="推演速度">
          {([1, 10, 60, 100] as const).map(value => (
            <button key={value} className={speed === value ? 'active' : ''} onClick={() => setSpeed(value)}>{value}x</button>
          ))}
        </div>
        <select aria-label="场景预设" value={presetKey} onChange={event => selectPreset(event.target.value as typeof presetKey)}>
          {SIM_PRESETS.map(preset => <option key={preset.key} value={preset.key}>{preset.label}</option>)}
        </select>
        <button onClick={replayFromZero}>回到 0 点重放</button>
        <span className="jump-group">
          <input aria-label="目标小时" type="number" min={0} max={8760} value={jumpHours} onChange={event => setJumpHours(Number(event.target.value))} />
          <button onClick={jumpToHour}>跳转</button>
        </span>
        <small>{simulationState ? `T+${simulationState.tick_count}h` : '准备'}</small>
        {simError && <b>{simError}</b>}
      </div>

      <aside className={`panel left${collapsed.left ? ' collapsed' : ''}`}>
        <button className="panel-toggle" onClick={() => togglePanel('left')} aria-label="折叠左侧面板">‹</button>
        {collapsed.left ? (
          <button className="panel-collapsed-hint" onClick={() => togglePanel('left')}>图层 / 沙盘 / 对比</button>
        ) : (
        <>
        <section>
          <h2>图层控制</h2>
          <div className="layer-grid">
            {Object.entries(layers).map(([key, value]) => (
              <button key={key} className={value ? 'active' : ''} onClick={() => setLayers(current => ({ ...current, [key]: !value }))}>
                {{ regions: '行政区', heat: '区域热力', windFarms: '风场', farmBoundary: '风场边界', turbines: '风机', projects: '项目', factories: '工厂', substations: '升压站', routes: '物流', alerts: '告警', entities: '实体', powerFlow: '电力流', realWind: 'USGS 实测风场' }[key]}
              </button>
            ))}
          </div>
        </section>
        <section>
          <h2>规划沙盘</h2>
          <label>方案名称<input value={scenario.name} onChange={e => setScenario({ ...scenario, name: e.target.value })} /></label>
          <div className="grid2">
            <label>起始年<input type="number" value={scenario.start_year} onChange={e => setScenario({ ...scenario, start_year: +e.target.value })} /></label>
            <label>结束年<input type="number" value={scenario.end_year} onChange={e => setScenario({ ...scenario, end_year: +e.target.value })} /></label>
          </div>
          <label>需求 MW<input type="number" value={scenario.demand_mw} onChange={e => setScenario({ ...scenario, demand_mw: +e.target.value })} /></label>
          <label>目标<select value={scenario.objective} onChange={e => setScenario({ ...scenario, objective: e.target.value })}>
            <option value="balanced">产能均衡</option><option value="logistics_cost">物流成本</option><option value="delivery_risk">交付风险</option>
          </select></label>
          <button className="primary" onClick={runPlanning}>生成 Plan A / B / C</button>
          {plans.length > 0 && (
            <div className="plan-tabs">
              {plans.map(plan => <button key={plan.plan_key} className={activePlanKey === plan.plan_key ? 'active' : ''} onClick={() => setActivePlanKey(plan.plan_key)}>{plan.plan_key}</button>)}
            </div>
          )}
          {activePlan && (
            <div className="metric-list">
              <span>分配 <b>{activePlan.metrics.allocated_mw} MW</b></span>
              <span>运距 <b>{activePlan.metrics.avg_distance_km} km</b></span>
              <span>风险 <b>{activePlan.metrics.delivery_risk}</b></span>
              <span>交付 <b>{activePlan.metrics.avg_lead_time_days} 天</b></span>
            </div>
          )}
        </section>
        <section>
          <h2>方案对比</h2>
          <table><thead><tr><th>方案</th><th>运距</th><th>风险</th><th>得分</th></tr></thead><tbody>
            {[planA, planB, planC].filter(Boolean).map(plan => (
              <tr key={plan!.plan_key} className={activePlanKey === plan!.plan_key ? 'active' : ''} onClick={() => setActivePlanKey(plan!.plan_key)}>
                <td>{plan!.plan_key}</td><td>{plan!.metrics.avg_distance_km}</td><td>{plan!.metrics.delivery_risk}</td><td>{plan!.score}</td>
              </tr>
            ))}
          </tbody></table>
        </section>
        </>
        )}
      </aside>

      <aside className={`panel right${collapsed.right ? ' collapsed' : ''}`}>
        <button className="panel-toggle" onClick={() => togglePanel('right')} aria-label="折叠右侧面板">›</button>
        {collapsed.right ? (
          <button className="panel-collapsed-hint" onClick={() => togglePanel('right')}>分析 / 产能</button>
        ) : (
        <>
        {selectedEntity && (
          <section>
            <h2>实体详情</h2>
            <div className="entity-detail">
              <div className="entity-detail-head">
                <div><small>{entityLabel(selectedEntity)}</small><b>{selectedEntity.id}</b></div>
                <button onClick={() => setSelectedEntity(null)}>×</button>
              </div>
              <div className="entity-meta">
                <span>状态<i>{selectedEntity.status}</i></span>
                <span>进度<i>{selectedEntity.progress.toFixed(1)}%</i></span>
                <span>归属<i title={ownerLabel}>{ownerLabel}</i></span>
              </div>
              <div className="progress-track"><i style={{ width: `${Math.max(0, Math.min(100, selectedEntity.progress))}%` }} /></div>
              {selectedEntity.type === 'storage_unit' && (
                <div className="soc-meter">
                  <div className="soc-column" aria-label="SOC 液柱">
                    <i style={{ height: `${Math.max(2, Math.min(100, Number(selectedEntity.payload?.soc ?? 0) * 100))}%` }} />
                  </div>
                  <div className="soc-detail">
                    <label>SOC <b>{(Number(selectedEntity.payload?.soc ?? 0) * 100).toFixed(1)}%</b></label>
                    <b className={selectedEntity.payload?.mode}>
                      {{ charge: '↑ 充电', discharge: '↓ 放电', idle: '· 闲置' }[selectedEntity.payload?.mode as string] ?? '· 闲置'}
                    </b>
                    <span>{Number(selectedEntity.payload?.delta_mw ?? 0).toFixed(2)} MW</span>
                  </div>
                </div>
              )}
              {selectedEntity.type === 'production_equipment' && (
                <div className="intervention-row">
                  <button onClick={() => updateEntityPayload({ paused: false, status: 'producing' })}>恢复生产</button>
                  <button onClick={() => updateEntityPayload({ paused: true, status: 'paused' })}>暂停生产</button>
                </div>
              )}
              {selectedEntity.type === 'transport_crew' && (
                <div className="intervention-row">
                  <button onClick={() => updateEntityPayload({ speed_km_h: Math.min(120, Number(selectedEntity.payload.speed_km_h ?? 35) * 1.35) })}>加速 35%</button>
                  <button onClick={() => updateEntityPayload({ speed_km_h: Math.max(15, Number(selectedEntity.payload.speed_km_h ?? 35) / 1.35) })}>减速 26%</button>
                </div>
              )}
              <pre>{JSON.stringify(selectedEntity.payload, null, 2)}</pre>
            </div>
          </section>
        )}
        <section>
          <h2>AI 场景分析</h2>
          <textarea value={question} onChange={e => setQuestion(e.target.value)} rows={3} />
          <div className="action-row"><button className="primary" onClick={runAI}>执行分析</button><button onClick={generateReport}>生成报告</button></div>
          {ai && <div className="ai-answer"><p>{ai.answer}</p><Chart option={ai.charts[0]?.option ?? {}} height={200} /><Chart option={ai.charts[1]?.option ?? {}} height={190} /></div>}
        </section>
        <section>
          <h2>区域产能</h2>
          <Chart option={{
            backgroundColor: 'transparent', tooltip: { trigger: 'axis' },
            xAxis: { type: 'category', data: factories.map(f => f.name[0] + f.id.slice(2)) },
            yAxis: { type: 'value' }, series: [{ type: 'bar', barWidth: 24, data: factories.map(f => f.annual_capacity_mw), itemStyle: { color: '#38bdf8' } }],
          }} height={190} />
        </section>
        </>
        )}
      </aside>

      {selectedFarm && (
        <div className="farm-detail-card">
          <div className="farm-detail-head">
            <div><small>{regions.find(r => r.id === selectedFarm.region_id)?.name ?? selectedFarm.region_id}</small><h3>{selectedFarm.name}</h3></div>
            <button onClick={() => setFocusFarm(null)}>×</button>
          </div>
          <div className="detail-grid">
            <div><span>装机容量</span><b>{selectedFarm.capacityMw.toFixed(1)} MW</b></div>
            <div><span>机组数量</span><b>{selectedFarm.turbineCount} 台</b></div>
            <div><span>实时功率</span><b>{farmLivePower.toFixed(2)} MW</b></div>
            <div><span>海拔</span><b>{selectedFarm.elevation_m} m</b></div>
            <div><span>运行</span><b className="ok">{selectedFarm.statusCounts.running ?? 0}</b></div>
            <div><span>预警 / 故障</span><b className="warn-text">{selectedFarm.statusCounts.warning ?? 0} / {selectedFarm.statusCounts.fault ?? 0}</b></div>
          </div>
        </div>
      )}

      {selectedTurbine && (
        <div className="detail-modal" onClick={() => setSelectedTurbine(null)}>
          <div className="detail-card" onClick={event => event.stopPropagation()}>
            <div className="detail-head"><div><small>{selectedTurbine.windFarmName}</small><h3>{selectedTurbine.name}</h3></div><button onClick={() => setSelectedTurbine(null)}>×</button></div>
            <div className="detail-grid">
              <div><span>状态</span><b>{selectedTurbine.status}</b></div>
              <div><span>功率</span><b>{((selectedTurbine.operation?.power_kw ?? 0) / 1000).toFixed(2)} MW</b></div>
              <div><span>风速</span><b>{selectedTurbine.operation?.wind_speed ?? '—'} m/s</b></div>
              <div><span>可用率</span><b>{((selectedTurbine.operation?.availability ?? 0) * 100).toFixed(1)}%</b></div>
              <div><span>机型</span><b>{selectedTurbine.model}</b></div>
              <div><span>额定</span><b>{selectedTurbine.rated_power_kw} kW</b></div>
            </div>
            <Chart option={{
              backgroundColor: 'transparent',
              tooltip: { trigger: 'axis' },
              grid: { left: 46, right: 18, top: 28, bottom: 28 },
              xAxis: { type: 'category', data: (turbineHistory?.operations ?? []).map(item => item.period) },
              yAxis: { type: 'value', name: 'MW' },
              series: [{
                name: '功率曲线', type: 'line', smooth: true, areaStyle: { color: 'rgba(56,189,248,.16)' },
                data: (turbineHistory?.operations ?? []).map(item => Number((item.power_kw / 1000).toFixed(2))),
              }],
            }} height={190} />
            <div className="detail-alerts">
              {(turbineHistory?.alerts ?? []).map(alert => (
                <article key={alert.id}>
                  <i className={alert.level === 'critical' ? 'fault' : 'warn'} />
                  <div><b>{alert.title}</b><span>{alert.detail}</span></div>
                </article>
              ))}
              {!turbineHistory?.alerts?.length && <p className="empty">当前周期无未消除告警</p>}
            </div>
          </div>
        </div>
      )}
      {selectedProject && (
        <div className="detail-modal" onClick={() => setSelectedProject(null)}>
          <div className="detail-card" onClick={event => event.stopPropagation()}>
            <div className="detail-head"><div><small>{selectedProject.region_id}</small><h3>{selectedProject.name}</h3></div><button onClick={() => setSelectedProject(null)}>×</button></div>
            <div className="detail-grid">
              <div><span>容量</span><b>{selectedProject.capacity_mw} MW</b></div><div><span>阶段</span><b>{selectedProject.phase}</b></div>
              <div><span>规划年</span><b>{selectedProject.planned_year}</b></div><div><span>交付年</span><b>{selectedProject.delivery_year}</b></div>
            </div>
          </div>
        </div>
      )}
      {(busy || toast) && <div className="status-toast">{busy || toast}</div>}
      <section className="price-strip">
        <div className="price-head">
          <span>电力现货小时电价</span>
          <b>{timeseries?.price_yuan_mwh?.[0] != null ? `${timeseries.price_yuan_mwh[0].toFixed(1)} 元/MWh` : '—'}</b>
        </div>
        <Chart option={priceOption} height={104} />
      </section>
    </div>
  )
}
