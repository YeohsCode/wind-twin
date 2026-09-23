import * as THREE from 'three'
import maplibregl, { Map as MLMap } from 'maplibre-gl'
import type { UnifiedWindTurbine } from '../types'

const MAX_INSTANCES = 8000
const MAX_TURBINES = Math.floor(MAX_INSTANCES / 3)
const SOURCE_COLORS: Record<string, number> = {
  osm: 0x22d3ee,
  usgs: 0xfacc15,
  sim: 0xa78bfa,
}
const ROTOR_AXIS = new THREE.Vector3(0, 0, 1)

export class UnifiedTurbineLayer implements maplibregl.CustomLayerInterface {
  id = 'unified-turbines-3d'
  type: 'custom' = 'custom'
  renderingMode: '3d' = '3d'
  private map?: MLMap
  private camera = new THREE.Camera()
  private scene = new THREE.Scene()
  private renderer?: THREE.WebGLRenderer
  private towerMesh?: THREE.InstancedMesh
  private nacelleMesh?: THREE.InstancedMesh
  private bladeMesh?: THREE.InstancedMesh
  // 锚点海拔必须为 0：带海拔的锚点会让整层模型随视差整体飘离真实坐标
  private anchor = maplibregl.MercatorCoordinate.fromLngLat({ lng: 105, lat: 38 }, 0)
  private meterUnits = new maplibregl.MercatorCoordinate(0, 0).meterInMercatorCoordinateUnits()
  private turbines: UnifiedWindTurbine[] = []
  /** 每台风机的锚点局部坐标（东向米, 南向米），updateInstances 时刷新 */
  private localPositions: Array<[number, number]> = []
  /** 模型放大倍率（用户滑条控制，1 = 真实米尺度，底座位置不变） */
  userScale = 1
  private lastZoom = 0

  setUserScale(value: number) {
    this.userScale = Math.max(0.5, Math.min(30, value))
    if (this.towerMesh) this.updateInstances()
  }

  onAdd(map: MLMap, gl: WebGLRenderingContext) {
    this.map = map
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true, alpha: true })
    this.renderer.autoClear = false
    this.scene.add(new THREE.AmbientLight(0xffffff, 2.2), new THREE.DirectionalLight(0xffffff, 1.4))

    // 结构与沙盘 TurbineLayer 同款：白塔筒 + 机舱 + 3 叶叶轮（缓速自转）
    const towerGeometry = new THREE.CylinderGeometry(0.8, 1.8, 72, 8)
    towerGeometry.translate(0, 36, 0)
    const nacelleGeometry = new THREE.BoxGeometry(9, 3.5, 3.5)
    nacelleGeometry.translate(2, 73, 0)
    const bladeGeometry = new THREE.BoxGeometry(1.0, 28, 0.35)
    bladeGeometry.translate(0, 14, 0) // 实例原点 = 轮毂中心，叶片绕它自转

    const structureMaterial = new THREE.MeshStandardMaterial({ color: 0xf8fafc, metalness: 0.1, roughness: 0.55 })
    // 不受光照 → 任意视角都保持亮色，等价沙盘的自发光叶片
    const bladeMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })

    this.towerMesh = new THREE.InstancedMesh(towerGeometry, structureMaterial, MAX_INSTANCES)
    this.nacelleMesh = new THREE.InstancedMesh(nacelleGeometry, structureMaterial, MAX_INSTANCES)
    this.bladeMesh = new THREE.InstancedMesh(bladeGeometry, bladeMaterial, MAX_INSTANCES)
    for (const mesh of [this.towerMesh, this.nacelleMesh, this.bladeMesh]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.frustumCulled = false
      mesh.count = 0
      this.scene.add(mesh)
    }
    this.updateInstances()
  }

  setData(turbines: UnifiedWindTurbine[]) {
    this.turbines = turbines.slice(0, MAX_TURBINES)
    if (this.towerMesh) this.updateInstances()
  }

  private scaleTotal() {
    // 1x = 严格真实尺寸（塔筒 72 米），放大只由用户滑条控制
    return this.userScale
  }

  private updateInstances() {
    if (!this.towerMesh || !this.nacelleMesh || !this.bladeMesh) return
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const identity = new THREE.Quaternion()
    const total = this.scaleTotal()
    const scale = new THREE.Vector3(total, total, total)

    this.localPositions = this.turbines.map(turbine => {
      const mercator = maplibregl.MercatorCoordinate.fromLngLat({ lng: turbine.lng, lat: turbine.lat }, 0)
      // render() 的矩阵链 T(anchor)·S(mu,-mu,mu)·Rx(90°) 的局部轴：x=东向米, y=海拔米, z=南向米
      return [
        (mercator.x - this.anchor.x) / this.meterUnits,
        (mercator.y - this.anchor.y) / this.meterUnits,
      ] as [number, number]
    })

    this.turbines.forEach((_, index) => {
      const [east, south] = this.localPositions[index]
      position.set(east, 0, south)
      matrix.compose(position, identity, scale)
      this.towerMesh!.setMatrixAt(index, matrix)
      this.nacelleMesh!.setMatrixAt(index, matrix)
    })
    this.towerMesh.count = this.turbines.length
    this.nacelleMesh.count = this.turbines.length
    this.towerMesh.instanceMatrix.needsUpdate = true
    this.nacelleMesh.instanceMatrix.needsUpdate = true

    this.updateBlades()
    this.paintBlades()
  }

  /** 叶片实例：每台 3 片，绕轮毂缓速自转（与沙盘同款动画） */
  private updateBlades() {
    if (!this.bladeMesh) return
    const total = this.scaleTotal()
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3(total, total, total)
    const elapsed = Date.now() * 0.001
    this.turbines.forEach((_, turbineIndex) => {
      const [east, south] = this.localPositions[turbineIndex]
      position.set(east, 73 * total, south)
      for (let bladeIndex = 0; bladeIndex < 3; bladeIndex++) {
        const angle = bladeIndex * (Math.PI * 2) / 3 + turbineIndex * 0.7 + elapsed * 0.15
        quaternion.setFromAxisAngle(ROTOR_AXIS, angle)
        matrix.compose(position, quaternion, scale)
        this.bladeMesh!.setMatrixAt(turbineIndex * 3 + bladeIndex, matrix)
      }
    })
    this.bladeMesh.count = this.turbines.length * 3
    this.bladeMesh.instanceMatrix.needsUpdate = true
  }

  private paintBlades() {
    if (!this.bladeMesh) return
    const color = new THREE.Color()
    this.turbines.forEach((turbine, index) => {
      color.setHex(SOURCE_COLORS[turbine.source] ?? 0x38bdf8)
      for (let bladeIndex = 0; bladeIndex < 3; bladeIndex++) {
        this.bladeMesh!.setColorAt(index * 3 + bladeIndex, color)
      }
    })
    if (this.bladeMesh.instanceColor) this.bladeMesh.instanceColor.needsUpdate = true
    this.bladeMesh.computeBoundingSphere()
  }

  render(_gl: WebGLRenderingContext, options: maplibregl.CustomRenderMethodInput) {
    if (!this.renderer || !this.map || !this.towerMesh) return
    const zoom = this.map.getZoom()
    if (Math.abs(zoom - this.lastZoom) > 0.25) {
      this.lastZoom = zoom
      this.updateInstances()
    } else if (this.turbines.length) {
      this.updateBlades()
    }
    const rotationX = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2)
    const projection = new THREE.Matrix4().fromArray(options.defaultProjectionData.mainMatrix as unknown as number[])
    const local = new THREE.Matrix4()
      .makeTranslation(this.anchor.x, this.anchor.y, this.anchor.z)
      .scale(new THREE.Vector3(this.meterUnits, -this.meterUnits, this.meterUnits))
      .multiply(rotationX)
    this.camera.projectionMatrix = projection.multiply(local)
    ;(this.renderer as any).resetState()
    this.renderer.clearDepth()
    this.renderer.render(this.scene, this.camera)
    this.map.triggerRepaint()
  }
}
