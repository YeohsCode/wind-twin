import { useCallback, useEffect, useMemo, useState } from 'react'
import SandboxScene, { type SceneTurbine } from '../sandbox/SandboxScene'
import Chart from '../components/Chart'
import { api } from '../api'
import type { Alert, Turbine } from '../types'

type ViewMode = 'overview' | 'top' | 'side' | 'orbit'

function phase(id: string) {
  let value = 0
  for (const char of id) value = (value * 31 + char.charCodeAt(0)) % 997
  return value / 997
}

function liveTurbine(turbine: Turbine, index: number, seconds: number): SceneTurbine {
  const seed = phase(turbine.id) + index * 0.173
  const operationPower = turbine.operation?.power_kw ?? turbine.rated_power_kw * 0.74
  const wave = 0.82 + 0.14 * Math.sin(seconds * 0.16 + seed * 6.283) + 0.05 * Math.sin(seconds * 0.43 + seed * 12)
  const statusFactor = turbine.status === 'fault' ? 0.05 : turbine.status === 'warning' ? 0.58 : 1
  const powerKw = operationPower * wave * statusFactor
  return {
    id: turbine.id,
    displayId: `WT-${String(index + 1).padStart(2, '0')}`,
    status: turbine.status,
    ratedPowerKw: turbine.rated_power_kw,
    liveMw: Math.max(0, powerKw / 1000),
    windSpeed: 6.1 + 2.3 * Math.sin(seconds * 0.08 + seed * 4) + seed * 1.4,
    rotorRpm: turbine.status === 'fault' ? 0 : 8.2 + 4.6 * (powerKw / turbine.rated_power_kw),
  }
}

const STATUS_TEXT = { running: '运行', warning: '预警', fault: '故障' } as const

export default function SandboxView({ onNavigate }: { onNavigate: (route: 'sandbox' | 'gis') => void }) {
  const [baseTurbines, setBaseTurbines] = useState<Turbine[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loadError, setLoadError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [night, setNight] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('overview')
  const [tick, setTick] = useState(() => Date.now())

  useEffect(() => {
    let mounted = true
    async function load() {
      const [turbines, alertRows] = await Promise.all([
        api.turbines('2027-Q3', 'wf-hohhot'),
        api.alerts(),
      ])
      if (!mounted) return
      const showcase = turbines.slice(0, 12)
      setBaseTurbines(showcase)
      setSelectedId(current => current ?? showcase.find(item => item.status === 'warning')?.id ?? showcase[0]?.id ?? null)
      setAlerts(alertRows)
    }
    load().catch(() => setLoadError('后端服务未连接，正在使用沙盘演示数据'))
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const seconds = tick / 1000
  const turbines = useMemo(
    () => baseTurbines.map((turbine, index) => liveTurbine(turbine, index, seconds)),
    [baseTurbines, seconds],
  )

  const selected = turbines.find(item => item.id === selectedId) ?? null
  const totalPower = turbines.reduce((sum, item) => sum + item.liveMw, 0)
  const cumulativeMwh = 282 + totalPower * 0.94
  const available = turbines.length ? Math.round((turbines.filter(t => t.status === 'running').length + turbines.filter(t => t.status === 'warning').length * 0.5) / turbines.length * 1000) / 10 : 91.7
  const installedCapacity = turbines.reduce((sum, item) => sum + item.ratedPowerKw, 0) / 1000
  const equivalentToday = totalPower / Math.max(1, installedCapacity) * 167.5
  const averageRpm = turbines.length ? turbines.reduce((sum, item) => sum + item.rotorRpm, 0) / turbines.length : 0
  const planPercent = 68 + totalPower / Math.max(1, installedCapacity) * 8

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
      actual.push(Number((base * (0.74 + 0.10 * Math.sin(hour * 1.7 + 1) + totalPower * 0.004)).toFixed(1)))
    }
    return { predicted, actual }
  }, [Math.round(totalPower * 4)])

  const fallbackAlerts: Alert[] = [
    { id: -1, level: 'warning', source_type: 'turbine', source_id: 'WT-09', title: '主轴温度偏高', detail: '冷却系统已自动投入', occurred_at: new Date(Date.now() - 1000 * 60 * 18).toISOString(), resolved: false },
    { id: -2, level: 'warning', source_type: 'turbine', source_id: 'WT-12', title: '偏航误差偏大', detail: '正在自动校准对风角度', occurred_at: new Date(Date.now() - 1000 * 60 * 47).toISOString(), resolved: false },
  ]
  const visibleAlerts = (alerts.length ? alerts : fallbackAlerts).slice(0, 4)

  return (
    <div className="sandbox-root">
      <header className="sandbox-top">
        <div className="sandbox-identity">
          <i>WIND</i>
          <div>
            <strong>青岚能源</strong>
            <small>山地貌数字孪生中心</small>
          </div>
        </div>
        <nav className="sandbox-tabs">
          <button className="active">全局总览 <span>01</span></button>
          <button onClick={() => onNavigate('gis')}>机组监测 <span>02</span></button>
          <button onClick={() => onNavigate('gis')}>能源分析 <span>03</span></button>
          <button onClick={() => onNavigate('gis')}>运维中心 <span>04</span></button>
        </nav>
        <div className="sandbox-clock">
          <span>晴天 · 微风在线</span>
          <b>{new Date(tick).toLocaleTimeString('zh-CN', { hour12: false })}</b>
        </div>
      </header>

      <div className="sandbox-kpis">
        <div className="kpi-card accent">
          <small>全场实时功率</small>
          <strong>{totalPower.toFixed(2)}<em>MW</em></strong>
          <span>装机 {installedCapacity.toFixed(1)} MW · 后端基线波形推演</span>
        </div>
        <div className="kpi-card">
          <small>当日累计发电</small>
          <strong>{cumulativeMwh.toFixed(2)}<em>MWh</em></strong>
          <span>较昨日同期 +7.3%</span>
        </div>
        <div className="kpi-card">
          <small>机组可利用率</small>
          <strong>{available.toFixed(1)}<em>%</em></strong>
          <span>在线 {statusCounts.running + statusCounts.warning} / {turbines.length || 12} 台</span>
        </div>
        <div className="kpi-card">
          <small>当日等效发电</small>
          <strong>{equivalentToday.toFixed(2)}<em>万kWh</em></strong>
          <span>计划完成 {planPercent.toFixed(1)}%</span>
        </div>
      </div>

      <main className="sandbox-main">
        <aside className="sandbox-column left">
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
        </aside>

        <SandboxScene
          turbines={turbines}
          selectedId={selectedId}
          onSelect={setSelectedId}
          night={night}
          viewMode={viewMode}
          onNightChange={setNight}
          onViewModeChange={setViewMode}
        />

        <aside className="sandbox-column right">
          <section className="glass-card">
            <div className="card-head"><h2>机组状态矩阵</h2><span>全部 {turbines.length || 12} 台</span></div>
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
              {!turbines.length && Array.from({ length: 12 }, (_, index) => <button key={index}>{String(index + 1).padStart(2, '0')}</button>)}
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
            <button className="ghost-button">定位机舱 ⟶</button>
          </section>
        </aside>
      </main>

      <footer className="sandbox-bottom">
        <section className="glass-card">
          <div className="card-head"><h2>出力趋势</h2><span>预测 vs 实际 · 24H</span></div>
          <Chart height={126} option={{
            backgroundColor: 'transparent',
            grid: { left: 38, right: 14, top: 18, bottom: 24 },
            tooltip: { trigger: 'axis' },
            xAxis: { type: 'category', boundaryGap: false, data: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}h`), axisLine: { lineStyle: { color: '#294d43' } } },
            yAxis: { type: 'value', name: 'MW', splitLine: { lineStyle: { color: 'rgba(118,184,159,.12)' } } },
            series: [
              { name: '预测功率', type: 'line', smooth: true, symbol: 'none', data: trend.predicted, lineStyle: { color: '#4c8f77', width: 1.4 }, areaStyle: { color: 'rgba(76,143,119,.16)' } },
              { name: '实际功率', type: 'line', smooth: true, symbol: 'none', data: trend.actual, lineStyle: { color: '#72f2c4', width: 2 }, areaStyle: { color: 'rgba(114,242,196,.18)' } },
            ],
          }} />
        </section>
        <section className="glass-card">
          <div className="card-head"><h2>机舱功率分布</h2><span>MW / TURBINE</span></div>
          <Chart height={126} option={{
            backgroundColor: 'transparent',
            grid: { left: 34, right: 12, top: 18, bottom: 24 },
            tooltip: {},
            xAxis: { type: 'category', data: turbines.map(item => item.displayId.replace('WT-', '')), axisLine: { lineStyle: { color: '#294d43' } } },
            yAxis: { type: 'value', splitLine: { show: false } },
            series: [{ type: 'bar', barWidth: 12, data: turbines.map(item => ({
              value: Number(item.liveMw.toFixed(2)),
              itemStyle: { color: item.status === 'fault' ? '#ff5a48' : item.status === 'warning' ? '#ffb020' : '#67d8ab', borderRadius: [3, 3, 0, 0] },
            })) }],
          }} />
        </section>
        <section className="glass-card events">
          <div className="card-head"><h2>运行事件</h2><span>{visibleAlerts.length} 待确认</span></div>
          <div className="event-list">
            {visibleAlerts.map(alert => (
              <article key={alert.id}>
                <i className={alert.level === 'critical' ? 'fault' : 'warn'} />
                <div><b>{alert.title}</b><span>{alert.detail}</span></div>
                <time>{new Date(alert.occurred_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
              </article>
            ))}
          </div>
        </section>
      </footer>
      {loadError && <div className="sandbox-error">{loadError}</div>}
    </div>
  )
}
