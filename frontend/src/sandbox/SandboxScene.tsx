import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { METERS_PER_SCENE_UNIT } from './demSource'
import { activeTerrainProjection, projectToScene, terrainElevationRange, terrainHeight, type ScenePoint } from './terrain'
import type { MapFeatureCollection, SimulationEntity } from '../types'

export type SceneTurbine = {
  id: string
  displayId: string
  status: 'running' | 'warning' | 'fault'
  ratedPowerKw: number
  liveMw: number
  windSpeed: number
  rotorRpm: number
  lat: number
  lng: number
  x: number
  z: number
}

export type SceneSimulationEntity = SimulationEntity & {
  x: number
  z: number
  routePoints: Array<{ x: number; z: number }>
}

export type TerrainState = {
  version: number
  status: 'loading' | 'dem' | 'procedural'
  sourceText: string
}

type Props = {
  turbines: SceneTurbine[]
  selectedId: string | null
  onSelect: (id: string) => void
  night: boolean
  viewMode: 'overview' | 'top' | 'side' | 'orbit'
  basemapMode: 'current' | 'street' | 'satellite'
  terrain: TerrainState
  focusRequest?: { id: string; nonce: number } | null
  mapFeatures: MapFeatureCollection | null
  simulationEntities?: SceneSimulationEntity[]
  cameraMode?: 'follow' | 'free'
  simulationEnabled?: boolean
  onSimulationEnabledChange?: (enabled: boolean) => void
  onEntitySelect?: (id: string) => void
  onCameraModeChange?: (mode: 'follow' | 'free') => void
  onNightChange: (night: boolean) => void
  onViewModeChange: (mode: Props['viewMode']) => void
  onBasemapModeChange: (mode: Props['basemapMode']) => void
}

const TOWER_HEIGHT_UNITS = 160 / METERS_PER_SCENE_UNIT
const NACELLE_LENGTH_UNITS = 22 / METERS_PER_SCENE_UNIT
const ROTOR_RADIUS_UNITS = 58 / METERS_PER_SCENE_UNIT
function basemapZoom(sideMeters: number) {
  const mosaicMeters = 40_075_016.868 * 3
  return Math.max(11, Math.min(15, Math.floor(Math.log2(mosaicMeters / Math.max(1, sideMeters * 1.2)))))
}

function lngToTile(lng: number, zoom: number) {
  return Math.floor(((lng + 180) / 360) * 2 ** zoom)
}

type SimulationModelCache = Partial<Record<'truck', THREE.Group>>

function latToTile(lat: number, zoom: number) {
  const rad = lat * Math.PI / 180
  return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * 2 ** zoom)
}

function mercatorY(lat: number) {
  const rad = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180
  return Math.log(Math.tan(Math.PI / 4 + rad / 2)) * 6_378_137
}

function buildBasemapTiles(lat: number, lng: number, mode: 'street' | 'satellite') {
  const zoom = basemapZoom(activeTerrainProjection().sideMeters)
  const centerX = lngToTile(lng, zoom)
  const centerY = latToTile(lat, zoom)
  const tiles: Array<{ key: string; url: string; row: number; col: number }> = []
  for (let row = -1; row <= 1; row += 1) {
    for (let col = -1; col <= 1; col += 1) {
      const x = centerX + col
      const y = centerY + row
      const url = mode === 'street'
        ? `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`
        : `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${zoom}/${y}/${x}.jpg`
      tiles.push({ key: `${mode}-${zoom}-${x}-${y}`, url, row: row + 1, col: col + 1 })
    }
  }
  return tiles
}

export default function SandboxScene({
  turbines,
  selectedId,
  onSelect,
  night,
  viewMode,
  basemapMode,
  terrain,
  focusRequest,
  mapFeatures,
  simulationEntities = [],
  cameraMode = 'free',
  simulationEnabled = false,
  onSimulationEnabledChange,
  onEntitySelect,
  onCameraModeChange,
  onNightChange,
  onViewModeChange,
  onBasemapModeChange,
  style,
}: Props & { style?: React.CSSProperties }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const dataRef = useRef(turbines)
  const turbineMapRef = useRef(new Map<string, THREE.Group>())
  const bladeMapRef = useRef(new Map<string, THREE.Group>())
  const labelMapRef = useRef(new Map<string, CSS2DObject>())
  const selectedRef = useRef(selectedId)
  const nightRef = useRef(night)
  const warningLightsRef = useRef<THREE.Mesh[]>([])
  const zoomRef = useRef<((direction: number) => void) | null>(null)
  const applyViewRef = useRef<(() => void) | null>(null)
  const rebuildRef = useRef<(() => void) | null>(null)
  const viewModeRef = useRef(viewMode)
  const terrainRef = useRef(terrain)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const ambientRef = useRef<THREE.HemisphereLight | null>(null)
  const sunRef = useRef<THREE.DirectionalLight | null>(null)
  const focusNacelleRef = useRef<((id: string) => void) | null>(null)
  const terrainGeometryRef = useRef<THREE.BufferGeometry | null>(null)
  const basemapMeshRef = useRef<THREE.Mesh | null>(null)
  const gisGroupRef = useRef<THREE.Group | null>(null)
  const simulationGroupRef = useRef<THREE.Group | null>(null)
  const simulationObjectsRef = useRef(new Map<string, THREE.Object3D>())
  const simulationSiteAssembliesRef = useRef(new Map<string, { tower: THREE.Mesh; nacelle: THREE.Group; rotor: THREE.Group; pad: THREE.Mesh }>())
  const simulationEntitiesRef = useRef(simulationEntities)
  const rebuildSimulationRef = useRef<(() => void) | null>(null)
  const simulationModelsRef = useRef<SimulationModelCache>({})
  const cameraModeRef = useRef(cameraMode)
  const selectedEntityRef = useRef(selectedId)

  dataRef.current = turbines
  simulationEntitiesRef.current = simulationEntities
  cameraModeRef.current = cameraMode
  selectedEntityRef.current = selectedId
  selectedRef.current = selectedId
  nightRef.current = night
  viewModeRef.current = viewMode
  terrainRef.current = terrain

  const projection = activeTerrainProjection()
  const centerLat = dataRef.current.length ? dataRef.current.reduce((sum, item) => sum + item.lat, 0) / dataRef.current.length : 41.05
  const centerLng = dataRef.current.length ? dataRef.current.reduce((sum, item) => sum + item.lng, 0) / dataRef.current.length : 111.45
  const zoom = basemapZoom(activeTerrainProjection().sideMeters)
  const basemapTiles = basemapMode === 'current' ? [] : buildBasemapTiles(centerLat, centerLng, basemapMode)
  const centerXTile = lngToTile(centerLng, zoom)
  const centerYTile = latToTile(centerLat, zoom)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const projection = activeTerrainProjection()
    const size = projection.sideMeters / 30
    const half = size / 2
    const elevationRange = terrainElevationRange()

    const scene = new THREE.Scene()
    sceneRef.current = scene
    scene.background = new THREE.Color(nightRef.current ? '#010806' : '#a8d8ea')

    const camera = new THREE.PerspectiveCamera(42, mount.clientWidth / mount.clientHeight, 0.1, Math.max(1800, size * 6))
    cameraRef.current = camera
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = false
    renderer.domElement.classList.add('sandbox-canvas')
    mount.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controlsRef.current = controls

    const labelRenderer = new CSS2DRenderer()
    labelRenderer.setSize(mount.clientWidth, mount.clientHeight)
    labelRenderer.domElement.classList.add('sandbox-labels')
    mount.appendChild(labelRenderer.domElement)

    controls.enableDamping = true
    controls.dampingFactor = 0.07
    controls.maxPolarAngle = Math.PI * 0.485
    controls.minDistance = Math.max(30, size * 0.12)
    controls.maxDistance = Math.max(360, size * 2.2)
    controls.target.set(0, 10, 0)

    const ambient = new THREE.HemisphereLight('#d8ffe8', '#173626', nightRef.current ? 0.42 : 1.5)
    ambientRef.current = ambient
    scene.add(ambient)
    const sun = new THREE.DirectionalLight('#fff6df', nightRef.current ? 0.22 : 2.6)
    sunRef.current = sun
    sun.position.set(size * 0.44, size * 0.62, size * 0.34)
    scene.add(sun)
    const rim = new THREE.DirectionalLight('#9ff5c8', night ? 0.28 : 0.72)
    rim.position.set(-size * 0.48, size * 0.28, -size * 0.4)
    scene.add(rim)

    // Quantized DEM elevation colors preserve the sand-table contour style.
    const segments = Math.min(300, Math.max(180, Math.round(size / 0.75)))
    const terrainGeometry = new THREE.PlaneGeometry(size, size, segments, segments)
    terrainGeometry.rotateX(-Math.PI / 2)
    const positions = terrainGeometry.attributes.position
    const colors = new Float32Array(positions.count * 3)
    const low = new THREE.Color('#132b20')
    const valley = new THREE.Color('#245138')
    const mid = new THREE.Color('#3f7349')
    const high = new THREE.Color('#79995c')
    const peak = new THREE.Color('#a9bd7c')
    const workColor = new THREE.Color()
    for (let index = 0; index < positions.count; index += 1) {
      const x = positions.getX(index)
      const z = positions.getZ(index)
      const y = terrainHeight(x, z)
      positions.setY(index, y)
      const normalized = Math.max(0, Math.min(1, (y - elevationRange.min) / (elevationRange.max - elevationRange.min)))
      const band = Math.pow(normalized, 0.68)
      if (band < 0.18) workColor.copy(low).lerp(valley, band / 0.18)
      else if (band < 0.46) workColor.copy(valley).lerp(mid, (band - 0.18) / 0.28)
      else if (band < 0.78) workColor.copy(mid).lerp(high, (band - 0.46) / 0.32)
      else workColor.copy(high).lerp(peak, Math.min(1, (band - 0.78) / 0.22))
      const reliefStep = size / segments
      const eastRelief = terrainHeight(x + reliefStep, z) - y
      const southRelief = terrainHeight(x, z + reliefStep) - y
      const slopeShade = Math.max(0.78, Math.min(1.24, 1 + (eastRelief + southRelief) * 0.03))
      const demBoost = terrainRef.current.status === 'dem' ? 1.38 : 1
      workColor.multiplyScalar(demBoost * slopeShade * (0.94 + (Math.sin(x * 2.7) + Math.cos(z * 3.1)) * 0.035))
      colors[index * 3] = workColor.r
      colors[index * 3 + 1] = workColor.g
      colors[index * 3 + 2] = workColor.b
    }
    terrainGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    terrainGeometry.computeVertexNormals()
    scene.add(new THREE.Mesh(terrainGeometry, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.88, metalness: 0.02, flatShading: true,
    })))

    // Bevelled skirt follows the exact rectangular DEM boundary.
    const bottomScale = 1.13
    const bottomY = -Math.max(12, elevationRange.max * 0.28)
    const edgePoints: THREE.Vector3[] = []
    const edgeStep = Math.max(3, size / 64)
    for (let x = -half; x <= half; x += edgeStep) edgePoints.push(new THREE.Vector3(x, terrainHeight(x, -half), -half))
    for (let z = -half; z <= half; z += edgeStep) edgePoints.push(new THREE.Vector3(half, terrainHeight(half, z), z))
    for (let x = half; x >= -half; x -= edgeStep) edgePoints.push(new THREE.Vector3(x, terrainHeight(x, half), half))
    for (let z = half; z >= -half; z -= edgeStep) edgePoints.push(new THREE.Vector3(-half, terrainHeight(-half, z), z))
    const skirtGeometry = new THREE.BufferGeometry()
    const skirtVertices: number[] = []
    for (let index = 0; index < edgePoints.length; index += 1) {
      const current = edgePoints[index]
      const next = edgePoints[(index + 1) % edgePoints.length]
      const cBottom = new THREE.Vector3(current.x * bottomScale, bottomY, current.z * bottomScale)
      const nBottom = new THREE.Vector3(next.x * bottomScale, bottomY, next.z * bottomScale)
      skirtVertices.push(
        current.x, current.y, current.z, next.x, next.y, next.z, cBottom.x, cBottom.y, cBottom.z,
        next.x, next.y, next.z, nBottom.x, nBottom.y, nBottom.z, cBottom.x, cBottom.y, cBottom.z,
      )
    }
    skirtGeometry.setAttribute('position', new THREE.Float32BufferAttribute(skirtVertices, 3))
    skirtGeometry.computeVertexNormals()
    scene.add(new THREE.Mesh(skirtGeometry, new THREE.MeshStandardMaterial({
      color: '#101d21', roughness: 0.65, metalness: 0.18, side: THREE.DoubleSide,
    })))
    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(size * bottomScale, 3, size * bottomScale),
      new THREE.MeshStandardMaterial({ color: '#0a1418', roughness: 0.55, metalness: 0.22 }),
    )
    plinth.position.y = bottomY - 1.5
    scene.add(plinth)

    terrainGeometryRef.current = terrainGeometry

    const modelScale = 1
    const towerGeometry = new THREE.CylinderGeometry(0.055, 0.12, TOWER_HEIGHT_UNITS, 18)
    towerGeometry.translate(0, TOWER_HEIGHT_UNITS / 2, 0)
    const nacelleGeometry = new THREE.BoxGeometry(NACELLE_LENGTH_UNITS, 0.28, 0.24)
    const hubGeometry = new THREE.SphereGeometry(0.16, 16, 12)
    const bladeProfile = new THREE.Shape()
    bladeProfile.moveTo(0, 0)
    bladeProfile.quadraticCurveTo(0.045, ROTOR_RADIUS_UNITS * 0.42, 0.012, ROTOR_RADIUS_UNITS)
    bladeProfile.lineTo(-0.018, ROTOR_RADIUS_UNITS)
    bladeProfile.quadraticCurveTo(-0.038, ROTOR_RADIUS_UNITS * 0.42, -0.032, 0)
    bladeProfile.closePath()
    const bladeGeometry = new THREE.ExtrudeGeometry(bladeProfile, { depth: 0.032, bevelEnabled: false })
    bladeGeometry.translate(0, 0, -0.016)
    const warningGeometry = new THREE.SphereGeometry(0.12, 10, 8)

    const buildTurbines = () => {
      turbineMapRef.current.forEach(group => {
        scene.remove(group)
        group.traverse(child => {
          const mesh = child as THREE.Mesh
          if (mesh.isMesh) (mesh.material as THREE.MeshStandardMaterial)?.dispose()
        })
      })
      turbineMapRef.current.clear()
      bladeMapRef.current.clear()
      labelMapRef.current.clear()
      warningLightsRef.current = []

      dataRef.current.forEach((turbine, index) => {
        const x = turbine.x
        const z = turbine.z
        const ground = terrainHeight(x, z)
        const group = new THREE.Group()
        group.position.set(x, ground, z)
        group.scale.setScalar(modelScale)
        group.rotation.y = 0.65 + index * 0.18
        group.userData = { turbineId: turbine.id, clickable: true }

        const statusColor = turbine.status === 'fault' ? '#ff5a48' : turbine.status === 'warning' ? '#ffb020' : '#f8fbff'
        const bodyMaterial = new THREE.MeshStandardMaterial({
          color: '#e9edee', roughness: 0.48, metalness: 0.08,
          emissive: new THREE.Color(statusColor).multiplyScalar(selectedRef.current === turbine.id ? 0.24 : turbine.status === 'fault' ? 0.16 : 0.02),
        })
        const tower = new THREE.Mesh(towerGeometry, bodyMaterial)
        const nacelle = new THREE.Mesh(nacelleGeometry, bodyMaterial)
        nacelle.position.set(NACELLE_LENGTH_UNITS * 0.34, TOWER_HEIGHT_UNITS, 0)
        const hub = new THREE.Mesh(hubGeometry, bodyMaterial)
        hub.position.set(NACELLE_LENGTH_UNITS * 0.78, TOWER_HEIGHT_UNITS, 0)

        const rotor = new THREE.Group()
        rotor.position.copy(hub.position)
        rotor.userData = { turbineId: turbine.id, clickable: true }
        for (let bladeIndex = 0; bladeIndex < 3; bladeIndex += 1) {
          const blade = new THREE.Mesh(bladeGeometry, bodyMaterial)
          blade.rotation.x = (bladeIndex * Math.PI * 2) / 3
          blade.userData = { turbineId: turbine.id, clickable: true }
          rotor.add(blade)
        }
        const lampColor = turbine.status === 'fault' ? '#ff3b28' : '#ffb020'
        const warning = new THREE.Mesh(warningGeometry, new THREE.MeshStandardMaterial({
          color: lampColor, emissive: lampColor, emissiveIntensity: nightRef.current ? 1.5 : 0.35,
        }))
        warning.position.set(0, TOWER_HEIGHT_UNITS + 0.28, 0)
        warning.userData = { status: turbine.status }
        warning.visible = turbine.status !== 'running'
        warningLightsRef.current.push(warning)

        const labelElement = document.createElement('button')
        labelElement.className = `scene-tag status-${turbine.status}${selectedRef.current === turbine.id ? ' selected' : ''}`
        labelElement.innerHTML = `<b>${turbine.displayId}</b><span>-- MW</span>`
        labelElement.addEventListener('click', event => {
          event.stopPropagation()
          onSelect(turbine.id)
        })
        const label = new CSS2DObject(labelElement)
        label.position.set(0, TOWER_HEIGHT_UNITS + ROTOR_RADIUS_UNITS + 1.2, 0)

        group.add(tower, nacelle, hub, rotor, warning, label)
        scene.add(group)
        turbineMapRef.current.set(turbine.id, group)
        bladeMapRef.current.set(turbine.id, rotor)
        labelMapRef.current.set(turbine.id, label)
      })
    }
    buildTurbines()
    rebuildRef.current = buildTurbines

    const lowPolyMaterial = (color: string, options: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({
      color, roughness: 0.58, metalness: 0.12, ...options,
    })
    const cloneSimulationModel = (model: THREE.Group) => {
      const clone = model.clone(true)
      clone.traverse(child => {
        const mesh = child as THREE.Mesh
        if (mesh.isMesh) {
          mesh.material = Array.isArray(mesh.material)
            ? mesh.material.map(material => material.clone())
            : mesh.material.clone()
          mesh.userData.sharedModel = true
        }
      })
      return clone
    }
    const makeTruck = () => {
      const model = simulationModelsRef.current.truck
      if (model) return cloneSimulationModel(model)
      const group = new THREE.Group()
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.16, 0.24), lowPolyMaterial('#3fa9f5'))
      body.position.y = 0.17
      const cab = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.16, 0.22), lowPolyMaterial('#e8fbff'))
      cab.position.set(0.21, 0.31, 0)
      group.add(body, cab)
      const wheelGeometry = new THREE.CylinderGeometry(0.055, 0.055, 0.05, 8)
      wheelGeometry.rotateX(Math.PI / 2)
      const wheelMaterial = lowPolyMaterial('#111827')
      for (const offset of [[-0.16, -0.11], [-0.16, 0.11], [0.17, -0.11], [0.17, 0.11]]) {
        const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial)
        wheel.position.set(offset[0], 0.055, offset[1])
        group.add(wheel)
      }
      return group
    }
    const makeCrane = () => {
      const group = new THREE.Group()
      const crawlerMaterial = lowPolyMaterial('#39424e', { roughness: 0.7, metalness: 0.18 })
      const craneMaterial = lowPolyMaterial('#f4b429', { roughness: 0.45, metalness: 0.16 })
      const steelMaterial = lowPolyMaterial('#e7edf3', { roughness: 0.38, metalness: 0.22 })
      for (const offset of [-0.16, 0.16]) {
        const track = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.16, 0.24), crawlerMaterial)
        track.position.set(0, 0.09, offset)
        group.add(track)
      }
      const carBody = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.17, 0.42), craneMaterial)
      carBody.position.y = 0.25
      const counterweight = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.28, 0.40), lowPolyMaterial('#556270'))
      counterweight.position.set(-0.24, 0.38, 0)
      const cab = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.13, 0.15), lowPolyMaterial('#243447', { roughness: 0.24, metalness: 0.04 }))
      cab.position.set(0.21, 0.39, 0.14)
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.032, 0.38, 8), steelMaterial)
      mast.position.set(0.16, 0.55, 0)
      const boom = new THREE.Group()
      boom.position.set(0.16, 0.62, 0)
      const boomSection = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 3.33), steelMaterial)
      boomSection.position.z = -3.33 / 2
      const boomTip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.34), craneMaterial)
      boomTip.position.z = -3.45
      boom.add(boomSection, boomTip)
      const assembly = new THREE.Group()
      assembly.userData.isCraneAssembly = true
      const componentMaterial = lowPolyMaterial('#eef4f7', { roughness: 0.42, metalness: 0.05 })
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.044, 0.34, 12), componentMaterial)
      tower.position.y = 0.17
      const nacelle = new THREE.Group()
      nacelle.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.1), componentMaterial))
      nacelle.position.y = 0.36
      const rotor = new THREE.Group()
      const bladeProfile = new THREE.Shape()
      bladeProfile.moveTo(0, 0)
      bladeProfile.quadraticCurveTo(0.028, 0.5, 0.008, 1.18)
      bladeProfile.lineTo(-0.012, 1.18)
      bladeProfile.quadraticCurveTo(-0.024, 0.5, -0.018, 0)
      bladeProfile.closePath()
      const bladeGeometry = new THREE.ExtrudeGeometry(bladeProfile, { depth: 0.02, bevelEnabled: false })
      bladeGeometry.translate(0, 0, -0.01)
      for (let index = 0; index < 3; index += 1) rotor.add(new THREE.Mesh(bladeGeometry, componentMaterial))
      rotor.children.forEach((blade, index) => { blade.rotation.x = index * Math.PI * 2 / 3 })
      rotor.position.z = -0.12
      nacelle.add(rotor)
      assembly.add(tower, nacelle)
      assembly.position.set(0.16, 0.65, -2.55)
      group.add(carBody, counterweight, cab, mast, boom, assembly)
      group.userData.craneBoom = boom
      return { group, tower, nacelle, rotor, assembly }
    }
    const makeStorage = () => {
      const group = new THREE.Group()
      const shell = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.28, 0.25), lowPolyMaterial('#164e63', { transparent: true, opacity: 0.62 }))
      shell.position.y = 0.14
      const fillGeometry = new THREE.BoxGeometry(0.5, 0.22, 0.18)
      fillGeometry.translate(0, 0.11, 0)
      const fill = new THREE.Mesh(fillGeometry, lowPolyMaterial('#22d3ee', { emissive: new THREE.Color('#22d3ee'), emissiveIntensity: 0.24 }))
      fill.scale.y = 0.5
      fill.position.y = 0.03
      group.add(shell, fill)
      return { group, fill }
    }
    const makeSiteAssembly = () => {
      const group = new THREE.Group()
      const pad = new THREE.Mesh(new THREE.CircleGeometry(0.8, 16), lowPolyMaterial('#77836f', { transparent: true, opacity: 0.5 }))
      pad.rotation.x = -Math.PI / 2
      pad.position.y = 0.025
      const componentMaterial = lowPolyMaterial('#eef4f6', { roughness: 0.42, metalness: 0.05 })
      const towerGeometry = new THREE.CylinderGeometry(0.07, 0.12, TOWER_HEIGHT_UNITS, 14)
      towerGeometry.translate(0, TOWER_HEIGHT_UNITS / 2, 0)
      const tower = new THREE.Mesh(towerGeometry, componentMaterial)
      const nacelle = new THREE.Group()
      nacelle.add(new THREE.Mesh(new THREE.BoxGeometry(NACELLE_LENGTH_UNITS, 0.2, 0.18), componentMaterial))
      const rotor = new THREE.Group()
      const bladeProfile = new THREE.Shape()
      bladeProfile.moveTo(0, 0)
      bladeProfile.quadraticCurveTo(0.042, ROTOR_RADIUS_UNITS * 0.42, 0.012, ROTOR_RADIUS_UNITS)
      bladeProfile.lineTo(-0.016, ROTOR_RADIUS_UNITS)
      bladeProfile.quadraticCurveTo(-0.034, ROTOR_RADIUS_UNITS * 0.42, -0.03, 0)
      bladeProfile.closePath()
      const bladeGeometry = new THREE.ExtrudeGeometry(bladeProfile, { depth: 0.026, bevelEnabled: false })
      bladeGeometry.translate(0, 0, -0.013)
      for (let index = 0; index < 3; index += 1) rotor.add(new THREE.Mesh(bladeGeometry, componentMaterial))
      rotor.children.forEach((blade, index) => { blade.rotation.x = index * Math.PI * 2 / 3 })
      rotor.position.z = -NACELLE_LENGTH_UNITS * 0.45
      nacelle.add(rotor)
      group.add(pad, tower, nacelle)
      return { group, tower, nacelle, rotor, pad }
    }
    const buildSimulation = () => {
      if (simulationGroupRef.current) {
        scene.remove(simulationGroupRef.current)
        simulationGroupRef.current.traverse(child => {
          const mesh = child as THREE.Mesh
          if (mesh.isMesh && !mesh.userData.sharedModel) {
            mesh.geometry.dispose()
            ;(mesh.material as THREE.Material)?.dispose()
          }
        })
      }
      const root = new THREE.Group()
      simulationGroupRef.current = root
      simulationObjectsRef.current.clear()
      simulationSiteAssembliesRef.current.clear()

      simulationEntitiesRef.current.forEach(entity => {
        if (entity.type === 'transport_crew') {
          const truck = makeTruck()
          root.add(truck); simulationObjectsRef.current.set(entity.id, truck)
        } else if (entity.type === 'crane') {
          const crane = makeCrane()
          root.add(crane.group); simulationObjectsRef.current.set(entity.id, crane.group)
        } else if (entity.type === 'storage_unit') {
          const storage = makeStorage()
          root.add(storage.group); simulationObjectsRef.current.set(entity.id, storage.group)
          storage.group.userData.storageFill = storage.fill
        } else if (entity.type === 'production_equipment') {
          const building = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.4, 0.7), lowPolyMaterial('#94a3b8'))
          building.position.set(entity.x, terrainHeight(entity.x, entity.z) + 0.2, entity.z)
          root.add(building); simulationObjectsRef.current.set(entity.id, building)
        } else if (entity.type === 'wind_turbine_site') {
          const assembly = makeSiteAssembly()
          assembly.group.position.set(entity.x, terrainHeight(entity.x, entity.z), entity.z)
          root.add(assembly.group); simulationObjectsRef.current.set(entity.id, assembly.group)
          simulationSiteAssembliesRef.current.set(entity.id, { tower: assembly.tower, nacelle: assembly.nacelle, rotor: assembly.rotor, pad: assembly.pad })
        }
      })

      simulationEntitiesRef.current.filter(entity => entity.type === 'transmission_line').forEach(entity => {
        if (entity.routePoints.length < 2) return
        const points = entity.routePoints.map(point => new THREE.Vector3(point.x, terrainHeight(point.x, point.z) + 0.08, point.z))
        const curve = new THREE.CatmullRomCurve3(points)
        const curvePoints = curve.getPoints(38)
        root.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(curvePoints),
          new THREE.LineBasicMaterial({ color: '#7df3c4', transparent: true, opacity: 0.34 }),
        ))
        const dots = new THREE.InstancedMesh(
          new THREE.SphereGeometry(0.035, 6, 5),
          new THREE.MeshBasicMaterial({ color: '#a7f3d0' }),
          20,
        )
        dots.frustumCulled = false
        dots.userData = { flowCurve: curvePoints, flowOffset: 0 }
        root.add(dots); simulationObjectsRef.current.set(entity.id, dots)
      })
      scene.add(root)
    }
    buildSimulation()
    rebuildSimulationRef.current = buildSimulation

    let modelLoadCancelled = false
    let modelLoadTimer = 0
    const loadSimulationModels = () => new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('model load timeout')), 12_000)
      modelLoadTimer = timeout
      new GLTFLoader().load(
        '/models/truck-flat.glb',
        gltf => {
          window.clearTimeout(timeout)
          const source = gltf.scene
          const measurement = new THREE.Group()
          measurement.add(source)
          measurement.updateMatrixWorld(true)
          const bounds = new THREE.Box3().setFromObject(measurement)
          const center = bounds.getCenter(new THREE.Vector3())
          const size = bounds.getSize(new THREE.Vector3())
          source.position.set(-center.x, -bounds.min.y, -center.z)
          const normalized = new THREE.Group()
          const scaler = new THREE.Group()
          scaler.scale.setScalar(16 / Math.max(size.z, Number.EPSILON))
          scaler.rotation.y = Math.PI / 2
          scaler.add(source)
          normalized.add(scaler)
          simulationModelsRef.current.truck = normalized
          resolve()
        },
        undefined,
        reject,
      )
    })

    loadSimulationModels()
      .then(() => {
        if (!modelLoadCancelled) rebuildSimulationRef.current?.()
      })
      .catch(() => {
        if (!modelLoadCancelled) simulationModelsRef.current.truck = undefined
      })
      .finally(() => window.clearTimeout(modelLoadTimer))

    const fitCamera = () => {
      const points: ScenePoint[] = dataRef.current.length
        ? dataRef.current
        : [{ x: -half * 0.5, z: -half * 0.5 }, { x: half * 0.5, z: half * 0.5 }]
      const minX = Math.min(...points.map(point => point.x))
      const maxX = Math.max(...points.map(point => point.x))
      const minZ = Math.min(...points.map(point => point.z))
      const maxZ = Math.max(...points.map(point => point.z))
      const centerX = (minX + maxX) / 2
      const centerZ = (minZ + maxZ) / 2
      const targetY = terrainHeight(centerX, centerZ) + (elevationRange.max - elevationRange.min) * 0.25
      const radius = Math.max(60, Math.hypot(maxX - minX, maxZ - minZ) / 2, size * 0.13)
      const verticalFov = (camera.fov * Math.PI) / 180
      const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect)
      const distance = (radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2)) * 1.08
      const direction = new THREE.Vector3(0.78, 0.60, 0.90).normalize()
      const center = new THREE.Vector3(centerX, targetY, centerZ)
      controls.target.copy(center)
      camera.position.copy(center).addScaledVector(direction, distance)
      camera.updateProjectionMatrix()
      controls.update()
    }
    fitCamera()
    applyViewRef.current = fitCamera

    const applyView = () => {
      const points = dataRef.current
      const xs = points.map(point => point.x)
      const zs = points.map(point => point.z)
      const centerX = points.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0
      const centerZ = points.length ? (Math.min(...zs) + Math.max(...zs)) / 2 : 0
      const targetY = terrainHeight(centerX, centerZ) + 12 * modelScale
      const radius = Math.max(60, points.length ? Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2 : half * 0.5)
      const verticalFov = (camera.fov * Math.PI) / 180
      const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect)
      const distance = (radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2)) * 1.08
      controls.target.set(centerX, targetY, centerZ)
      if (viewModeRef.current === 'overview') {
        camera.position.set(centerX + distance * 0.55, targetY + distance * 0.48, centerZ + distance * 0.64)
      } else if (viewModeRef.current === 'top') {
        camera.position.set(centerX, targetY + distance, centerZ + 0.5)
      } else if (viewModeRef.current === 'side') {
        camera.position.set(centerX + distance * 0.92, targetY + distance * 0.18, centerZ)
      } else {
        camera.position.set(centerX + distance * 0.48, targetY + distance * 0.38, centerZ + distance * 0.54)
      }
      controls.update()
    }
    applyViewRef.current = applyView
    applyView()

    focusNacelleRef.current = id => {
      const turbine = dataRef.current.find(item => item.id === id)
      if (!turbine) return
      const ground = terrainHeight(turbine.x, turbine.z)
      const target = new THREE.Vector3(turbine.x, ground + TOWER_HEIGHT_UNITS, turbine.z)
      const offset = new THREE.Vector3(7.5, 4.2, 8.4)
      controls.minDistance = 3
      controls.target.copy(target)
      camera.position.copy(target).add(offset)
      camera.near = 0.05
      camera.updateProjectionMatrix()
      controls.update()
    }

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let downPosition = { x: 0, y: 0 }
    const onPointerDown = (event: PointerEvent) => { downPosition = { x: event.clientX, y: event.clientY } }
    const onPointerUp = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - downPosition.x, event.clientY - downPosition.y) > 5) return
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const targets: THREE.Object3D[] = []
      turbineMapRef.current.forEach(group => targets.push(group, ...group.children))
      const hits = raycaster.intersectObjects(targets, true)
      const hit = hits.find(item => item.object.userData.turbineId)
      if (hit) onSelect(String(hit.object.userData.turbineId))
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointerup', onPointerUp)

    const resize = () => {
      if (!mount.clientWidth || !mount.clientHeight) return
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
      labelRenderer.setSize(mount.clientWidth, mount.clientHeight)
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(mount)

    let frame = 0
    let last = performance.now()
    let orbitAngle = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z)
    const tick = () => {
      frame = requestAnimationFrame(tick)
      const now = performance.now()
      const delta = Math.min(0.05, (now - last) / 1000)
      last = now
      controls.update()

      const blink = 0.45 + Math.sin(now * 0.008) * 0.55
      dataRef.current.forEach((turbine, index) => {
        const rotor = bladeMapRef.current.get(turbine.id)
        if (rotor) {
          const speed = turbine.status === 'running' ? 0.58 + (index % 4) * 0.08 : turbine.status === 'warning' ? 0.20 : 0
          rotor.rotation.x -= speed * delta
        }
        const label = labelMapRef.current.get(turbine.id)
        if (label) {
          const element = label.element as HTMLButtonElement
          const span = element.querySelector('span')
          if (span) span.textContent = `${turbine.liveMw.toFixed(2)} MW`
        }
      })
      warningLightsRef.current.forEach((light, index) => {
        if (light.userData.status === 'running') {
          light.visible = false
          return
        }
        const material = light.material as THREE.MeshStandardMaterial
        material.emissiveIntensity = nightRef.current ? 0.35 + blink * 1.9 : 0.25 + blink * 0.25
        if (nightRef.current && index % 4 === 0) light.visible = blink > 0.18
        else light.visible = true
      })
      simulationGroupRef.current?.traverse(child => {
        const dots = child as THREE.InstancedMesh
        if (!dots.isInstancedMesh) return
        const curve = dots.userData.flowCurve as THREE.Vector3[]
        const count = Number(dots.userData.visibleCount ?? 0)
        dots.userData.flowOffset = (Number(dots.userData.flowOffset ?? 0) + Number(dots.userData.flowSpeed ?? 0.04) * delta) % 1
        const matrix = new THREE.Matrix4()
        const scaleVector = new THREE.Vector3()
        for (let index = 0; index < dots.count; index += 1) {
          const phase = (Number(dots.userData.flowOffset) + index / Math.max(1, dots.count)) % 1
          const pointIndex = phase * (curve.length - 1)
          const from = curve[Math.floor(pointIndex)]
          const to = curve[Math.min(curve.length - 1, Math.floor(pointIndex) + 1)]
          const alpha = pointIndex - Math.floor(pointIndex)
          scaleVector.setScalar(index < count ? 1 : 0)
          matrix.compose(from.clone().lerp(to, alpha), new THREE.Quaternion(), scaleVector)
          dots.setMatrixAt(index, matrix)
        }
        dots.instanceMatrix.needsUpdate = true
      })

      if (viewModeRef.current === 'orbit') {
        const orbitDistance = camera.position.distanceTo(controls.target)
        orbitAngle += delta * 0.12
        camera.position.set(
          controls.target.x + Math.sin(orbitAngle) * orbitDistance,
          controls.target.y + orbitDistance * 0.35,
          controls.target.z + Math.cos(orbitAngle) * orbitDistance,
        )
      }
      if (cameraModeRef.current === 'follow' && selectedEntityRef.current) {
        const targetObject = simulationObjectsRef.current.get(selectedEntityRef.current)
          ?? turbineMapRef.current.get(selectedEntityRef.current)
        if (targetObject) {
          const worldTarget = new THREE.Vector3()
          targetObject.getWorldPosition(worldTarget)
          const isSimulation = simulationObjectsRef.current.has(selectedEntityRef.current)
          worldTarget.y += isSimulation ? 0.35 : TOWER_HEIGHT_UNITS * 0.8
          if (isSimulation) {
            controls.target.copy(worldTarget)
            camera.position.copy(worldTarget).add(new THREE.Vector3(3.2, 1.6, 4.4))
          } else controls.target.lerp(worldTarget, 0.08)
        }
      }
      renderer.render(scene, camera)
      labelRenderer.render(scene, camera)
    }
    tick()

    zoomRef.current = direction => {
      const directionVector = camera.position.clone().sub(controls.target).multiplyScalar(direction > 0 ? 0.82 : 1.22)
      const next = controls.target.clone().add(directionVector)
      if (next.distanceTo(controls.target) >= controls.minDistance && next.distanceTo(controls.target) <= controls.maxDistance) camera.position.copy(next)
    }

    return () => {
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      controls.dispose()
      terrainGeometry.dispose()
      skirtGeometry.dispose()
      bladeGeometry.dispose()
      towerGeometry.dispose()
      nacelleGeometry.dispose()
      hubGeometry.dispose()
      warningGeometry.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
      mount.removeChild(labelRenderer.domElement)
      sceneRef.current = null
      cameraRef.current = null
      controlsRef.current = null
      focusNacelleRef.current = null
      rebuildSimulationRef.current = null
      simulationModelsRef.current = {}
    }
    // A terrain version change deliberately rebuilds the WebGL scene around the new DEM extent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrain.version])

  useEffect(() => {
    const scene = sceneRef.current
    const terrainGeometry = terrainGeometryRef.current
    if (!scene || !terrainGeometry) return
    if (basemapMode === 'current') {
      if (basemapMeshRef.current) scene.remove(basemapMeshRef.current)
      basemapMeshRef.current = null
      return
    }

    let cancelled = false
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.82,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
    const overlay = new THREE.Mesh(terrainGeometry, material)
    overlay.renderOrder = 2
    scene.add(overlay)
    basemapMeshRef.current = overlay

    const loader = new THREE.TextureLoader()
    const west = centerXTile / 2 ** zoom * 360 - 180
    const east = (centerXTile + 1) / 2 ** zoom * 360 - 180
    const northLatRad = Math.PI - 2 * Math.PI * centerYTile / 2 ** zoom
    const southLatRad = Math.PI - 2 * Math.PI * (centerYTile + 1) / 2 ** zoom
    const north = mercatorY(Math.atan(Math.sinh(northLatRad)) * 180 / Math.PI)
    const south = mercatorY(Math.atan(Math.sinh(southLatRad)) * 180 / Math.PI)
    const westMeters = (west * Math.PI) / 180 * 6_378_137
    const eastMeters = (east * Math.PI) / 180 * 6_378_137

    Promise.all(basemapTiles.map(tile => loader.loadAsync(tile.url).then(texture => ({ tile, texture }))))
      .then(entries => {
        if (cancelled) return
        const tileSize = 256
        const canvas = document.createElement('canvas')
        canvas.width = tileSize * 3
        canvas.height = tileSize * 3
        const context = canvas.getContext('2d')
        if (!context) return
        entries.forEach(({ tile, texture }) => {
          context.drawImage(texture.image as HTMLImageElement, tile.col * tileSize, tile.row * tileSize, tileSize, tileSize)
          texture.dispose()
        })
        const mapTexture = new THREE.CanvasTexture(canvas)
        mapTexture.colorSpace = THREE.SRGBColorSpace
        mapTexture.wrapS = THREE.ClampToEdgeWrapping
        mapTexture.wrapT = THREE.ClampToEdgeWrapping
        const projection = activeTerrainProjection()
        const bounds = projection.sideMeters / 2
        mapTexture.repeat.set(
          projection.sideMeters / (eastMeters - westMeters),
          projection.sideMeters / (north - south),
        )
        mapTexture.offset.set(
          (projection.centerX - bounds - westMeters) / (eastMeters - westMeters),
          (projection.centerZ - bounds - south) / (north - south),
        )
        material.map = mapTexture
        material.needsUpdate = true
      })
      .catch(() => {
        if (!cancelled) material.opacity = 0
      })

    return () => {
      cancelled = true
      scene.remove(overlay)
      material.map?.dispose()
      material.dispose()
      if (basemapMeshRef.current === overlay) basemapMeshRef.current = null
    }
    // Tile centers only change when a new farm projection has replaced the terrain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemapMode, terrain.version])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    if (gisGroupRef.current) {
      scene.remove(gisGroupRef.current)
      gisGroupRef.current.traverse(child => {
        const mesh = child as THREE.Mesh
        if (mesh.isMesh) {
          mesh.geometry.dispose()
          ;(mesh.material as THREE.Material)?.dispose()
        }
      })
    }

    const group = new THREE.Group()
    gisGroupRef.current = group
    const boundaryMaterial = new THREE.LineBasicMaterial({ color: '#7df3c4', transparent: true, opacity: 0.72 })
    const cableMaterial = new THREE.LineBasicMaterial({ color: '#67e8f9', transparent: true, opacity: 0.32 })
    mapFeatures?.features.forEach(feature => {
      const { kind, name } = feature.properties
      if (feature.geometry.type === 'Polygon' && kind === 'wind_farm') {
        const ring = feature.geometry.coordinates[0] as Array<[number, number]>
        const points = ring.map(([lat, lng]) => {
          const place = projectToScene(lat, lng)
          return new THREE.Vector3(place.x, terrainHeight(place.x, place.z) + 0.35, place.z)
        })
        group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), boundaryMaterial))
      }

      if (feature.geometry.type === 'Point' && (kind === 'label' || kind === 'substation')) {
        const [lng, lat] = feature.geometry.coordinates as [number, number]
        const place = projectToScene(lat, lng)
        if (kind === 'substation') {
          const station = new THREE.Group()
          const base = new THREE.Mesh(
            new THREE.BoxGeometry(14, 0.7, 10),
            new THREE.MeshStandardMaterial({ color: '#243138', roughness: 0.75 }),
          )
          const building = new THREE.Mesh(
            new THREE.BoxGeometry(5, 3.4, 4),
            new THREE.MeshStandardMaterial({ color: '#d9dbd5', roughness: 0.55 }),
          )
          building.position.set(-1.6, 2.1, 0)
          const gantry = new THREE.Mesh(
            new THREE.BoxGeometry(0.8, 8, 0.8),
            new THREE.MeshStandardMaterial({ color: '#b9c3c7', roughness: 0.4, metalness: 0.3 }),
          )
          gantry.position.set(3.4, 4, 0)
          station.add(base, building, gantry)
          station.position.set(place.x, terrainHeight(place.x, place.z) + 0.35, place.z)
          group.add(station)

          dataRef.current.forEach(turbine => {
            const midX = (turbine.x + place.x) / 2
            const midZ = (turbine.z + place.z) / 2
            const points = [
              new THREE.Vector3(turbine.x, terrainHeight(turbine.x, turbine.z) + 1, turbine.z),
              new THREE.Vector3(midX, terrainHeight(midX, midZ) + 8, midZ),
              new THREE.Vector3(place.x, terrainHeight(place.x, place.z) + 6, place.z),
            ]
            group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), cableMaterial))
          })
        }

        const element = document.createElement('div')
        element.className = 'scene-place-label'
        element.textContent = kind === 'substation'
          ? `${name} · ${feature.properties.voltageKv ?? ''}kV`
          : name
        const label = new CSS2DObject(element)
        label.position.set(place.x, terrainHeight(place.x, place.z) + 1.2, place.z)
        group.add(label)
      }
    })
    scene.add(group)

    return () => {
      scene.remove(group)
      group.traverse(child => {
        const mesh = child as THREE.Mesh
        if (mesh.isMesh) {
          mesh.geometry.dispose()
          ;(mesh.material as THREE.Material)?.dispose()
        }
      })
      boundaryMaterial.dispose()
      cableMaterial.dispose()
    }
  }, [mapFeatures, terrain.version])

  const turbineSignature = turbines.map(turbine => `${turbine.id}:${turbine.status}:${turbine.x.toFixed(2)}:${turbine.z.toFixed(2)}`).join('|')
  useEffect(() => {
    rebuildRef.current?.()
  }, [turbineSignature])

  const simulationSignature = simulationEntities.map(entity => [
    entity.id, entity.status, entity.progress.toFixed(2),
    Number(entity.payload?.soc ?? 0).toFixed(4), Number(entity.payload?.flow_mw ?? 0).toFixed(2),
    entity.payload?.stage ?? '', Number(entity.payload?.stage_progress ?? 0).toFixed(3),
  ].join(':')).join('|')
  useEffect(() => {
    if (!simulationObjectsRef.current.size) rebuildSimulationRef.current?.()
    const entityById = new Map(simulationEntities.map(entity => [entity.id, entity]))
    const routePosition = (entity: SceneSimulationEntity, progress: number, reverse: boolean) => {
      const points = entity.routePoints
      if (points.length < 2) return points[0] ?? { x: entity.x, z: entity.z }
      const fraction = Math.max(0, Math.min(1, progress / 100))
      const distance = (reverse ? 1 - fraction : fraction) * (points.length - 1)
      const index = Math.min(points.length - 2, Math.floor(distance))
      const alpha = distance - index
      const from = points[index]
      const to = points[index + 1]
      return { x: from.x + (to.x - from.x) * alpha, z: from.z + (to.z - from.z) * alpha }
    }

    simulationEntities.forEach(entity => {
      const object = simulationObjectsRef.current.get(entity.id)
      if (!object) return
      if (entity.type === 'transport_crew') {
        const reverse = entity.payload?.direction === 'return' || entity.payload?.direction === 'returning'
        const point = routePosition(entity, entity.progress, reverse)
        object.position.set(point.x, terrainHeight(point.x, point.z), point.z)
        const segmentIndex = Math.max(0, Math.min(entity.routePoints.length - 2, Math.floor(entity.progress / 100 * (entity.routePoints.length - 1))))
        const from = entity.routePoints[segmentIndex]
        const to = entity.routePoints[segmentIndex + 1] ?? from
        if ((reverse ? from.x - to.x : to.x - from.x) || (reverse ? from.z - to.z : to.z - from.z)) {
          const targetX = reverse ? from.x - to.x : to.x - from.x
          const targetZ = reverse ? from.z - to.z : to.z - from.z
          object.rotation.y = Math.atan2(-targetZ, targetX)
        }
      } else if (entity.type === 'crane') {
        const site = Array.from(entityById.values()).find(candidate => candidate.type === 'wind_turbine_site')
        const moving = entity.status === 'moving' && entity.routePoints.length > 1
        const point = moving ? routePosition(entity, entity.progress, false) : { x: site?.x ?? entity.x, z: site?.z ?? entity.z }
        object.position.set(point.x + (moving ? 0 : 0.45), terrainHeight(point.x + (moving ? 0 : 0.45), point.z), point.z + (moving ? 0 : 0.4))
        const siteEntity = site
        const stock = siteEntity?.payload?.stock ?? {}
        const stage = siteEntity?.payload?.stage
        const showTower = Boolean(stock.tower || stage === 'tower')
        const showNacelle = Boolean(stock.nacelle || stage === 'nacelle')
        const showRotor = Boolean(stock.blade || stage === 'blade')
        const assembly = (object as THREE.Group).children.find(child => child.userData?.isCraneAssembly)
        const craneBoom = (object as THREE.Group).userData?.craneBoom as THREE.Group | undefined
        const stagedProgress = Math.max(0, Math.min(1, Number(siteEntity?.payload?.stage_progress ?? entity.progress / 100)))
        if (craneBoom) craneBoom.rotation.y = moving ? 0.18 + stagedProgress * 0.22 : 0.72 - stagedProgress * 0.36
        if (assembly) {
          assembly.children[0].visible = showTower
          assembly.children[1].visible = showNacelle || showRotor
        }
      } else if (entity.type === 'storage_unit') {
        const fill = object.userData.storageFill as THREE.Mesh | undefined
        const soc = Math.max(0, Math.min(1, Number(entity.payload?.soc ?? 0)))
        if (fill) fill.scale.y = Math.max(0.04, soc)
        const mesh = fill?.material as THREE.MeshStandardMaterial
        mesh?.color.set(entity.payload?.mode === 'discharge' ? '#fbbf24' : entity.payload?.mode === 'charge' ? '#86efac' : '#22d3ee')
      }

      if (entity.type === 'wind_turbine_site') {
        const assembly = simulationSiteAssembliesRef.current.get(entity.id)
        if (assembly) {
          const stage = entity.payload?.stage
          const progress = Math.max(0, Math.min(1, Number(entity.payload?.stage_progress ?? 0)))
          const complete = entity.payload?.installed_units > 0 || entity.status === 'online'
          const towerRise = stage === 'tower' ? 0.12 + progress * 0.88 : stage ? 1 : complete ? 1 : 0.04
          assembly.tower.scale.y = towerRise
          assembly.tower.visible = towerRise > 0.045
          assembly.nacelle.visible = complete || stage === 'nacelle' || stage === 'blade'
          assembly.nacelle.position.y = stage === 'nacelle'
            ? TOWER_HEIGHT_UNITS * (0.55 + progress * 0.45)
            : complete ? TOWER_HEIGHT_UNITS : 0
          assembly.nacelle.rotation.y = stage === 'nacelle' ? (1 - progress) * 1.6 : 0
          assembly.rotor.visible = complete || stage === 'blade'
          assembly.rotor.rotation.z = stage === 'blade' ? -1.4 + progress * 1.4 : 0
        }
      }

      if (entity.type === 'transmission_line' && (object as THREE.InstancedMesh).isInstancedMesh) {
        const dots = object as THREE.InstancedMesh
        const flow = Math.max(0, Number(entity.payload?.flow_mw ?? 0))
        const capacity = Math.max(1, Number(entity.payload?.capacity_mw ?? 1))
        const curve = dots.userData.flowCurve as THREE.Vector3[]
        const visible = Math.max(2, Math.round(3 + (flow / capacity) * 17))
        dots.userData.visibleCount = visible
        const matrix = new THREE.Matrix4()
        for (let index = 0; index < dots.count; index += 1) {
          const visibleDot = index < visible && flow > 0.01
          dots.setMatrixAt(index, matrix.makeScale(visibleDot ? 1 : 0, visibleDot ? 1 : 0, visibleDot ? 1 : 0))
        }
        dots.userData.flowSpeed = 0.035 + (flow / capacity) * 0.12
        dots.instanceMatrix.needsUpdate = true
      }
    })
  }, [simulationSignature, simulationEntities])

  useEffect(() => {
    applyViewRef.current?.()
  }, [viewMode])

  useEffect(() => {
    if (simulationObjectsRef.current.size) rebuildSimulationRef.current?.()
  }, [terrain.version])

  useEffect(() => {
    const scene = sceneRef.current
    const ambient = ambientRef.current
    const sun = sunRef.current
    if (!scene || !ambient || !sun) return
    if (scene.background instanceof THREE.Color) scene.background.set(night ? '#010806' : '#a8d8ea')
    ambient.intensity = night ? 0.30 : 1.5
    sun.intensity = night ? 0.12 : 2.6
  }, [night])

  useEffect(() => {
    if (focusRequest?.id) focusNacelleRef.current?.(focusRequest.id)
  }, [focusRequest?.id, focusRequest?.nonce])

  useEffect(() => {
    turbineMapRef.current.forEach((group, id) => {
      const selected = id === selectedId
      group.traverse(child => {
        const mesh = child as THREE.Mesh
        if (mesh.isMesh) {
          const material = mesh.material as THREE.MeshStandardMaterial
          if (material?.emissive) material.emissive.setScalar(selected ? 0.22 : 0)
        }
      })
      const label = labelMapRef.current.get(id)
      if (label) label.element.classList.toggle('selected', selected)
    })
  }, [selectedId])

  return (
    <div className="sandbox-stage" style={style}>
      <div ref={mountRef} className="sandbox-mount" />
      <div className="sandbox-brand">
        <strong>TERRAIN DIGITAL TWIN</strong>
        <span>{terrain.sourceText}</span>
      </div>
      {terrain.status === 'loading' && (
        <div className="terrain-loading" role="status">
          <i />
          正在加载高程数据…
        </div>
      )}
      <div className="sandbox-compass">N</div>
      <div className="sandbox-scale"><i /><span>1 unit ≈ 30 m</span></div>
      <div className="sandbox-tools">
        <div className="tool-group">
          {(['overview', 'top', 'orbit', 'side'] as const).map(mode => (
            <button key={mode} className={viewMode === mode ? 'active' : ''} onClick={() => onViewModeChange(mode)}>
              {mode === 'overview' ? '全景' : mode === 'top' ? '俯视' : mode === 'orbit' ? '巡航' : '侧视'}
            </button>
          ))}
          <button className={night ? '' : 'active'} onClick={() => onNightChange(false)}>白天</button>
          <button className={night ? 'active' : ''} onClick={() => onNightChange(true)}>夜晚</button>
          <button className={simulationEnabled ? 'active' : ''} onClick={() => onSimulationEnabledChange?.(!simulationEnabled)}>推演</button>
        </div>
        <div className="tool-group zoom-group">
          <button onClick={() => zoomRef.current?.(1)}>＋</button>
          <button onClick={() => zoomRef.current?.(-1)}>－</button>
        </div>
        <div className="tool-group">
          {(['current', 'street', 'satellite'] as const).map(mode => (
            <button key={mode} className={basemapMode === mode ? 'active' : ''} onClick={() => onBasemapModeChange(mode)}>
              {mode === 'current' ? '当前' : mode === 'street' ? '街道' : '卫星'}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
