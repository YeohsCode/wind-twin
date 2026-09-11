import * as THREE from 'three'
import maplibregl, { Map as MLMap } from 'maplibre-gl'
import type { Turbine } from '../types'

type Grouped = THREE.Group & { userData: { turbineId: string; blades: THREE.Object3D[]; materials: THREE.MeshStandardMaterial[] } }

export class TurbineLayer implements maplibregl.CustomLayerInterface {
  id = 'wind-turbines-3d'
  type: 'custom' = 'custom'
  renderingMode: '3d' = '3d'
  private map?: MLMap
  private camera = new THREE.Camera()
  private scene = new THREE.Scene()
  private renderer?: THREE.WebGLRenderer
  private groups = new Map<string, Grouped>()
  private anchor: maplibregl.MercatorCoordinate
  private meterUnits: number
  private turbines: Turbine[] = []

  constructor(center: [number, number]) {
    this.anchor = maplibregl.MercatorCoordinate.fromLngLat({ lng: center[0], lat: center[1] }, 900)
    this.meterUnits = new maplibregl.MercatorCoordinate(0, 0).meterInMercatorCoordinateUnits()
  }

  setData(turbines: Turbine[]) {
    this.turbines = turbines
    if (!this.map) return
    this.buildOrUpdate()
  }

  onAdd(map: MLMap, gl: WebGLRenderingContext) {
    this.map = map
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true, alpha: true })
    this.renderer.autoClear = false
    const light = new THREE.DirectionalLight(0xffffff, 2.4)
    light.position.set(-100, 180, 120)
    this.scene.add(light, new THREE.AmbientLight(0xbfe9ff, 1.5))
    this.buildOrUpdate()
  }

  private createTurbine(): Grouped {
    const group = new THREE.Group() as Grouped
    const materials: THREE.MeshStandardMaterial[] = []
    const towerMaterial = new THREE.MeshStandardMaterial({ color: 0xf8fafc, transparent: true, opacity: 0.92, metalness: 0.1, roughness: 0.55 })
    const bladeMaterial = new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: new THREE.Color(0x38bdf8), emissiveIntensity: 1.3, transparent: true, opacity: 0.96 })
    materials.push(towerMaterial, bladeMaterial)
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.8, 72, 8), towerMaterial)
    tower.position.y = 36
    const nacelle = new THREE.Mesh(new THREE.BoxGeometry(9, 3.5, 3.5), towerMaterial)
    nacelle.position.set(2, 73, 0)
    const blades: THREE.Object3D[] = []
    for (let i = 0; i < 3; i++) {
      const pivot = new THREE.Group()
      pivot.position.set(7.5, 73, 0)
      pivot.rotation.z = (i * Math.PI * 2) / 3
      const blade = new THREE.Mesh(new THREE.BoxGeometry(1.0, 28, 0.35), bladeMaterial)
      blade.position.y = 14
      pivot.add(blade)
      blades.push(pivot)
      group.add(pivot)
    }
    group.add(tower, nacelle)
    group.userData = { turbineId: '', blades, materials }
    return group
  }

  private buildOrUpdate() {
    const next = new Set(this.turbines.map(t => t.id))
    for (const [id, group] of this.groups) {
      if (!next.has(id)) {
        this.scene.remove(group)
        this.groups.delete(id)
      }
    }
    for (const turbine of this.turbines) {
      let group = this.groups.get(turbine.id)
      if (!group) {
        group = this.createTurbine()
        this.groups.set(turbine.id, group)
        this.scene.add(group)
        group.userData.turbineId = turbine.id
      }
      const merc = maplibregl.MercatorCoordinate.fromLngLat({ lng: turbine.lng, lat: turbine.lat }, 900)
      const x = (merc.x - this.anchor.x) / this.meterUnits
      const y = -(merc.y - this.anchor.y) / this.meterUnits
      group.position.set(x, y, 1620)
      const output = turbine.operation?.power_kw ?? 0
      const ratio = Math.max(0.15, Math.min(1, output / turbine.rated_power_kw))
      const colors: Record<string, number> = { running: 0x22d3ee, warning: 0xf59e0b, fault: 0xef4444 }
      const base = colors[turbine.status] ?? 0x38bdf8
      const material = group.userData.materials[1]
      material.color.setHex(base)
      material.emissive.setHex(base)
      material.emissiveIntensity = turbine.status === 'fault' ? 2.5 : 0.35 + ratio * 1.7
      group.userData.materials[0].opacity = turbine.status === 'fault' ? 0.98 : 0.78 + ratio * 0.2
      group.userData.bladeSpeed = turbine.status === 'fault' ? 0 : 0.004 + ratio * 0.055
    }
  }

  render(_gl: WebGLRenderingContext, options: maplibregl.CustomRenderMethodInput) {
    if (!this.renderer || !this.map) return
    const zoom = this.map.getZoom()
    const boost = Math.max(1.2, 16 * Math.pow(2, 6.2 - zoom))
    const elapsed = Date.now() * 0.001
    for (const group of this.groups.values()) {
      group.scale.setScalar(boost)
      const speed = (group.userData as any).bladeSpeed ?? 0.02
      group.userData.blades.forEach((pivot, index) => {
        pivot.rotation.z = (index * Math.PI * 2) / 3 + elapsed * speed * 8
      })
    }
    const rotationX = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2)
    const projection = new THREE.Matrix4().fromArray(options.defaultProjectionData.mainMatrix as unknown as number[])
    const local = new THREE.Matrix4()
      .makeTranslation(this.anchor.x, this.anchor.y, this.anchor.z)
      .scale(new THREE.Vector3(this.meterUnits, -this.meterUnits, this.meterUnits))
      .multiply(rotationX)
    this.camera.projectionMatrix = projection.multiply(local)
    ;(this.renderer as any).resetState()
    this.renderer.render(this.scene, this.camera)
    this.map.triggerRepaint()
  }
}
