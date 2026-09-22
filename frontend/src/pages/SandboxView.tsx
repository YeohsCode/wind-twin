import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import SandboxScene, { type SceneTurbine, type TerrainState } from '../sandbox/SandboxScene'
import Chart from '../components/Chart'
import { api } from '../api'
import { loadDemCached } from '../sandbox/dem'
import { createSceneProjection, projectToScene, setTerrainScene } from '../sandbox/terrain'
import type { Alert, MapFeatureCollection, Turbine, WindFarm } from '../types'

type ViewMode = 'overview' | 'top' | 'side' | 'orbit'
type BaseTurbine = Turbine & { x: number; z: number }
type FarmOption = Pick<WindFarm, 'id' | 'name' | 'turbineCount'> & { lat: number; lng: number }
const DEFAULT_PERIOD = '2027-Q3'

function phase(id: string) {
  let value = 0
  for (const char of id) value = (value * 31 + char.charCodeAt(0)) % 997
  return value / 997
}

function projectTurbines(turbines: Turbine[]): BaseTurbine[] {
  const projection = createSceneProjection(turbines)
  return turbines.map(turbine => ({ ...turbine, ...projectToScene(turbine.lat, turbine.lng, projection) }))
}

function liveTurbine(turbine: BaseTurbine, index: number, seconds: number): SceneTurbine {
  const seed = phase(turbine.id) + index * 0.173
  const operationPower = turbine.operation?.power_kw ?? turbine.rated_power_kw * 0.74
  const operationWindSpeed = turbine.operation?.wind_speed ?? 8.2
  const wave = 0.82 + 0.14 * Math.sin(seconds * 0.16 + seed * 6.283) + 0.05 * Math.sin(seconds * 0.43 + seed * 12)
  const statusFactor = turbine.status === 'fault' ? 0.05 : turbine.status === 'warning' ? 0.58 : 1
  const powerKw = operationPower * wave * statusFactor
  return {
    id: turbine.id,
    displayId: `WT-${String(index + 1).padStart(2, '0')}`,
    status: turbine.status,
    ratedPowerKw: turbine.rated_power_kw,
    liveMw: Math.max(0, powerKw / 1000),
    windSpeed: Math.max(2.2, operationWindSpeed + 0.45 * Math.sin(seconds * 0.08 + seed * 4)),
    rotorRpm: turbine.status === 'fault' ? 0 : 8.2 + 4.6 * Math.max(0, powerKw / turbine.rated_power_kw),
    lat: turbine.lat,
    lng: turbine.lng,
    x: turbine.x,
    z: turbine.z,
  }
}

const STATUS_TEXT = { running: '运行', warning: '预警', fault: '故障' } as const

export default function SandboxView({ onNavigate }: { onNavigate: (route: 'sandbox' | 'gis') => void }) {
  const [farms, setFarms] = useState<FarmOption[]>([])
  const [baseTurbines, setBaseTurbines] = useState<BaseTurbine[]>([])
  const [periods, setPeriods] = useState<string[]>([])
  const [period, setPeriod] = useState(DEFAULT_PERIOD)
  const [periodLoading, setPeriodLoading] = useState(true)
  const [selectedFarmId, setSelectedFarmId] = useState('')
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loadError, setLoadError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [night, setNight] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('overview')
  const [basemapMode, setBasemapMode] = useState<'current' | 'street' | 'satellite'>('current')
  const [mapFeatures, setMapFeatures] = useState<MapFeatureCollection | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null)
  const [tick, setTick] = useState(() => Date.now())
  const [terrainVersion, setTerrainVersion] = useState(0)
  const [terrainState, setTerrainState] = useState<TerrainState>({
    version: 0, status: 'procedural', sourceText: 'PROCEDURAL · INITIALIZING',
  })
  const [terrainNotice, setTerrainNotice] = useState('')
  const demAbortRef = useRef<AbortController | null>(null)
  const terrainVersionRef = useRef(0)
  const periodRequestRef = useRef(0)

  const showFarm = useCallback(async (farmId: string, farmTurbines: Turbine[], periodValue: string) => {
    demAbortRef.current?.abort()
    const controller = new AbortController()
    demAbortRef.current = controller
    const projected = projectTurbines(farmTurbines)
    setBaseTurbines(projected)
    setSelectedId(current => current && projected.some(item => item.id === current)
      ? current
      : projected.find(item => item.status === 'warning')?.id ?? projected[0]?.id ?? null)
    setSelectedFarmId(farmId)
    setMapFeatures(null)
    setTerrainNotice('')
    terrainVersionRef.current += 1
    setTerrainState({ version: terrainVersionRef.current, status: 'loading', sourceText: `${farmId.toUpperCase()} · LOADING DEM` })
    setTerrainVersion(terrainVersionRef.current)
    try {
      const result = await loadDemCached(farmTurbines, `${farmId}:${periodValue}`, controller.signal)
      if (controller.signal.aborted) return
      const gridProjection = result.grid.projection
      const projectedForGrid = projected.map(turbine => ({
        ...turbine,
        ...projectToScene(turbine.lat, turbine.lng, gridProjection),
      }))
      setTerrainScene(result.grid, gridProjection, projectedForGrid)
      setBaseTurbines(projectedForGrid)
      terrainVersionRef.current += 1
      setTerrainState({
        version: terrainVersionRef.current,
        status: 'dem',
        sourceText: `REAL DEM · Z${result.zoom} · ${result.tileCount} TILES · ${farmId.toUpperCase()}`,
      })
      setTerrainVersion(terrainVersionRef.current)
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
      const projection = createSceneProjection(farmTurbines)
      setTerrainScene(null, projection, projected)
      terrainVersionRef.current += 1
      setTerrainState({
        version: terrainVersionRef.current,
        status: 'procedural',
        sourceText: `PROCEDURAL FALLBACK · ${farmId.toUpperCase()}`,
      })
      setTerrainVersion(terrainVersionRef.current)
      setTerrainNotice('实时高程不可用，已切换程序地形')
      console.warn('DEM load failed', error)
    }
    api.mapFeatures(farmId)
      .then(result => setMapFeatures(result))
      .catch(error => {
        setMapFeatures(null)
        console.warn('Map feature load failed', error)
      })
  }, [])

  useEffect(() => {
    let mounted = true
    async function load() {
      const [overview, farmRows, alertRows] = await Promise.all([
        api.overview(),
        api.windFarms(),
        api.alerts(),
      ])
      if (!mounted) return
      const options: FarmOption[] = farmRows
        .map(farm => ({
          id: farm.id,
          name: farm.name,
          lat: farm.lat,
          lng: farm.lng,
          turbineCount: farm.turbineCount,
        }))
      const availablePeriods = overview.periods ?? []
      setFarms(options)
      setAlerts(alertRows)
      setPeriods(availablePeriods)
      const initialPeriod = availablePeriods.includes(period) ? period : availablePeriods[0] ?? period
      if (initialPeriod !== period) setPeriod(initialPeriod)
      const initialId = options.find(farm => farm.id === 'wf-nayong')?.id ?? options[0]?.id
      if (initialId) setSelectedFarmId(initialId)
    }
    load().catch(() => setLoadError('后端服务未连接，正在使用沙盘演示数据'))
    return () => {
      mounted = false
      demAbortRef.current?.abort()
    }
    // Load the master data once; farm changes are handled by showFarm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selectedFarmId || !periods.length) return
    const requestNonce = ++periodRequestRef.current
    setPeriodLoading(true)
    api.turbines(period, selectedFarmId)
      .then(async farmTurbines => {
        if (requestNonce !== periodRequestRef.current) return
        await showFarm(selectedFarmId, farmTurbines, period)
        if (requestNonce === periodRequestRef.current) setPeriodLoading(false)
      })
      .catch(() => {
        if (requestNonce === periodRequestRef.current) {
          setPeriodLoading(false)
          setLoadError('时间断面加载失败，请检查后端服务')
        }
      })
  }, [period, periods.length, selectedFarmId, showFarm])

  useEffect(() => {
    if (!terrainNotice) return
    const timer = window.setTimeout(() => setTerrainNotice(''), 5200)
    return () => window.clearTimeout(timer)
  }, [terrainNotice])

  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const seconds = tick / 1000
  const turbines = useMemo(
    () => baseTurbines.map((turbine, index) => liveTurbine(turbine, index, seconds)),
    [baseTurbines, seconds],
  )
  const chartTurbines = useMemo(
    () => baseTurbines.map((turbine, index) => liveTurbine(turbine, index, 43_200 + phase(selectedFarmId) * 3600)),
    [baseTurbines, selectedFarmId],
  )
  const selected = turbines.find(item => item.id === selectedId) ?? null
  const totalPower = turbines.reduce((sum, item) => sum + item.liveMw, 0)
  const chartTotalPower = chartTurbines.reduce((sum, item) => sum + item.liveMw, 0)
  const cumulativeMwh = 282 + totalPower * 0.94
  const available = turbines.length ? Math.round((turbines.filter(t => t.status === 'running').length + turbines.filter(t => t.status === 'warning').length * 0.5) / turbines.length * 1000) / 10 : 91.7
  const installedCapacity = turbines.reduce((sum, item) => sum + item.ratedPowerKw, 0) / 1000
  const equivalentToday = totalPower / Math.max(1, installedCapacity) * 167.5
  const averageRpm = turbines.length ? turbines.reduce((sum, item) => sum + item.rotorRpm, 0) / turbines.length : 0
  const planPercent = 68 + totalPower / Math.max(1, installedCapacity) * 8
  const periodText = periodLoading ? 'SYNC…' : period

  const statusCounts = useMemo(() => ({
    running: turbines.filter(item => item.status === 'running').length,
    warning: turbines.filter(item => item.status === 'warning').length,
    fault: turbines.filter(item => item.status === 'fault').length,
  }), [turbines])

  const trend = useMemo(() => {
    const predicted: number[] = []
    const actual: number[] = []
    for (let hour = 0; hour < 24; hour += 1) {
      const base = 16 + 13 * Math.exp(-Math.pow((hour - 11) / 6.5, 2)) + 3.2 * Math.sin(hour * 0.72)
      predicted.push(Number(base.toFixed(1)))
      actual.push(Number((base * (0.74 + 0.10 * Math.sin(hour * 1.7 + 1) + chartTotalPower * 0.004)).toFixed(1)))
    }
    return { predicted, actual }
  }, [chartTotalPower])

  const trendOption = useMemo(() => ({
    backgroundColor: 'transparent',
    grid: { left: 38, right: 14, top: 18, bottom: 24 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', boundaryGap: false, data: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}h`), axisLine: { lineStyle: { color: '#294d43' } } },
    yAxis: { type: 'value', name: 'MW', splitLine: { lineStyle: { color: 'rgba(118,184,159,.12)' } } },
    series: [
      { name: '预测功率', type: 'line', smooth: true, symbol: 'none', data: trend.predicted, lineStyle: { color: '#4c8f77', width: 1.4 }, areaStyle: { color: 'rgba(76,143,119,.16)' } },
      { name: '实际功率', type: 'line', smooth: true, symbol: 'none', data: trend.actual, lineStyle: { color: '#72f2c4', width: 2 }, areaStyle: { color: 'rgba(114,242,196,.18)' } },
    ],
  }), [trend])

  const distributionOption = useMemo(() => ({
    backgroundColor: 'transparent',
    grid: { left: 34, right: 12, top: 18, bottom: 24 },
    tooltip: {},
    xAxis: { type: 'category', data: chartTurbines.map(item => item.displayId.replace('WT-', '')), axisLine: { lineStyle: { color: '#294d43' } } },
    yAxis: { type: 'value', splitLine: { show: false } },
    series: [{ type: 'bar', barWidth: 12, data: chartTurbines.map(item => ({
      value: Number(item.liveMw.toFixed(2)),
      itemStyle: { color: item.status === 'fault' ? '#ff5a48' : item.status === 'warning' ? '#ffb020' : '#67d8ab', borderRadius: [3, 3, 0, 0] },
    })) }],
  }), [chartTurbines])

  const fallbackAlerts: Alert[] = [
    { id: -1, level: 'warning', source_type: 'turbine', source_id: 'WT-09', title: '主轴温度偏高', detail: '冷却系统已自动投入', occurred_at: new Date(Date.now() - 1000 * 60 * 18).toISOString(), resolved: false },
    { id: -2, level: 'warning', source_type: 'turbine', source_id: 'WT-12', title: '偏航误差偏大', detail: '正在自动校准对风角度', occurred_at: new Date(Date.now() - 1000 * 60 * 47).toISOString(), resolved: false },
  ]
  const visibleAlerts = (alerts.length ? alerts : fallbackAlerts).slice(0, 4)
  const selectedFarmName = farms.find(farm => farm.id === selectedFarmId)?.name ?? '未选择风场'
  const [collapsed, setCollapsed] = useState({ left: false, right: false, bottom: false })
  const togglePanel = (key: 'left' | 'right' | 'bottom') => setCollapsed(current => ({ ...current, [key]: !current[key] }))

  return (
    <div className="sandbox-root fullscreen-map">
      <header className="sandbox-top">
        <div className="sandbox-identity">
          <i>WIND</i>
          <div>
            <strong>青岚能源</strong>
            <small>山地貌数字孪生中心</small>
          </div>
        </div>
        <div className="sandbox-header-center">
          <nav className="sandbox-tabs">
            <button className="active">全局总览 <span>01</span></button>
            <button onClick={() => onNavigate('gis')}>机组监测 <span>02</span></button>
            <button onClick={() => onNavigate('gis')}>能源分析 <span>03</span></button>
            <button onClick={() => onNavigate('gis')}>运维中心 <span>04</span></button>
          </nav>
          <label className="farm-selector">
            <span>风场</span>
            <select
              value={selectedFarmId}
              onChange={event => setSelectedFarmId(event.target.value)}
            >
              {farms.map(farm => (
                <option key={farm.id} value={farm.id}>{farm.name} · {farm.turbineCount}台</option>
              ))}
            </select>
          </label>
        </div>
        <div className="sandbox-clock">
          <span>{selectedFarmName}</span>
          <div className="sandbox-timeline">
            <input
              aria-label="时间轴"
              type="range"
              min={0}
              max={Math.max(0, periods.length - 1)}
              value={Math.max(0, periods.indexOf(period))}
              onChange={event => setPeriod(periods[Number(event.target.value)])}
            />
            <b>{periodText}</b>
          </div>
        </div>
      </header>

      <div className="sandbox-kpis">
        <div className="kpi-card accent">
          <small>全场实时功率</small>
          <strong>{totalPower.toFixed(2)}<em>MW</em></strong>
          <span>装机 {installedCapacity.toFixed(1)} MW · {periodText} 后端数据驱动</span>
        </div>
        <div className="kpi-card">
          <small>当日累计发电</small>
          <strong>{cumulativeMwh.toFixed(2)}<em>MWh</em></strong>
          <span>较昨日同期 +7.3%</span>
        </div>
        <div className="kpi-card">
          <small>机组可利用率</small>
          <strong>{available.toFixed(1)}<em>%</em></strong>
          <span>在线 {statusCounts.running + statusCounts.warning} / {turbines.length} 台</span>
        </div>
        <div className="kpi-card">
          <small>当日等效发电</small>
          <strong>{equivalentToday.toFixed(2)}<em>万kWh</em></strong>
          <span>计划完成 {planPercent.toFixed(1)}%</span>
        </div>
      </div>

      <main className="sandbox-main">
        <aside className={`sandbox-column left${collapsed.left ? ' collapsed' : ''}`}>
          <button className="panel-toggle" onClick={() => togglePanel('left')} aria-label="折叠左侧面板">{collapsed.left ? '‹' : '‹'}</button>
          {collapsed.left ? (
            <div className="panel-collapsed-hint">气象 / 效能</div>
          ) : (
          <>
          <section className="glass-card">
            <div className="card-head"><h2>风场气象</h2><span>METEOROLOGY</span></div>
            <div className="weather">
              <div className="compass-dial"><i /><b>N</b></div>
              <div>
                <b className="weather-speed">{(selected?.windSpeed ?? 9.6).toFixed(1)}</b>
                <small>m/s 主导风向 西南</small>
              </div>
            </div>
            <div className="mini-metrics">
              <div><span>环境温度</span><b>{(15.2 + Math.sin(seconds * 0.03) * 1.2).toFixed(1)} ℃</b></div>
              <div><span>相对湿度</span><b>{Math.round(63 + Math.sin(seconds * 0.05) * 4)}%</b></div>
              <div><span>空气密度</span><b>1.06 kg/m³</b></div>
              <div><span>湍流强度</span><b>0.12 SIM</b></div>
            </div>
          </section>

          <section className="glass-card">
            <div className="card-head"><h2>场站运行效能</h2><span>PERFORMANCE</span></div>
            <div className="performance-ring">
              <div className="ring" style={{ background: `conic-gradient(#66e9b6 ${available}%, rgba(255,255,255,.05) 0)` }}><span>{available.toFixed(1)}%</span><small>设备可利用率</small></div>
              <div><b>{totalPower.toFixed(1)} MW</b><small>当前实发功率</small></div>
            </div>
            <div className="metric-lines">
              <div><span>平均叶轮转速</span><b>{averageRpm.toFixed(1)} rpm</b></div>
              <div><span>集电系统效率</span><b>97.6%</b></div>
            </div>
            <div className="progress">
              <label>日计划发电量 420.0 MWh</label>
              <i><b style={{ width: `${Math.min(100, planPercent)}%` }} /></i>
              <span>今日已发电 {(420 * planPercent / 100).toFixed(1)} MWh</span>
            </div>
          </section>
          </>
          )}
        </aside>

        <SandboxScene
          style={{ position: 'fixed', inset: 0, zIndex: 1 }}
          turbines={turbines}
          selectedId={selectedId}
          onSelect={setSelectedId}
          night={night}
          viewMode={viewMode}
          terrain={{ ...terrainState, version: terrainVersion }}
          focusRequest={focusRequest}
          basemapMode={basemapMode}
          mapFeatures={mapFeatures}
          onNightChange={setNight}
          onViewModeChange={setViewMode}
          onBasemapModeChange={setBasemapMode}
        />

        <aside className={`sandbox-column right${collapsed.right ? ' collapsed' : ''}`}>
          <button className="panel-toggle" onClick={() => togglePanel('right')} aria-label="折叠右侧面板">›</button>
          {collapsed.right ? (
            <div className="panel-collapsed-hint">状态 / 遥测</div>
          ) : (
          <>
          <section className="glass-card status-card">
            <div className="card-head"><h2>机组状态矩阵</h2><span>全部 {turbines.length} 台</span></div>
            <div className="status-legend"><i className="run" />运行 <i className="warn" />预警 <i className="fault" />故障</div>
            <div className="matrix">
              {turbines.map(item => (
                <button
                  key={item.id}
                  className={item.status}
                  data-active={item.id === selectedId}
                  onClick={() => setSelectedId(item.id)}
                  title={item.displayId}
                >
                  {item.displayId.replace('WT-', '')}
                </button>
              ))}
            </div>
          </section>

          <section className="glass-card telemetry">
            <div className="card-head"><h2>设备实时遥测</h2><span>TELEMETRY</span></div>
            <div className="telemetry-head">
              <div>
                <h3>{selected?.displayId ?? 'WT-01'}</h3>
                <small>{((selected?.ratedPowerKw ?? 3600) / 1000).toFixed(1)} MW 额定 · 状态 {selected ? STATUS_TEXT[selected.status] : '运行'}</small>
              </div>
              <b>{selected?.liveMw.toFixed(2) ?? '--'}<em>MW</em></b>
            </div>
            <div className="dotted-progress">
              {Array.from({ length: 24 }, (_, index) => {
                const load = selected ? selected.liveMw / (selected.ratedPowerKw / 1000) : 0.72
                return <i key={index} className={index < Math.round(Math.min(1, load) * 24) ? 'on' : ''} />
              })}
              <span>运行负载 {(selected ? selected.liveMw / (selected.ratedPowerKw / 1000) * 100 : 78).toFixed(0)}%</span>
            </div>
            <div className="mini-metrics">
              <div><span>机舱风速</span><b>{(selected?.windSpeed ?? 9.5).toFixed(1)} m/s</b></div>
              <div><span>叶轮转速</span><b>{(selected?.rotorRpm ?? 12).toFixed(1)} rpm</b></div>
              <div><span>输出电流</span><b>{Math.round((selected?.liveMw ?? 2) * 46)} A</b></div>
              <div><span>定子温度</span><b>{(52 + (selected?.liveMw ?? 2) * 6).toFixed(1)} ℃</b></div>
            </div>
            <button
              className="ghost-button"
              disabled={!selected}
              onClick={() => {
                if (!selected) return
                setViewMode('overview')
                setFocusRequest(current => ({ id: selected.id, nonce: (current?.nonce ?? 0) + 1 }))
              }}
            >
              定位机舱 ⟶
            </button>
          </section>
          </>
          )}
        </aside>
      </main>

      <footer className={`sandbox-bottom${collapsed.bottom ? ' collapsed' : ''}`}>
        <button className="panel-toggle bottom-toggle" onClick={() => togglePanel('bottom')} aria-label="折叠底部图表">{collapsed.bottom ? '▲' : '▼'}</button>
        {collapsed.bottom ? null : (
        <>
        <section className="glass-card chart-wide">
          <div className="card-head"><h2>出力趋势</h2><span>预测 vs 实际 · 24H</span></div>
          <Chart height={56} option={trendOption} />
        </section>
        <section className="glass-card chart-wide">
          <div className="card-head"><h2>机舱功率分布</h2><span>MW / TURBINE</span></div>
          <Chart height={56} option={distributionOption} />
        </section>
        </>
        )}
      </footer>
      {terrainNotice && <div className="sandbox-toast">{terrainNotice}</div>}
      {loadError && <div className="sandbox-error">{loadError}</div>}
    </div>
  )
}
