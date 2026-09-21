import { useCallback, useEffect, useMemo, useState } from 'react'
import TwinMap from '../components/TwinMap'
import Chart from '../components/Chart'
import { api } from '../api'
import type { AIResult, Alert, Factory, Plan, Project, Region, Route, SceneAction, Substation, Turbine, WindFarm } from '../types'
import type { TurbineHistory } from '../api'

const ALL_LAYERS = { regions: true, heat: true, windFarms: true, turbines: true, projects: true, factories: true, substations: true, routes: true, alerts: true }
const DEFAULT_PERIOD = '2027-Q3'
const ROUTE_DASH_FRAMES = [[0, 2, 1.5, 0.5], [0.5, 1.5, 2, 0], [1, 1, 1.5, 0.5], [1.5, 0.5, 1, 1.5]]

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
  const [period, setPeriod] = useState(DEFAULT_PERIOD)
  const [layers, setLayers] = useState({ ...ALL_LAYERS })
  const [filters, setFilters] = useState<any>({})
  const [focusRegion, setFocusRegion] = useState<string | null>(null)
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

  useEffect(() => {
    let mounted = true
    async function load() {
      const [ov, rg, wf, tf, fc, pr, ss, rt, al] = await Promise.all([
        api.overview(), api.regions(), api.windFarms(), api.turbines(DEFAULT_PERIOD), api.factories(),
        api.projects(), api.substations(), api.routes(), api.alerts(),
      ])
      if (!mounted) return
      setOverview(ov); setRegions(rg); setFarms(wf); setAllTurbines(tf); setFactories(fc); setProjects(pr)
      setSubstations(ss); setRoutes(rt); setAlerts(al)
    }
    load().catch(() => setToast('后端服务未连接，请先启动 API'))
    return () => { mounted = false }
  }, [])

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
  const filteredTurbines = useMemo(() => allTurbines.filter(t => {
    if (filters.regionId && t.regionId !== filters.regionId) return false
    if (filters.status && t.status !== filters.status) return false
    if (filters.onlyAlert && !alerts.some(a => a.source_id === t.id)) return false
    return true
  }), [allTurbines, filters, alerts])

  const filteredProjects = useMemo(() => projects.filter(p => {
    if (filters.regionId && p.region_id !== filters.regionId) return false
    if (filters.minCapacity && p.capacity_mw < filters.minCapacity) return false
    if (filters.status && p.status !== filters.status) return false
    return true
  }), [projects, filters])

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

  const status = overview?.statusCounts ?? {}
  return (
    <div className="app-shell">
      <TwinMap
        regions={regions} farms={farms} turbines={layers.turbines ? filteredTurbines : []}
        factories={factories} projects={filteredProjects} substations={substations}
        routes={visibleRoutes} alerts={alerts} activePlan={activePlan} layers={layers} period={period}
        focusRegion={focusRegion} onSelectTurbine={setSelectedTurbine} onSelectProject={setSelectedProject}
      />

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

      <aside className="panel left">
        <section>
          <h2>图层控制</h2>
          <div className="layer-grid">
            {Object.entries(layers).map(([key, value]) => (
              <button key={key} className={value ? 'active' : ''} onClick={() => setLayers(current => ({ ...current, [key]: !value }))}>
                {{ regions: '行政区', heat: '区域热力', windFarms: '风场', turbines: '风机', projects: '项目', factories: '工厂', substations: '升压站', routes: '物流', alerts: '告警' }[key]}
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
      </aside>

      <aside className="panel right">
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
      </aside>

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
    </div>
  )
}
