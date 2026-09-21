import { useEffect, useRef, useState } from 'react'
import maplibregl, { Map as MLMap, StyleSpecification } from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import * as THREE from 'three'
import { TurbineLayer } from './TurbineLayer'
import type { Alert, Factory, Project, Region, Route, Substation, Turbine, WindFarm, Plan } from '../types'

type Layers = Record<string, boolean>
type Props = {
  regions: Region[]; farms: WindFarm[]; turbines: Turbine[]; factories: Factory[]; projects: Project[]
  substations: Substation[]; routes: Route[]; alerts: Alert[]; activePlan: Plan | null
  layers: Layers; period: string; focusRegion: string | null; focusFarm: string | null
  onSelectTurbine: (t: Turbine) => void; onSelectProject: (p: Project) => void
  onSelectRegion: (id: string) => void; onSelectFarm: (id: string) => void
}

const emptyFC = { type: 'FeatureCollection' as const, features: [] }
const ll = (points: number[][]) => points.map(([lat, lng]) => [lng, lat])
const ring = (points: number[][]) => ll(points)
const FACTORY_COLORS: Record<string, string> = { 'F-A': '#38bdf8', 'F-B': '#a78bfa', 'F-C': '#22c55e' }
const STATUS_COLORS: Record<string, string> = { construction: '#f97316', approved: '#38bdf8', reserve: '#94a3b8' }
const ROUTE_DASH_FRAMES = [[0, 2, 1.5, 0.5], [0.5, 1.5, 2, 0], [1, 1, 1.5, 0.5], [1.5, 0.5, 1, 1.5]]

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
      { id: 'admin-line', type: 'line', source: 'openmap', 'source-layer': 'boundary', filter: ['all', ['==', ['geometry-type'], 'LineString'], ['<=', ['to-number', ['get', 'admin_level'], 99], 6]], paint: { 'line-color': 'rgba(226,232,240,.46)', 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 8, 1.6] } },
      { id: 'hillshade', type: 'hillshade', source: 'terrain', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#001324', 'hillshade-highlight-color': '#7dd3fc' } },
    ],
  }
}

export default function TwinMap(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const turbineLayerRef = useRef<TurbineLayer | null>(null)
  const readyRef = useRef(false)
  const [readyTick, setReadyTick] = useState(0)
  const clickHandlers = useRef(props)
  clickHandlers.current = props

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
      const geoSources = ['regions', 'farms', 'farmPoints', 'projects', 'factories', 'substations', 'routes', 'alerts', 'turbineHits']
      geoSources.forEach(id => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: emptyFC }) })
      const initial = [
        { id: 'region-fill', type: 'fill', source: 'regions', filter: ['==', ['get', 'kind'], 'region'], paint: { 'fill-color': '#7dd3fc', 'fill-opacity': ['case', ['boolean', ['get', 'selected'], false], 0.06, 0.02] } },
        { id: 'region-heat', type: 'fill', source: 'regions', filter: ['==', ['get', 'heatKind'], 'province'], paint: {
          'fill-color': ['interpolate', ['linear'], ['coalesce', ['get', 'heatMw'], 0], 0, 'rgba(56,189,248,.03)', 800, 'rgba(56,189,248,.13)', 1800, 'rgba(132,204,22,.22)', 3200, 'rgba(249,115,22,.30)'],
          'fill-opacity': ['case', ['boolean', ['get', 'selected'], false], 0.82, 0.58],
        } },
        { id: 'region-line', type: 'line', source: 'regions', filter: ['==', ['get', 'kind'], 'region'], paint: { 'line-color': 'rgba(125,211,252,.82)', 'line-width': ['case', ['boolean', ['get', 'selected'], false], 3.2, 1.4] } },
        { id: 'farm-line', type: 'line', source: 'farms', paint: { 'line-color': ['case', ['boolean', ['get', 'selected'], false], '#7df3c4', 'rgba(56,189,248,.72)'], 'line-width': ['case', ['boolean', ['get', 'selected'], false], 4, 1.6], 'line-dasharray': [2, 1.5] } },
        { id: 'farm-hit', type: 'fill', source: 'farms', paint: { 'fill-color': '#7df3c4', 'fill-opacity': 0.001 } },
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
      const layer = new TurbineLayer([114.4, 40.8])
      turbineLayerRef.current = layer
      if (!map.getLayer(layer.id)) map.addLayer(layer as any)
      layer.setData(clickHandlers.current.turbines)
      setReadyTick(value => value + 1)
    })

    map.on('click', event => {
      const farmHitsFirst = map.queryRenderedFeatures(event.point, { layers: ['farm-hit'] })
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
    return () => { map.remove(); maplibregl.removeProtocol('mapterhorn') }
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
    turbineLayerRef.current?.setData(props.turbines)
  }, [readyTick, props.regions, props.farms, props.turbines, props.factories, props.projects, props.substations, props.routes, props.alerts, props.activePlan, props.focusRegion])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
  const states: Record<string, string[]> = {
      regions: ['region-fill', 'region-line'], heat: ['region-heat'], windFarms: ['farm-line', 'farm-point'],
      substations: ['substation-point'], projects: ['project-bars'],
      factories: ['factory-point'], routes: ['route-line', 'route-glow'], alerts: ['alert-point'],
    }
    Object.entries(states).forEach(([key, layerIds]) => layerIds.forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', props.layers[key] ? 'visible' : 'none')
    }))
  }, [readyTick, props.layers])

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
