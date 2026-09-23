import { useEffect, useRef, useState } from 'react'
import maplibregl, { Map as MLMap, StyleSpecification } from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import * as THREE from 'three'
import { TurbineLayer } from './TurbineLayer'
import { UnifiedTurbineLayer } from './UnifiedTurbineLayer'
import type { Alert, Factory, MapViewport, Project, RealWindFarm, RealWindTurbine, Region, Route, Substation, SimulationEntity, Turbine, UnifiedWindFarm, UnifiedWindTurbine, WindFarm, Plan } from '../types'

type Layers = Record<string, boolean>
type Props = {
  regions: Region[]; farms: WindFarm[]; turbines: Turbine[]; factories: Factory[]; projects: Project[]
  substations: Substation[]; routes: Route[]; alerts: Alert[]; activePlan: Plan | null
  layers: Layers; period: string; focusRegion: string | null; focusFarm: string | null
  entities?: SimulationEntity[]; selectedEntityId?: string | null
  realFarms?: RealWindFarm[]; realTurbines?: RealWindTurbine[]
  unifiedFarms?: UnifiedWindFarm[]; unifiedTurbines?: UnifiedWindTurbine[]
  onViewportChange?: (viewport: MapViewport) => void
  onSelectTurbine: (t: Turbine) => void; onSelectProject: (p: Project) => void
  onSelectRegion: (id: string) => void; onSelectFarm: (id: string) => void
  onSelectEntity?: (entity: SimulationEntity) => void
}

const emptyFC = { type: 'FeatureCollection' as const, features: [] }
const ll = (points: number[][]) => points.map(([lat, lng]) => [lng, lat])
const ring = (points: number[][]) => ll(points)
const FACTORY_COLORS: Record<string, string> = { 'F-A': '#38bdf8', 'F-B': '#a78bfa', 'F-C': '#22c55e' }
const REAL_FARM_COLORS: Record<string, string> = {
  'hale-wind': '#f97316',
  'sagamore-wind': '#a78bfa',
  'traverse-wind': '#facc15',
  'high-banks': '#22c55e',
  'western-spirit': '#fb7185',
}
const SOURCE_COLORS: Record<string, string> = { osm: '#22d3ee', usgs: '#facc15', sim: '#a78bfa', wri: '#f97316' }
const SOURCE_LABELS: Record<string, string> = { osm: 'OSM', usgs: 'USGS', sim: '模拟', wri: 'WRI GPPD' }
const STATUS_COLORS: Record<string, string> = { construction: '#f97316', approved: '#38bdf8', reserve: '#94a3b8' }
const ROUTE_DASH_FRAMES = [[0, 2, 1.5, 0.5], [0.5, 1.5, 2, 0], [1, 1, 1.5, 0.5], [1.5, 0.5, 1, 1.5]]
const SIM_TYPE_LABELS: Record<string, string> = {
  transport_crew: '运输队', crane: '吊装机', production_equipment: '生产设备',
  storage_unit: '储能', transmission_line: '输电线路', wind_turbine_site: '机位',
}
const SIM_STATUS_COLORS: Record<string, string> = {
  moving: '#38bdf8', producing: '#22c55e', installing: '#f97316', online: '#22c55e',
  charging: '#a78bfa', discharging: '#fb7185', active: '#38bdf8', standby: '#facc15',
  waiting: '#94a3b8', idle: '#64748b',
}
const iconCache = new Map<string, HTMLCanvasElement>()

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath()
  context.moveTo(x + radius, y)
  context.arcTo(x + width, y, x + width, y + height, radius)
  context.arcTo(x + width, y + height, x, y + height, radius)
  context.arcTo(x, y + height, x, y, radius)
  context.arcTo(x, y, x + width, y, radius)
  context.closePath()
}

function simulationIcon(key: string) {
  const cached = iconCache.get(key)
  if (cached) return cached
  const [type, status, progressKey] = key.split('|')
  const canvas = document.createElement('canvas')
  canvas.width = 42; canvas.height = 42
  const context = canvas.getContext('2d')
  if (!context) return canvas
  const frameColor = SIM_STATUS_COLORS[status] ?? '#94a3b8'
  context.clearRect(0, 0, 42, 42)
  context.strokeStyle = frameColor
  context.fillStyle = 'rgba(3,18,30,.88)'
  context.lineWidth = 2.4
  roundedRect(context, 7, 10, 28, 22, 5)
  context.fill(); context.stroke()
  context.strokeStyle = '#e2f6ff'; context.lineWidth = 2; context.lineCap = 'round'
  context.beginPath()
  if (type === 'transport_crew') {
    context.rect(12, 17, 11, 6); context.moveTo(25, 18); context.lineTo(30, 20); context.lineTo(30, 23); context.lineTo(25, 23)
    context.moveTo(17, 26); context.arc(17, 26, 1.8, 0, Math.PI * 2); context.moveTo(27, 26); context.arc(27, 26, 1.8, 0, Math.PI * 2)
  } else if (type === 'crane') {
    context.moveTo(14, 28); context.lineTo(18, 16); context.lineTo(30, 19); context.moveTo(18, 16); context.lineTo(18, 28); context.moveTo(24, 19); context.lineTo(24, 25)
  } else if (type === 'production_equipment') {
    context.rect(13, 22, 16, 6); context.moveTo(14, 22); context.lineTo(19, 17); context.lineTo(19, 22); context.moveTo(21, 22); context.lineTo(26, 17); context.lineTo(26, 22)
  } else if (type === 'storage_unit') {
    roundedRect(context, 14, 16, 14, 11, 2); context.moveTo(23, 15); context.lineTo(20, 21); context.lineTo(23, 21); context.lineTo(20, 28)
  } else if (type === 'transmission_line') {
    context.moveTo(21, 14); context.lineTo(21, 28); context.moveTo(15, 18); context.lineTo(27, 18); context.moveTo(17, 28); context.lineTo(21, 21); context.lineTo(25, 28)
  } else {
    context.moveTo(21, 15); context.lineTo(21, 24); context.moveTo(14, 27); context.lineTo(28, 27); context.moveTo(21, 24); context.lineTo(15, 27); context.moveTo(21, 24); context.lineTo(27, 27)
  }
  context.stroke()
  const progress = Math.max(0, Math.min(100, Number(progressKey) / 4))
  context.strokeStyle = progress >= 1 ? '#7df3c4' : frameColor
  context.lineWidth = 3
  context.beginPath()
  context.arc(21, 21, 18, Math.PI * 1.5, Math.PI * 1.5 + progress * Math.PI * 2)
  context.stroke()
  iconCache.set(key, canvas)
  return canvas
}

function canvasImage(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d')!
  return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data }
}

function makeDropIcon(color: string) {
  // 倒置水滴 = 地图 marker 形状：圆头在上、尖端在下，用径向渐变+高光营造 3D 立体感
  const canvas = document.createElement('canvas')
  canvas.width = 44; canvas.height = 58
  const context = canvas.getContext('2d')!
  const cx = 22
  const tipY = 54
  const bodyTop = 6
  const bodyR = 15
  const bodyCy = bodyTop + bodyR
  context.save()
  // 主体轮廓：底部尖端 + 上方圆形
  context.beginPath()
  context.moveTo(cx, tipY)
  // 左侧曲线到圆
  context.bezierCurveTo(cx - 16, tipY - 24, cx - bodyR, bodyCy - 6, cx - bodyR, bodyCy - 2)
  context.arc(cx, bodyCy - 2, bodyR, Math.PI, 0, false)
  // 右侧曲线回尖端
  context.bezierCurveTo(cx + bodyR, bodyCy - 6, cx + 16, tipY - 24, cx, tipY)
  context.closePath()
  // 3D 球面渐变：左上受光、右下暗部
  const gradient = context.createRadialGradient(cx - 5, bodyCy - 10, 2, cx, bodyCy, bodyR + 16)
  gradient.addColorStop(0, '#a5ecff')
  gradient.addColorStop(0.35, '#38bdf8')
  gradient.addColorStop(0.75, '#0e7fb8')
  gradient.addColorStop(1, '#065a86')
  context.fillStyle = gradient
  context.fill()
  context.strokeStyle = 'rgba(190,240,255,.85)'
  context.lineWidth = 1.4
  context.stroke()
  // 左上高光
  context.fillStyle = 'rgba(255,255,255,.75)'
  context.beginPath()
  context.ellipse(cx - 5.5, bodyCy - 8, 3.6, 5.4, -0.5, 0, Math.PI * 2)
  context.fill()
  context.fillStyle = 'rgba(255,255,255,.4)'
  context.beginPath()
  context.ellipse(cx + 4, bodyCy + 4, 2.2, 3.2, 0.6, 0, Math.PI * 2)
  context.fill()
  // 尖端接触阴影
  context.fillStyle = 'rgba(3,12,22,.5)'
  context.beginPath()
  context.ellipse(cx, tipY + 1.5, 5, 2, 0, 0, Math.PI * 2)
  context.fill()
  context.restore()
  return canvas
}

function makeTurbineIcon(color: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 36; canvas.height = 52
  const context = canvas.getContext('2d')!
  context.strokeStyle = '#e8fbff'; context.lineWidth = 3.5; context.lineCap = 'round'
  const tower = context.createLinearGradient(15, 0, 21, 0)
  tower.addColorStop(0, 'rgba(255,255,255,.95)'); tower.addColorStop(.5, color); tower.addColorStop(1, 'rgba(60,90,120,.9)')
  context.strokeStyle = tower
  context.beginPath(); context.moveTo(18, 46); context.lineTo(18, 17); context.stroke()
  context.strokeStyle = color; context.lineWidth = 3.2
  for (let index = 0; index < 3; index += 1) {
    const angle = index * Math.PI * 2 / 3 - Math.PI / 2
    context.beginPath(); context.moveTo(18, 17)
    context.lineTo(18 + Math.cos(angle) * 14, 17 + Math.sin(angle) * 14); context.stroke()
  }
  context.fillStyle = '#f8fbff'; context.beginPath(); context.ellipse(18, 17, 3.2, 2.4, 0, 0, Math.PI * 2); context.fill()
  return canvas
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character] ?? character))
}

function routePosition(routes: Route[], routeId: string | undefined, progress: number, reverse = false): [number, number] | null {
  const route = routes.find(item => item.id === routeId)
  if (!route?.geometry.length) return null
  const fraction = Math.max(0, Math.min(1, (reverse ? 1 - progress / 100 : progress / 100)))
  const distances = route.geometry.slice(1).map((point, index) => Math.hypot((point[0] - route.geometry[index][0]) * 111, (point[1] - route.geometry[index][1]) * 111 * Math.cos(route.geometry[index][0] * Math.PI / 180)))
  const total = distances.reduce((sum, value) => sum + value, 0)
  if (!total) return [route.geometry[0][0], route.geometry[0][1]]
  let target = total * fraction
  for (let index = 0; index < distances.length; index += 1) {
    if (target <= distances[index] || index === distances.length - 1) {
      const local = distances[index] ? Math.min(1, target / distances[index]) : 0
      const start = route.geometry[index]; const end = route.geometry[index + 1] ?? start
      return [start[0] + (end[0] - start[0]) * local, start[1] + (end[1] - start[1]) * local]
    }
    target -= distances[index]
  }
  return null
}

function routeBearing(routes: Route[], routeId: string | undefined, progress: number, reverse = false) {
  const fraction = Math.max(0, Math.min(1, (reverse ? 1 - progress / 100 : progress / 100)))
  const from = routePosition(routes, routeId, fraction * 100, false)
  const to = routePosition(routes, routeId, Math.min(1, fraction + 0.015) * 100, false)
  if (!from || !to) return 0
  return Math.atan2((to[1] - from[1]) * Math.cos(from[0] * Math.PI / 180), to[0] - from[0]) * 180 / Math.PI
}

function makeStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      satellite: {
        type: 'raster', tileSize: 256,
        tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg'],
        attribution: 'Sentinel-2 cloudless by EOX IT Services (contains modified Copernicus Sentinel data)',
      },
      openmap: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      terrain: {
        type: 'raster-dem', tileSize: 512, encoding: 'terrarium',
        tiles: ['mapterhorn://{z}/{x}/{y}'],
        attribution: '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>',
      },
    },
    layers: [
      { id: 'base', type: 'background', paint: { 'background-color': '#0a1520' } },
      { id: 'satellite', type: 'raster', source: 'satellite', paint: { 'raster-opacity': 0.92, 'raster-saturation': 0.55, 'raster-contrast': 0.08 } },
      { id: 'water-fill', type: 'fill', source: 'openmap', 'source-layer': 'water', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': 'rgba(12,74,110,.72)', 'fill-outline-color': 'rgba(56,189,248,.35)' } },
      { id: 'waterway', type: 'line', source: 'openmap', 'source-layer': 'waterway', paint: { 'line-color': 'rgba(14,116,144,.75)', 'line-width': 1.2 } },
      { id: 'admin-line', type: 'line', source: 'openmap', 'source-layer': 'boundary', filter: ['all', ['==', ['geometry-type'], 'LineString'], ['<=', ['to-number', ['get', 'admin_level'], 99], 6]], paint: { 'line-color': 'rgba(226,232,240,.22)', 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 8, 1.6] } },
      { id: 'hillshade', type: 'hillshade', source: 'terrain', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#001324', 'hillshade-highlight-color': '#7dd3fc' } },
    ],
  }
}

export default function TwinMap(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const turbineLayerRef = useRef<TurbineLayer | null>(null)
  const unifiedTurbineLayerRef = useRef<UnifiedTurbineLayer | null>(null)
  const readyRef = useRef(false)
  const [readyTick, setReadyTick] = useState(0)
  const clickHandlers = useRef(props)
  clickHandlers.current = props
  const viewportHandler = useRef(props.onViewportChange)
  viewportHandler.current = props.onViewportChange

  useEffect(() => {
    if (mapRef.current || !containerRef.current) return
    const protocol = new Protocol({ metadata: true, errorOnMissingTile: true })
    maplibregl.addProtocol('mapterhorn', async (params, abortController) => {
      const [z, x, y] = params.url.replace('mapterhorn://', '').split('/').map(Number)
      const name = z <= 12 ? 'planet' : `6-${x >> (z - 6)}-${y >> (z - 6)}`
      const url = `pmtiles://https://download.mapterhorn.com/${name}.pmtiles/${z}/${x}/${y}.webp`
      return await protocol.tile({ ...params, url } as any, abortController)
    })

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: makeStyle(),
      center: [114.4, 40.8], zoom: 5.25, pitch: 64, bearing: -18,
      maxPitch: 80, attributionControl: { compact: true },
    })
    mapRef.current = map
    ;(window as any).__map = map
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120 }), 'bottom-left')
    let viewportTimer = 0
    const emitViewport = () => {
      window.clearTimeout(viewportTimer)
      viewportTimer = window.setTimeout(() => {
        const bounds = map.getBounds().toArray()
        viewportHandler.current?.({
          bbox: [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]],
          zoom: map.getZoom(),
        })
      }, 300)
    }
    map.on('move', emitViewport)
    const updateUnifiedMode = () => {
      const zoom = map.getZoom()
      const metersPerPixel = 40075016.686 * Math.cos(map.getCenter().lat * Math.PI / 180) / 2 ** (zoom + 8)
      const metersPerScreenCm = metersPerPixel * 96 / 2.54
      const turbineDetail = metersPerScreenCm < 1000
      const setVisibility = (layerId: string, visible: boolean) => {
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
      }
      setVisibility('unified-turbines-3d', turbineDetail && clickHandlers.current.layers.realWind)
      setVisibility('unified-turbine-hit', turbineDetail && clickHandlers.current.layers.realWind)
      setVisibility('unified-turbine-sprites', turbineDetail && clickHandlers.current.layers.realWind)
      setVisibility('unified-farm-drops', clickHandlers.current.layers.realWind && !turbineDetail)
    }
    map.on('zoom', updateUnifiedMode)
    map.on('style.load', () => {
      readyRef.current = true
      map.setSky({
        'sky-color': 'rgba(10,21,32,0.95)',
        'horizon-color': 'rgba(18,32,46,0.9)',
        'fog-color': 'rgba(8,18,28,0.9)',
        'fog-ground-blend': 0.55,
        'horizon-fog-blend': 0.4,
        'sky-horizon-blend': 0.5,
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 6, 0.35, 10, 0.12],
      })
      map.setTerrain({ source: 'terrain', exaggeration: 1.25 })
      const geoSources = ['regions', 'farms', 'farmPoints', 'projects', 'factories', 'substations', 'routes', 'alerts', 'turbineHits', 'simulationEntities', 'powerFlow', 'powerArrows', 'realTurbines', 'unifiedFarms', 'unifiedTurbineHits']
      geoSources.forEach(id => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: emptyFC }) })
      const initial = [
      { id: 'region-fill', type: 'fill', source: 'regions', filter: ['==', ['get', 'kind'], 'region'], paint: { 'fill-color': '#7dd3fc', 'fill-opacity': 0 } },
        { id: 'region-heat', type: 'fill', source: 'regions', filter: ['==', ['get', 'heatKind'], 'province'], paint: {
          'fill-color': ['interpolate', ['linear'], ['coalesce', ['get', 'heatMw'], 0], 0, 'rgba(56,189,248,.03)', 800, 'rgba(56,189,248,.13)', 1800, 'rgba(132,204,22,.22)', 3200, 'rgba(249,115,22,.30)'],
          'fill-opacity': ['case', ['boolean', ['get', 'selected'], false], 0.82, 0.58],
        } },
        { id: 'region-line', type: 'line', source: 'regions', filter: ['==', ['get', 'kind'], 'region'], paint: { 'line-color': 'rgba(125,211,252,.82)', 'line-width': ['case', ['boolean', ['get', 'selected'], false], 3.2, 1.4] } },
        { id: 'farm-line', type: 'line', source: 'farms', paint: { 'line-color': ['case', ['boolean', ['get', 'selected'], false], '#7df3c4', 'rgba(56,189,248,.72)'], 'line-width': ['case', ['boolean', ['get', 'selected'], false], 4, 2], 'line-dasharray': [2, 1.5] } },
        { id: 'farm-hit', type: 'fill', source: 'farms', paint: { 'fill-color': '#7df3c4', 'fill-opacity': 0 } },
        { id: 'route-glow', type: 'line', source: 'routes', paint: { 'line-color': ['get', 'color'], 'line-width': 7, 'line-opacity': 0.14, 'line-blur': 3 } },
        { id: 'route-line', type: 'line', source: 'routes', paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['boolean', ['get', 'active'], false], 3.4, 1.2], 'line-opacity': ['case', ['boolean', ['get', 'active'], false], 0.95, 0.32], 'line-dasharray': [1.2, 1.5] } },
        { id: 'project-bars', type: 'fill-extrusion', source: 'projects', paint: { 'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': 1620, 'fill-extrusion-opacity': 0.82 } },
        { id: 'factory-point', type: 'circle', source: 'factories', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 9, 8, 16], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2, 'circle-opacity': .95 } },
        { id: 'substation-point', type: 'circle', source: 'substations', paint: { 'circle-radius': 5, 'circle-color': '#fbbf24', 'circle-stroke-color': 'rgba(255,255,255,.7)', 'circle-stroke-width': 1.2 } },
        { id: 'farm-point', type: 'circle', source: 'farmPoints', paint: { 'circle-radius': 4, 'circle-color': '#e0f2fe', 'circle-opacity': .8 } },
        { id: 'alert-point', type: 'circle', source: 'alerts', paint: { 'circle-radius': 10, 'circle-color': 'transparent', 'circle-stroke-color': '#ef4444', 'circle-stroke-width': 2, 'circle-opacity': 0 } },
        { id: 'turbine-hit', type: 'circle', source: 'turbineHits', paint: { 'circle-radius': 7, 'circle-color': '#fff', 'circle-opacity': 0.01 } },
      ] as any[]
      initial.forEach(layer => { if (!map.getLayer(layer.id)) map.addLayer(layer) })
      const simTypes = Object.keys(SIM_TYPE_LABELS)
      for (const type of simTypes) {
        for (const status of Object.keys(SIM_STATUS_COLORS)) {
          for (let progress = 0; progress <= 4; progress += 1) {
            const key = `${type}|${status}|${progress}`
            if (!map.hasImage(key)) map.addImage(key, canvasImage(simulationIcon(key)), { pixelRatio: 2 })
          }
        }
      }
      if (!map.hasImage('flow-arrow')) {
        const arrow = document.createElement('canvas')
        arrow.width = 22; arrow.height = 22
        const context = arrow.getContext('2d')!
        context.strokeStyle = '#f8fafc'; context.lineWidth = 3; context.lineCap = 'round'
        context.beginPath(); context.moveTo(5, 11); context.lineTo(16, 11); context.moveTo(12, 6); context.lineTo(17, 11); context.lineTo(12, 16); context.stroke()
        map.addImage('flow-arrow', canvasImage(arrow), { pixelRatio: 2 })
      }
      map.addLayer({ id: 'power-flow-glow', type: 'line', source: 'powerFlow', paint: {
        'line-color': ['case', ['>=', ['get', 'flow'], 0], '#67e8f9', '#f97316'],
        'line-width': ['interpolate', ['linear'], ['abs', ['get', 'flow']], 0, 5, 200, 14], 'line-opacity': .12, 'line-blur': 4,
      } })
      map.addLayer({ id: 'power-flow-line', type: 'line', source: 'powerFlow', paint: {
        'line-color': ['case', ['>=', ['get', 'flow'], 0], '#38bdf8', '#fb923c'],
        'line-width': ['interpolate', ['linear'], ['abs', ['get', 'flow']], 0, 1.4, 50, 3, 200, 8],
        'line-opacity': ['case', ['>', ['abs', ['get', 'flow']], 0.1], .9, .35], 'line-dasharray': [1.4, 1],
      } })
      map.addLayer({ id: 'power-flow-arrow', type: 'symbol', source: 'powerArrows', layout: {
        'icon-image': 'flow-arrow', 'icon-size': .72, 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      }, paint: { 'icon-opacity': ['case', ['>', ['abs', ['get', 'flow']], 0.1], .95, .2] } })
      map.addLayer({ id: 'simulation-icons', type: 'symbol', source: 'simulationEntities', layout: {
        'icon-image': ['get', 'icon'], 'icon-size': .86, 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'icon-rotate': ['case', ['==', ['get', 'type'], 'transport_crew'], ['get', 'heading'], 0], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'viewport',
      } })
      map.addLayer({ id: 'simulation-hit', type: 'circle', source: 'simulationEntities', paint: { 'circle-radius': 15, 'circle-color': '#fff', 'circle-opacity': .01 } })
      map.addLayer({
        id: 'real-wind-points', type: 'circle', source: 'realTurbines',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 1.6, 7, 2.8, 11, 4.2],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.82,
          'circle-stroke-color': 'rgba(248,250,252,.82)',
          'circle-stroke-width': 0.7,
        },
      })
      for (const [key, color] of Object.entries(SOURCE_COLORS)) {
        if (!map.hasImage(`drop-${key}`)) map.addImage(`drop-${key}`, canvasImage(makeDropIcon(color)), { pixelRatio: 2 })
        if (!map.hasImage(`turbine-${key}`)) map.addImage(`turbine-${key}`, canvasImage(makeTurbineIcon(color)), { pixelRatio: 2 })
      }
      map.addLayer({
        id: 'unified-farm-drops', type: 'symbol', source: 'unifiedFarms', layout: {
          'icon-image': ['concat', 'drop-', ['get', 'source']], 'icon-size': 0.62,
          'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        },
      })
      map.addLayer({
        id: 'unified-turbine-hit', type: 'circle', source: 'unifiedTurbineHits',
        paint: { 'circle-radius': 7, 'circle-color': '#fff', 'circle-opacity': 0.01 },
      })
      map.addLayer({
        id: 'unified-turbine-sprites', type: 'symbol', source: 'unifiedTurbineHits', layout: {
          'icon-image': ['concat', 'turbine-', ['get', 'source']],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 10.5, 0.1, 12, 0.18, 14, 0.38, 16, 0.7],
          'icon-allow-overlap': true, 'icon-ignore-placement': true,
        },
      })
      const layer = new TurbineLayer([114.4, 40.8])
      turbineLayerRef.current = layer
      if (!map.getLayer(layer.id)) map.addLayer(layer as any)
      layer.setData(clickHandlers.current.turbines)
      const unifiedLayer = new UnifiedTurbineLayer()
      unifiedTurbineLayerRef.current = unifiedLayer
      if (!map.getLayer(unifiedLayer.id)) map.addLayer(unifiedLayer as any)
      unifiedLayer.setData(clickHandlers.current.unifiedTurbines ?? [])
      updateUnifiedMode()
      setReadyTick(value => value + 1)
    })

    const tooltip = document.createElement('div')
    tooltip.className = 'unified-tooltip'
    tooltip.hidden = true
    containerRef.current.appendChild(tooltip)
    const hideTooltip = () => { tooltip.hidden = true }
    map.on('mouseout', hideTooltip)
    map.on('mousemove', event => {
      const farmHits = map.queryRenderedFeatures(event.point, { layers: ['unified-farm-drops'] })
      const turbineHits = map.queryRenderedFeatures(event.point, { layers: ['unified-turbine-hit'] })
      const hit = farmHits[0] ?? turbineHits[0]
      if (!hit) { hideTooltip(); return }
      const item = hit.properties as any
      const source = SOURCE_LABELS[item.source] ?? item.source
      const capacity = item.capacityMw ? `${Number(item.capacityMw).toFixed(1)} MW` : item.capKw ? `${Number(item.capKw).toLocaleString()} kW` : '容量未知'
      const model = item.model || item.manufacturer || '机型未知'
      tooltip.innerHTML = `
        <strong>${escapeHtml(item.name ?? `OSM 风机点位 #${item.id}`)}</strong>
        <span>${escapeHtml(source)}${item.country ? ` · ${escapeHtml(item.country)}` : ''}</span>
        <span>${escapeHtml(capacity)} · ${escapeHtml(model)}</span>
      `
      const bounds = containerRef.current!.getBoundingClientRect()
      tooltip.style.left = `${event.point.x + 14}px`
      tooltip.style.top = `${event.point.y + 12}px`
      tooltip.style.transform = event.point.x > bounds.width - 240 ? 'translateX(-110%)' : 'none'
      tooltip.hidden = false
    })

    map.on('click', event => {
      const entityHits = map.queryRenderedFeatures(event.point, { layers: ['simulation-hit'] })
      if (entityHits.length) {
        const entity = clickHandlers.current.entities?.find(item => item.id === entityHits[0].properties?.id)
        if (entity) { clickHandlers.current.onSelectEntity?.(entity); return }
      }
      const farmHitsFirst = map.queryRenderedFeatures(event.point, { layers: ['farm-hit'] })
      const unifiedFarmHits = map.queryRenderedFeatures(event.point, { layers: ['unified-farm-drops'] })
      if (unifiedFarmHits.length) {
        const farm = unifiedFarmHits[0].properties as any
        new maplibregl.Popup({ offset: 12, closeButton: false }).setLngLat(event.lngLat).setHTML(`
          <strong>${escapeHtml(farm.name)}</strong><br>
          ${escapeHtml(SOURCE_LABELS[farm.source] ?? farm.source)} · ${farm.capacityMw ? `${Number(farm.capacityMw).toFixed(1)} MW` : '容量未知'}<br>
          ${farm.turbineCount ? `${farm.turbineCount} 台 · ` : ''}${farm.commissioningYear ? `投产 ${farm.commissioningYear}` : '投产年份未知'}
        `).addTo(map)
        return
      }
      const unifiedTurbineHits = map.queryRenderedFeatures(event.point, { layers: ['unified-turbine-hit'] })
      if (unifiedTurbineHits.length) {
        const turbine = unifiedTurbineHits[0].properties as any
        new maplibregl.Popup({ offset: 12, closeButton: false }).setLngLat(event.lngLat).setHTML(`
          <strong>${escapeHtml(turbine.name ?? `OSM 风机点位 #${turbine.id}`)}</strong><br>
          ${escapeHtml(SOURCE_LABELS[turbine.source] ?? turbine.source)} · ${turbine.capKw ? `${Number(turbine.capKw).toLocaleString()} kW` : '容量未知'}<br>
          ${turbine.model ?? turbine.manufacturer ?? '机型未知'}
        `).addTo(map)
        return
      }
      const realHits = map.queryRenderedFeatures(event.point, { layers: ['real-wind-points'] })
      if (realHits.length) {
        const item = realHits[0].properties as any
        const farm = clickHandlers.current.realFarms?.find(candidate => candidate.id === item.farmId)
        if (item.farmId && farm) {
          new maplibregl.Popup({ offset: 12, closeButton: false })
            .setLngLat(event.lngLat).setHTML(`
              <strong>${farm.name}</strong><br>
              ${farm.state} · USGS USWTDB 实测<br>
              ${farm.turbineCount} 台 · ${farm.capacityMw.toFixed(1)} MW<br>
              主力机型 ${farm.dominantModel}<br>
              投产 ${farm.commissioningYear}
            `).addTo(map)
          return
        }
      }
      const hits = map.queryRenderedFeatures(event.point, { layers: ['turbine-hit'] })
      if (hits.length && !farmHitsFirst.length) {
        const turbine = clickHandlers.current.turbines.find(t => t.id === hits[0].properties?.id)
        if (turbine) { clickHandlers.current.onSelectTurbine(turbine); return }
      }
      const bars = map.queryRenderedFeatures(event.point, { layers: ['project-bars'] })
      if (bars.length) {
        const project = clickHandlers.current.projects.find(p => p.id === bars[0].properties?.id)
        if (project) clickHandlers.current.onSelectProject(project)
        return
      }
      const farmHits = map.queryRenderedFeatures(event.point, { layers: ['farm-hit', 'farm-point'] })
      if (farmHits.length && farmHits[0].properties?.id) {
        clickHandlers.current.onSelectFarm(farmHits[0].properties.id as string)
        return
      }
      const regionHits = map.queryRenderedFeatures(event.point, { layers: ['region-heat', 'region-fill'] })
      if (regionHits.length && regionHits[0].properties?.id) {
        clickHandlers.current.onSelectRegion(regionHits[0].properties.id as string)
        return
      }
      const factoryHits = map.queryRenderedFeatures(event.point, { layers: ['factory-point'] })
      if (factoryHits.length) {
        const factory = clickHandlers.current.factories.find(f => f.id === factoryHits[0].properties?.id)
        if (factory) {
          new maplibregl.Popup({ offset: 18, closeButton: false })
            .setLngLat(event.lngLat).setHTML(`<strong>${factory.name}</strong><br>产能 ${factory.annual_capacity_mw} MW<br>负荷 ${factory.load_percent}%`).addTo(map)
        }
      }
    })
    return () => {
      window.clearTimeout(viewportTimer)
      containerRef.current?.querySelector('.unified-tooltip')?.remove()
      map.remove(); maplibregl.removeProtocol('mapterhorn')
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    const source = (id: string, data: any) => { const s = map.getSource(id) as any; if (s) s.setData(data) }
    const selected = props.regions.find(r => r.id === props.focusRegion)
    const heatByRegion = props.projects.reduce((accumulator, project) => {
      accumulator.set(project.region_id, (accumulator.get(project.region_id) ?? 0) + project.capacity_mw)
      return accumulator
    }, new Map())
    source('regions', {
      type: 'FeatureCollection',
      features: props.regions.map(region => ({
        type: 'Feature', id: region.id, properties: {
          id: region.id, kind: 'region', heatKind: region.level, heatMw: heatByRegion.get(region.id) ?? 0,
          selected: region.id === props.focusRegion, color: '#7dd3fc',
        },
        geometry: { type: 'Polygon', coordinates: [ring(region.boundary)] },
      })),
    })
    source('farms', { type: 'FeatureCollection', features: props.farms.map(f => ({
      type: 'Feature', properties: { id: f.id, name: f.name, selected: f.id === props.focusFarm },
      geometry: { type: 'Polygon', coordinates: [ring(f.boundary)] },
    })) })
    source('farmPoints', { type: 'FeatureCollection', features: props.farms.map(f => ({ type: 'Feature', properties: { id: f.id }, geometry: { type: 'Point', coordinates: [f.lng, f.lat] } })) })
    source('realTurbines', {
      type: 'FeatureCollection',
      features: (props.realTurbines ?? []).map(turbine => ({
        type: 'Feature',
        properties: {
          farmId: turbine.farmId,
          color: REAL_FARM_COLORS[turbine.farmId] ?? '#facc15',
        },
        geometry: { type: 'Point', coordinates: [turbine.lon, turbine.lat] },
      })),
    })
    source('unifiedFarms', {
      type: 'FeatureCollection',
      features: (props.unifiedFarms ?? []).filter(farm => (
        Number.isFinite(farm.lat) && farm.lat >= -90 && farm.lat <= 90 &&
        Number.isFinite(farm.lng) && farm.lng >= -180 && farm.lng <= 180
      )).map(farm => ({
        type: 'Feature',
        properties: {
          id: farm.id, source: farm.source, name: farm.name, country: farm.country,
          capacityMw: farm.capacityMw, turbineCount: farm.turbineCount,
          commissioningYear: farm.commissioningYear,
        },
        geometry: { type: 'Point', coordinates: [farm.lng, farm.lat] },
      })),
    })
    source('unifiedTurbineHits', {
      type: 'FeatureCollection',
      features: (props.unifiedTurbines ?? []).map(turbine => ({
        type: 'Feature',
        properties: {
          id: turbine.id, source: turbine.source, name: turbine.name,
          capKw: turbine.capKw, model: turbine.model, manufacturer: turbine.manufacturer,
        },
        geometry: { type: 'Point', coordinates: [turbine.lng, turbine.lat] },
      })),
    })
    unifiedTurbineLayerRef.current?.setData(props.unifiedTurbines ?? [])
    if (map.getLayer('unified-turbines-3d')) {
      const zoom = map.getZoom()
      const metersPerPixel = 40075016.686 * Math.cos(map.getCenter().lat * Math.PI / 180) / 2 ** (zoom + 8)
      const turbineDetail = metersPerPixel * 96 / 2.54 < 1000
      map.setLayoutProperty('unified-turbines-3d', 'visibility', turbineDetail && props.layers.realWind ? 'visible' : 'none')
      map.setLayoutProperty('unified-turbine-hit', 'visibility', turbineDetail && props.layers.realWind ? 'visible' : 'none')
      map.setLayoutProperty('unified-turbine-sprites', 'visibility', turbineDetail && props.layers.realWind ? 'visible' : 'none')
      map.setLayoutProperty('unified-farm-drops', 'visibility', props.layers.realWind && !turbineDetail ? 'visible' : 'none')
    }
    source('factories', { type: 'FeatureCollection', features: props.factories.map(f => ({ type: 'Feature', properties: { id: f.id, color: FACTORY_COLORS[f.id] ?? '#38bdf8' }, geometry: { type: 'Point', coordinates: [f.lng, f.lat] } })) })
    source('substations', { type: 'FeatureCollection', features: props.substations.map(s => ({ type: 'Feature', properties: { id: s.id }, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } })) })
    const allocation = new Map((props.activePlan?.allocations ?? []).map(x => [x.project_id, x.factory_id]))
    source('projects', {
      type: 'FeatureCollection',
      features: props.projects.map(project => {
        const assignedFactory = allocation.get(project.id)
        return {
          type: 'Feature', properties: {
            id: project.id, height: 2800 + project.capacity_mw / 2,
            color: assignedFactory ? FACTORY_COLORS[assignedFactory] : (STATUS_COLORS[project.status] ?? '#94a3b8'),
          },
          geometry: { type: 'Polygon', coordinates: [[
            [project.lng - 0.045, project.lat - 0.035], [project.lng + 0.045, project.lat - 0.035],
            [project.lng + 0.045, project.lat + 0.035], [project.lng - 0.045, project.lat + 0.035],
            [project.lng - 0.045, project.lat - 0.035]]] },
        }
      }),
    })
    const activePairs = new Set((props.activePlan?.allocations ?? []).flatMap(a => [`${a.factory_id}:${a.project_id}`]))
    source('routes', {
      type: 'FeatureCollection',
      features: props.routes.map(route => ({
        type: 'Feature', properties: {
          id: route.id, active: activePairs.has(`${route.factory_id}:${route.project_id}`),
          color: activePairs.has(`${route.factory_id}:${route.project_id}`) ? (FACTORY_COLORS[route.factory_id] ?? '#38bdf8') : '#64748b',
        },
        geometry: { type: 'LineString', coordinates: ll(route.geometry) },
      })),
    })
    source('alerts', {
      type: 'FeatureCollection',
      features: props.alerts.map(alert => {
        const turbine = props.turbines.find(t => t.id === alert.source_id)
        return { type: 'Feature', properties: { id: alert.id, level: alert.level }, geometry: { type: 'Point', coordinates: turbine ? [turbine.lng, turbine.lat] : [114, 40] } }
      }).filter(feature => feature.geometry.coordinates[0] !== 114 || feature.geometry.coordinates[1] !== 40),
    })
    source('turbineHits', { type: 'FeatureCollection', features: props.turbines.map(t => ({ type: 'Feature', properties: { id: t.id }, geometry: { type: 'Point', coordinates: [t.lng, t.lat] } })) })
    source('simulationEntities', {
      type: 'FeatureCollection',
      features: (props.entities ?? []).map(entity => {
        const reverse = entity.payload?.direction === 'return' || entity.payload?.direction === 'returning'
        const position = routePosition(props.routes, entity.payload?.route_id, entity.progress, reverse) ?? entity.position
        const traveler = entity.type === 'transport_crew'
        return {
          type: 'Feature',
          properties: {
            id: entity.id, type: entity.type, status: entity.status,
            heading: traveler ? routeBearing(props.routes, entity.payload?.route_id, entity.progress, reverse) : 0,
            icon: `${entity.type}|${entity.status}|${Math.min(4, Math.floor(Math.max(0, Math.min(100, entity.progress)) / 25))}`,
            selected: entity.id === props.selectedEntityId,
          },
          geometry: { type: 'Point', coordinates: [position[1], position[0]] },
        }
      }),
    })
    const farmById = new Map(props.farms.map(farm => [farm.id, farm]))
    const projectById = new Map(props.projects.map(project => [project.id, project]))
    const flowFeatures = (props.entities ?? []).filter(entity => entity.type === 'transmission_line').flatMap(entity => {
      const from = farmById.get(entity.payload?.from_id)
      const to = projectById.get(entity.payload?.to_id)
      if (!from || !to) return []
      const flow = Number(entity.payload?.flow_mw ?? 0)
      const forwardBearing = Math.atan2((to.lng - from.lng) * Math.cos(from.lat * Math.PI / 180), to.lat - from.lat) * 180 / Math.PI
      const bearing = flow < 0 ? forwardBearing + 180 : forwardBearing
      return [{
        type: 'Feature', properties: { id: entity.id, flow, bearing },
        geometry: { type: 'LineString', coordinates: [[from.lng, from.lat], [to.lng, to.lat]] },
      }]
    })
    source('powerFlow', { type: 'FeatureCollection', features: flowFeatures })
    source('powerArrows', { type: 'FeatureCollection', features: flowFeatures })
    turbineLayerRef.current?.setData(props.turbines)
    unifiedTurbineLayerRef.current?.setData(props.unifiedTurbines ?? [])
  }, [readyTick, props.regions, props.farms, props.turbines, props.factories, props.projects, props.substations, props.routes, props.alerts, props.activePlan, props.focusRegion, props.unifiedFarms, props.unifiedTurbines])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
  const states: Record<string, string[]> = {
      regions: ['region-fill', 'region-line'], heat: ['region-heat'], windFarms: ['farm-point'],
      substations: ['substation-point'], projects: ['project-bars'],
      factories: ['factory-point'], routes: ['route-line', 'route-glow'], alerts: ['alert-point'],
      entities: ['simulation-icons', 'simulation-hit'], powerFlow: ['power-flow-glow', 'power-flow-line', 'power-flow-arrow'],
      realWind: ['real-wind-points'],
    }
    Object.entries(states).forEach(([key, layerIds]) => layerIds.forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', props.layers[key] ? 'visible' : 'none')
    }))

    let hoveredFarmId: string | null = null
    const updateFarmBoundary = () => {
      if (!map.getLayer('farm-line')) return
      map.setFilter('farm-line', [
        'any',
        ['==', ['get', 'id'], ['literal', props.focusFarm ?? '__none__']],
        ['==', ['get', 'id'], ['literal', hoveredFarmId ?? '__none__']],
      ])
      const showBoundary = props.layers.farmBoundary || props.focusFarm || hoveredFarmId
      map.setLayoutProperty('farm-line', 'visibility', showBoundary ? 'visible' : 'none')
      if (props.layers.farmBoundary) map.setFilter('farm-line', ['all'])
    }
    updateFarmBoundary()
    const handleFarmHover = (event: maplibregl.MapMouseEvent) => {
      const hits = map.queryRenderedFeatures(event.point, { layers: ['farm-hit', 'farm-point'] })
      hoveredFarmId = (hits[0]?.properties?.id as string | undefined) ?? null
      updateFarmBoundary()
    }
    const clearFarmHover = () => {
      hoveredFarmId = null
      updateFarmBoundary()
    }
    map.on('mousemove', handleFarmHover)
    map.on('mouseout', clearFarmHover)
    return () => {
      map.off('mousemove', handleFarmHover)
      map.off('mouseout', clearFarmHover)
    }
  }, [readyTick, props.layers, props.focusFarm])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current || !props.layers.routes) return
    let frame = 0
    const timer = window.setInterval(() => {
      frame = (frame + 1) % ROUTE_DASH_FRAMES.length
      if (map.getLayer('route-line')) {
        map.setPaintProperty('route-line', 'line-dasharray', ROUTE_DASH_FRAMES[frame])
      }
      if (map.getLayer('route-glow')) {
        map.setPaintProperty('route-glow', 'line-opacity', 0.10 + (frame % 2) * 0.06)
      }
    }, 110)
    return () => window.clearInterval(timer)
  }, [readyTick, props.layers.routes])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current || !props.layers.powerFlow) return
    let frame = 0
    const timer = window.setInterval(() => {
      frame = (frame + 1) % ROUTE_DASH_FRAMES.length
      if (map.getLayer('power-flow-line')) map.setPaintProperty('power-flow-line', 'line-dasharray', ROUTE_DASH_FRAMES[frame])
    }, 130)
    return () => window.clearInterval(timer)
  }, [readyTick, props.layers.powerFlow])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    if (props.focusFarm) {
      const farm = props.farms.find(f => f.id === props.focusFarm)
      if (farm) { map.flyTo({ center: [farm.lng, farm.lat], zoom: 10.8, pitch: 58, duration: 1700 }); return }
    }
    if (props.focusRegion) {
      const region = props.regions.find(r => r.id === props.focusRegion)
      if (region) { map.flyTo({ center: [region.center_lng, region.center_lat], zoom: 6.6, pitch: 58, duration: 1600 }); return }
    }
    const country = props.regions.find(r => r.level === 'country')
    if (country) {
      const b = ll(country.boundary)
      map.fitBounds([[b[0][0], b[0][1]], [b[2][0], b[2][1]]], { padding: 220, pitch: 52, duration: 1600 })
    }
  }, [props.focusRegion, props.focusFarm, props.farms, props.regions])

  return <div ref={containerRef} className="map-root" />
}
