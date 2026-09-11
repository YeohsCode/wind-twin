import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { activeTerrainProjection, forestCandidates, terrainElevationRange, terrainHeight, type ScenePoint } from './terrain'

export type SceneTurbine = {
  id: string
  displayId: string
  status: 'running' | 'warning' | 'fault'
  ratedPowerKw: number
  liveMw: number
  windSpeed: number
  rotorRpm: number
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
  terrain: TerrainState
  onNightChange: (night: boolean) => void
  onViewModeChange: (mode: Props['viewMode']) => void
}

export default function SandboxScene({
  turbines,
  selectedId,
  onSelect,
  night,
  viewMode,
  terrain,
  onNightChange,
  onViewModeChange,
}: Props) {
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
  const ambientRef = useRef<THREE.HemisphereLight | null>(null)
  const sunRef = useRef<THREE.DirectionalLight | null>(null)

  dataRef.current = turbines
  selectedRef.current = selectedId
  nightRef.current = night
  viewModeRef.current = viewMode
  terrainRef.current = terrain

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const projection = activeTerrainProjection()
    const size = projection.sideMeters / 30
    const half = size / 2
    const elevationRange = terrainElevationRange()

    const scene = new THREE.Scene()
    sceneRef.current = scene
    scene.background = new THREE.Color('#04100c')
    scene.fog = new THREE.Fog('#04100c', size * 0.85, size * 2.4)

    const camera = new THREE.PerspectiveCamera(42, mount.clientWidth / mount.clientHeight, 0.1, Math.max(1800, size * 6))
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = false
    renderer.domElement.classList.add('sandbox-canvas')
    mount.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)

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

    const ambient = new THREE.HemisphereLight('#d8ffe8', '#173626', night ? 0.42 : 1.08)
    ambientRef.current = ambient
    scene.add(ambient)
    const sun = new THREE.DirectionalLight('#fff6df', night ? 0.22 : 2.0)
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
      const band = (y - elevationRange.min) / (elevationRange.max - elevationRange.min)
      if (band < 0.18) workColor.copy(low).lerp(valley, band / 0.18)
      else if (band < 0.46) workColor.copy(valley).lerp(mid, (band - 0.18) / 0.28)
      else if (band < 0.78) workColor.copy(mid).lerp(high, (band - 0.46) / 0.32)
      else workColor.copy(high).lerp(peak, Math.min(1, (band - 0.78) / 0.22))
      workColor.multiplyScalar(0.9 + (Math.sin(x * 2.7) + Math.cos(z * 3.1)) * 0.035)
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

    // Instanced forest stays clear of the real turbine pads.
    const forest = forestCandidates(Math.round(Math.min(1300, Math.max(650, size * 4))))
    const treeGeometry = new THREE.ConeGeometry(1.05, 1.85, 5)
    treeGeometry.translate(0, 1.3, 0)
    const treeMaterial = new THREE.MeshStandardMaterial({ color: '#122b1c', roughness: 0.82 })
    const trees = new THREE.InstancedMesh(treeGeometry, treeMaterial, forest.length)
    const matrix = new THREE.Matrix4()
    const quaternion = new THREE.Quaternion()
    const treeScale = Math.max(1, Math.min(2.5, size / 240))
    forest.forEach((point, index) => {
      const scale = point.scale * treeScale
      matrix.compose(
        new THREE.Vector3(point.x, point.y, point.z),
        quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), point.tone * 12),
        new THREE.Vector3(scale * (0.8 + point.tone * 0.4), scale * 0.82, scale * (0.8 + point.tone * 0.4)),
      )
      trees.setMatrixAt(index, matrix)
    })
    trees.instanceMatrix.needsUpdate = true
    scene.add(trees)

    // The collection point is placed in the quadrant opposite the wind-farm centroid.
    const stationX = half * 0.62
    const stationZ = half * 0.62
    const station = new THREE.Group()
    const stationBase = new THREE.Mesh(new THREE.BoxGeometry(16, 0.7, 12), new THREE.MeshStandardMaterial({ color: '#243138', roughness: 0.75 }))
    const building = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 5), new THREE.MeshStandardMaterial({ color: '#d9dbd5', roughness: 0.55 }))
    building.position.set(-2, 2.4, 0)
    const gantry = new THREE.Mesh(new THREE.BoxGeometry(1, 9, 1), new THREE.MeshStandardMaterial({ color: '#b9c3c7', roughness: 0.4, metalness: 0.3 }))
    gantry.position.set(4, 4.5, 0)
    station.add(stationBase, building, gantry)
    station.position.set(stationX, terrainHeight(stationX, stationZ) + 0.5, stationZ)
    station.rotation.y = -0.3
    scene.add(station)

    const cableMaterial = new THREE.LineBasicMaterial({ color: '#67e8f9', transparent: true, opacity: 0.32 })
    dataRef.current.forEach(turbine => {
      const points = [
        new THREE.Vector3(turbine.x, terrainHeight(turbine.x, turbine.z) + 1, turbine.z),
        new THREE.Vector3((turbine.x + stationX) / 2, terrainHeight((turbine.x + stationX) / 2, (turbine.z + stationZ) / 2) + 8, (turbine.z + stationZ) / 2),
        station.position.clone().add(new THREE.Vector3(0, 6, 0)),
      ]
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), cableMaterial))
    })

    const modelScale = Math.max(0.75, Math.min(1.55, size / 240))
    const towerGeometry = new THREE.CylinderGeometry(0.45, 1.0, 22, 18)
    towerGeometry.translate(0, 11, 0)
    const nacelleGeometry = new THREE.BoxGeometry(4.6, 1.5, 1.55)
    const hubGeometry = new THREE.SphereGeometry(0.82, 16, 12)
    const bladeGeometry = new THREE.CylinderGeometry(0.10, 1.05, 15, 10, 1, false)
    bladeGeometry.translate(0, 7.5, 0)
    const warningGeometry = new THREE.SphereGeometry(0.22, 10, 8)

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
        nacelle.position.set(0, 22, 0)
        const hub = new THREE.Mesh(hubGeometry, bodyMaterial)
        hub.position.set(2.35, 22, 0)

        const rotor = new THREE.Group()
        rotor.position.copy(hub.position)
        rotor.userData = { turbineId: turbine.id, clickable: true }
        for (let bladeIndex = 0; bladeIndex < 3; bladeIndex += 1) {
          const blade = new THREE.Mesh(bladeGeometry, bodyMaterial)
          blade.rotation.z = (bladeIndex * Math.PI * 2) / 3
          blade.userData = { turbineId: turbine.id, clickable: true }
          rotor.add(blade)
        }
        const warning = new THREE.Mesh(warningGeometry, new THREE.MeshStandardMaterial({
          color: '#ff2a1d', emissive: '#ff3b28', emissiveIntensity: nightRef.current ? 1.5 : 0.35,
        }))
        warning.position.set(0, 23.8, 0)
        warning.visible = turbine.status !== 'fault'
        warningLightsRef.current.push(warning)

        const labelElement = document.createElement('button')
        labelElement.className = `scene-tag status-${turbine.status}${selectedRef.current === turbine.id ? ' selected' : ''}`
        labelElement.innerHTML = `<b>${turbine.displayId}</b><span>-- MW</span>`
        labelElement.addEventListener('click', event => {
          event.stopPropagation()
          onSelect(turbine.id)
        })
        const label = new CSS2DObject(labelElement)
        label.position.set(0, 33.5, 0)

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
      const hits = raycaster.intersectObjects(targets, false)
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
          rotor.rotation.z -= speed * delta
        }
        const label = labelMapRef.current.get(turbine.id)
        if (label) {
          const element = label.element as HTMLButtonElement
          const span = element.querySelector('span')
          if (span) span.textContent = `${turbine.liveMw.toFixed(2)} MW`
        }
      })
      warningLightsRef.current.forEach((light, index) => {
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
      treeGeometry.dispose()
      treeMaterial.dispose()
      skirtGeometry.dispose()
      cableMaterial.dispose()
      bladeGeometry.dispose()
      towerGeometry.dispose()
      nacelleGeometry.dispose()
      hubGeometry.dispose()
      warningGeometry.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
      mount.removeChild(labelRenderer.domElement)
    }
    // A terrain version change deliberately rebuilds the WebGL scene around the new DEM extent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrain.version])

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
    if (scene.background instanceof THREE.Color) scene.background.set(night ? '#010806' : '#04100c')
    if (scene.fog instanceof THREE.Fog) scene.fog.color.set(night ? '#010806' : '#04100c')
    ambient.intensity = night ? 0.30 : 1.08
    sun.intensity = night ? 0.12 : 2.0
  }, [night])

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
    <div className="sandbox-stage">
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
          <button className={night ? 'active' : ''} onClick={() => onNightChange(!night)}>夜晚</button>
        </div>
        <div className="tool-group zoom-group">
          <button onClick={() => zoomRef.current?.(1)}>＋</button>
          <button onClick={() => zoomRef.current?.(-1)}>－</button>
        </div>
      </div>
    </div>
  )
}
