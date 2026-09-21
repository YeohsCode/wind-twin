import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { METERS_PER_SCENE_UNIT } from './demSource'
import { activeTerrainProjection, projectToScene, terrainElevationRange, terrainHeight, type ScenePoint } from './terrain'
import type { MapFeatureCollection } from '../types'

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
  onNightChange: (night: boolean) => void
  onViewModeChange: (mode: Props['viewMode']) => void
  onBasemapModeChange: (mode: Props['basemapMode']) => void
}

const TOWER_HEIGHT_UNITS = 100 / METERS_PER_SCENE_UNIT
const NACELLE_LENGTH_UNITS = 22 / METERS_PER_SCENE_UNIT
const ROTOR_RADIUS_UNITS = 58 / METERS_PER_SCENE_UNIT
function basemapZoom(sideMeters: number) {
  const mosaicMeters = 40_075_016.868 * 3
  return Math.max(11, Math.min(15, Math.floor(Math.log2(mosaicMeters / Math.max(1, sideMeters * 1.2)))))
}

function lngToTile(lng: number, zoom: number) {
  return Math.floor(((lng + 180) / 360) * 2 ** zoom)
}

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

  dataRef.current = turbines
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
    const bladeGeometry = new THREE.BoxGeometry(0.055, ROTOR_RADIUS_UNITS, 0.035)
    bladeGeometry.translate(0, ROTOR_RADIUS_UNITS / 2, 0)
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

      if (viewModeRef.current === 'orbit') {
        const orbitDistance = camera.position.distanceTo(controls.target)
        orbitAngle += delta * 0.12
        camera.position.set(
          controls.target.x + Math.sin(orbitAngle) * orbitDistance,
          controls.target.y + orbitDistance * 0.35,
          controls.target.z + Math.cos(orbitAngle) * orbitDistance,
        )
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

  useEffect(() => {
    applyViewRef.current?.()
  }, [viewMode])

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
