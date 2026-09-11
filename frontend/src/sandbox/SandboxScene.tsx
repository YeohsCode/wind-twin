import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { forestCandidates, TERRAIN_SIZE, terrainHeight, TURBINE_XZ } from './terrain'

export type SceneTurbine = {
  id: string
  displayId: string
  status: 'running' | 'warning' | 'fault'
  ratedPowerKw: number
  liveMw: number
  windSpeed: number
  rotorRpm: number
}

type Props = {
  turbines: SceneTurbine[]
  selectedId: string | null
  onSelect: (id: string) => void
  night: boolean
  viewMode: 'overview' | 'top' | 'side' | 'orbit'
  onNightChange: (night: boolean) => void
  onViewModeChange: (mode: Props['viewMode']) => void
}

const VIEW_POSITIONS: Record<Props['viewMode'], [number, number, number]> = {
  overview: [126, 92, 148],
  top: [0, 185, 2],
  side: [176, 34, 16],
  orbit: [104, 60, 112],
}

export default function SandboxScene({ turbines, selectedId, onSelect, night, viewMode, onNightChange, onViewModeChange }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const dataRef = useRef(turbines)
  const turbineMapRef = useRef(new Map<string, THREE.Group>())
  const bladeMapRef = useRef(new Map<string, THREE.Group>())
  const labelMapRef = useRef(new Map<string, CSS2DObject>())
  const selectedRef = useRef(selectedId)
  const nightRef = useRef(night)
  const warningLightsRef = useRef<THREE.Mesh[]>([])
  const zoomRef = useRef<((direction: number) => void) | null>(null)
  const rebuildRef = useRef<(() => void) | null>(null)
  const viewModeRef = useRef(viewMode)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const ambientRef = useRef<THREE.HemisphereLight | null>(null)
  const sunRef = useRef<THREE.DirectionalLight | null>(null)

  dataRef.current = turbines
  selectedRef.current = selectedId
  nightRef.current = night
  viewModeRef.current = viewMode

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const scene = new THREE.Scene()
    sceneRef.current = scene
    scene.background = new THREE.Color('#04100c')
    scene.fog = new THREE.Fog('#04100c', 230, 430)

    const camera = new THREE.PerspectiveCamera(42, mount.clientWidth / mount.clientHeight, 0.1, 900)
    camera.position.set(...VIEW_POSITIONS.overview)

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = false
    renderer.domElement.classList.add('sandbox-canvas')
    mount.appendChild(renderer.domElement)

    const labelRenderer = new CSS2DRenderer()
    labelRenderer.setSize(mount.clientWidth, mount.clientHeight)
    labelRenderer.domElement.classList.add('sandbox-labels')
    mount.appendChild(labelRenderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.07
    controls.maxPolarAngle = Math.PI * 0.485
    controls.minDistance = 65
    controls.maxDistance = 360
    controls.target.set(0, 12, 0)

    const ambient = new THREE.HemisphereLight('#d8ffe8', '#173626', night ? 0.42 : 1.08)
    ambientRef.current = ambient
    scene.add(ambient)
    const sun = new THREE.DirectionalLight('#fff6df', night ? 0.22 : 2.0)
    sun.position.set(88, 126, 68)
    sunRef.current = sun
    scene.add(sun)
    const rim = new THREE.DirectionalLight('#9ff5c8', night ? 0.28 : 0.72)
    rim.position.set(-96, 58, -82)
    scene.add(rim)

    // Terrain: quantized elevation colors create the contour/terrace appearance.
    const segments = 220
    const terrainGeometry = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, segments, segments)
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
      const band = Math.floor(y / 2.4) / 15
      if (band < 0.18) workColor.copy(low).lerp(valley, band / 0.18)
      else if (band < 0.46) workColor.copy(valley).lerp(mid, (band - 0.18) / 0.28)
      else if (band < 0.78) workColor.copy(mid).lerp(high, (band - 0.46) / 0.32)
      else workColor.copy(high).lerp(peak, Math.min(1, (band - 0.78) / 0.22))
      const grain = 0.90 + ((Math.sin(x * 2.7) + Math.cos(z * 3.1)) * 0.035)
      workColor.multiplyScalar(grain)
      colors[index * 3] = workColor.r
      colors[index * 3 + 1] = workColor.g
      colors[index * 3 + 2] = workColor.b
    }
    terrainGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    terrainGeometry.computeVertexNormals()
    const terrain = new THREE.Mesh(terrainGeometry, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.88, metalness: 0.02, flatShading: true,
    }))
    scene.add(terrain)

    // Bevelled sand-table skirt and plinth.
    const half = TERRAIN_SIZE / 2
    const bottomScale = 1.16
    const bottomHalf = half * bottomScale
    const bottomY = -16
    const edgePoints: THREE.Vector3[] = []
    const step = 4
    for (let x = -half; x <= half; x += step) edgePoints.push(new THREE.Vector3(x, terrainHeight(x, -half), -half))
    for (let z = -half; z <= half; z += step) edgePoints.push(new THREE.Vector3(half, terrainHeight(half, z), z))
    for (let x = half; x >= -half; x -= step) edgePoints.push(new THREE.Vector3(x, terrainHeight(x, half), half))
    for (let z = half; z >= -half; z -= step) edgePoints.push(new THREE.Vector3(-half, terrainHeight(-half, z), z))
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
      new THREE.BoxGeometry(TERRAIN_SIZE * bottomScale, 3, TERRAIN_SIZE * bottomScale),
      new THREE.MeshStandardMaterial({ color: '#0a1418', roughness: 0.55, metalness: 0.22 }),
    )
    plinth.position.y = bottomY - 1.5
    scene.add(plinth)

    // Instanced dark forest cones (no external model / DEM assets).
    const forest = forestCandidates(850)
    const treeGeometry = new THREE.ConeGeometry(1.05, 1.85, 5)
    treeGeometry.translate(0, 1.3, 0)
    const treeMaterial = new THREE.MeshStandardMaterial({ color: '#122b1c', roughness: 0.82 })
    const trees = new THREE.InstancedMesh(treeGeometry, treeMaterial, forest.length)
    const matrix = new THREE.Matrix4()
    const quaternion = new THREE.Quaternion()
    forest.forEach((point, index) => {
      const scale = point.scale
      matrix.compose(
        new THREE.Vector3(point.x, point.y, point.z),
        quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), point.tone * 12),
        new THREE.Vector3(scale * (0.8 + point.tone * 0.4), scale * 0.82, scale * (0.8 + point.tone * 0.4)),
      )
      trees.setMatrixAt(index, matrix)
    })
    trees.instanceMatrix.needsUpdate = true
    scene.add(trees)

    // Access road over terrain to the substation pad.
    const roadPath = [
      new THREE.Vector3(-half + 4, 0, 56), new THREE.Vector3(-70, 0, 38), new THREE.Vector3(-42, 0, 34),
      new THREE.Vector3(-8, 0, 28), new THREE.Vector3(24, 0, 40), new THREE.Vector3(48, 0, 54),
      new THREE.Vector3(64, 0, 60),
    ].map(point => point.clone().setY(terrainHeight(point.x, point.z) + 0.55))
    const road = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(roadPath), 120, 0.65, 5, false),
      new THREE.MeshStandardMaterial({ color: '#d7d2c2', roughness: 0.7 }),
    )
    scene.add(road)

    // Substation and collection-cable hints.
    const station = new THREE.Group()
    const stationBase = new THREE.Mesh(new THREE.BoxGeometry(16, 0.7, 12), new THREE.MeshStandardMaterial({ color: '#243138', roughness: 0.75 }))
    const building = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 5), new THREE.MeshStandardMaterial({ color: '#d9dbd5', roughness: 0.55 }))
    building.position.set(-2, 2.4, 0)
    const gantry = new THREE.Mesh(new THREE.BoxGeometry(1, 9, 1), new THREE.MeshStandardMaterial({ color: '#b9c3c7', roughness: 0.4, metalness: 0.3 }))
    gantry.position.set(4, 4.5, 0)
    station.add(stationBase, building, gantry)
    station.position.set(66, terrainHeight(66, 60) + 0.5, 60)
    station.rotation.y = -0.3
    scene.add(station)

    const cableMaterial = new THREE.LineBasicMaterial({ color: '#67e8f9', transparent: true, opacity: 0.32 })
    TURBINE_XZ.forEach(([x, z]) => {
      const points = [
        new THREE.Vector3(x, terrainHeight(x, z) + 1, z),
        new THREE.Vector3((x + 66) / 2, terrainHeight((x + 66) / 2, (z + 60) / 2) + 8, (z + 60) / 2),
        station.position.clone().add(new THREE.Vector3(0, 6, 0)),
      ]
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), cableMaterial))
    })

    // Programmatic turbine models.
    const towerGeometry = new THREE.CylinderGeometry(0.45, 1.0, 22, 18)
    towerGeometry.translate(0, 11, 0)
    const nacelleGeometry = new THREE.BoxGeometry(4.6, 1.5, 1.55)
    const hubGeometry = new THREE.SphereGeometry(0.82, 16, 12)
    const bladeGeometry = new THREE.CylinderGeometry(0.10, 1.05, 15, 10, 1, false)
    bladeGeometry.translate(0, 7.5, 0)
    const warningGeometry = new THREE.SphereGeometry(0.22, 10, 8)

    const buildTurbines = () => {
      turbineMapRef.current.forEach(group => scene.remove(group))
      turbineMapRef.current.clear()
      bladeMapRef.current.clear()
      labelMapRef.current.clear()
      warningLightsRef.current = []

      dataRef.current.forEach((turbine, index) => {
        const [x, z] = TURBINE_XZ[index] ?? [0, 0]
        const ground = terrainHeight(x, z)
        const group = new THREE.Group()
        group.position.set(x, ground, z)
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
    const onViewEvent = (event: Event) => {
      const detail = (event as CustomEvent<number[]>).detail
      if (detail) camera.position.set(detail[0], detail[1], detail[2])
      controls.target.set(0, 12, 0)
    }
    renderer.domElement.addEventListener('sandbox-view', onViewEvent)

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
    let orbitAngle = Math.atan2(camera.position.x, camera.position.z)
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
        orbitAngle += delta * 0.12
        const radius = 136
        camera.position.set(Math.sin(orbitAngle) * radius, 72, Math.cos(orbitAngle) * radius)
        controls.target.set(0, 12, 0)
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
      renderer.domElement.removeEventListener('sandbox-view', onViewEvent)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      controls.dispose()
      terrainGeometry.dispose()
      treeGeometry.dispose()
      skirtGeometry.dispose()
      bladeGeometry.dispose()
      towerGeometry.dispose()
      nacelleGeometry.dispose()
      hubGeometry.dispose()
      warningGeometry.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
      mount.removeChild(labelRenderer.domElement)
    }
    // Scene is initialized once; live state is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const turbineSignature = turbines.map(turbine => `${turbine.id}:${turbine.status}`).join('|')
  useEffect(() => {
    rebuildRef.current?.()
  }, [turbineSignature])

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

  // Smooth camera presets without rebuilding WebGL resources.
  useEffect(() => {
    const target = new THREE.Vector3(...VIEW_POSITIONS[viewMode])
    const scene = mountRef.current
    if (!scene) return
    const canvas = scene.querySelector<HTMLCanvasElement>('.sandbox-canvas')
    if (!canvas) return
    const event = new CustomEvent('sandbox-view', { detail: target.toArray() })
    canvas.dispatchEvent(event)
  }, [viewMode])

  // Update selected-material and tag colors in place.
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
        <span>SECTION A · 12 TURBINES · 18 MW</span>
      </div>
      <div className="sandbox-compass">N</div>
      <div className="sandbox-scale"><i /><span>50 m</span></div>
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
