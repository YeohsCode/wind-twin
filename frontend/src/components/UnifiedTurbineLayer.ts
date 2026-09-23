import * as THREE from 'three'
import maplibregl, { Map as MLMap } from 'maplibre-gl'
import type { UnifiedWindTurbine } from '../types'

const MAX_INSTANCES = 8000
const SOURCE_COLORS: Record<string, number> = {
  osm: 0x22d3ee,
  usgs: 0xfacc15,
  sim: 0xa78bfa,
}

export class UnifiedTurbineLayer implements maplibregl.CustomLayerInterface {
  id = 'unified-turbines-3d'
  type: 'custom' = 'custom'
  renderingMode: '3d' = '3d'
  private map?: MLMap
  private camera = new THREE.Camera()
  private scene = new THREE.Scene()
  private renderer?: THREE.WebGLRenderer
  private meshes: THREE.InstancedMesh[] = []
  // 锚点海拔必须为 0：带海拔的锚点会让整层模型随视差整体飘离真实坐标
  private anchor = maplibregl.MercatorCoordinate.fromLngLat({ lng: 105, lat: 38 }, 0)
  private meterUnits = new maplibregl.MercatorCoordinate(0, 0).meterInMercatorCoordinateUnits()
  private turbines: UnifiedWindTurbine[] = []
  /** 模型放大倍率（用户滑条控制，1 = 真实米尺度，底座位置不变） */
  userScale = 1
  private lastZoom = 0
  private towerMesh?: THREE.InstancedMesh
  private nacelleMesh?: THREE.InstancedMesh
  private bladeMesh?: THREE.InstancedMesh
  private bladeOffsets: number[] = []

  setUserScale(value: number) {
    this.userScale = Math.max(0.5, Math.min(30, value))
    if (this.meshes.length) this.updateInstances()
  }

  onAdd(map: MLMap, gl: WebGLRenderingContext) {
    this.map = map
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true, alpha: true })
    this.renderer.autoClear = false
    this.scene.add(new THREE.AmbientLight(0xffffff, 2.2), new THREE.DirectionalLight(0xffffff, 1.4))
    const towerGeometry = new THREE.CylinderGeometry(0.55, 1.2, 60, 7)
    towerGeometry.translate(0, 30, 0)
    const nacelleGeometry = new THREE.BoxGeometry(6, 2.8, 2.8)
    nacelleGeometry.translate(1, 60, 0)
    // 叶片：宽 1.2 米（真实量级），并排 3 片组成叶轮（沙盘版同构）
    const bladeGeometry = new THREE.BoxGeometry(1.2, 26, 0.35)
    bladeGeometry.translate(0, 13, 0)
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff })
    for (const geometry of [towerGeometry, nacelleGeometry, bladeGeometry]) {
      const mesh = new THREE.InstancedMesh(geometry, material.clone(), MAX_INSTANCES)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.frustumCulled = false
      mesh.count = 0
      this.scene.add(mesh)
      this.meshes.push(mesh)
    }
    // 三个实例网格的语义：0=塔筒批次, 1=机舱批次, 2=叶片批次（每台 3 片实例）
    this.towerMesh = this.meshes[0]
    this.nacelleMesh = this.meshes[1]
    this.bladeMesh = this.meshes[2]
    this.bladeOffsets = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]
    this.updateInstances()
  }

  setData(turbines: UnifiedWindTurbine[]) {
    this.turbines = turbines.slice(0, MAX_INSTANCES)
    if (this.meshes.length) this.updateInstances()
  }

  private updateInstances() {
    if (!this.towerMesh || !this.nacelleMesh || !this.bladeMesh) return
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const zoom = this.map?.getZoom() ?? 10
    // 远距离时真实米尺度几乎不可见，做 zoom 补偿；再叠加用户滑条倍率
    const zoomBoost = Math.max(1, 6 * Math.pow(2, 9.5 - zoom))
    const total = this.userScale * zoomBoost
    const scale = new THREE.Vector3(total, total, total)
    const color = new THREE.Color()

    const placeAt = (mesh: THREE.InstancedMesh, index: number, turbine: UnifiedWindTurbine, height: number, yaw = 0) => {
      const mercator = maplibregl.MercatorCoordinate.fromLngLat({ lng: turbine.lng, lat: turbine.lat }, 0)
      // render() 的矩阵链 T(anchor)·S(mu,-mu,mu)·Rx(90°) 中局部轴语义：
      //   局部 x = 东向米, 局部 y = 海拔米(向上), 局部 z = 南向米。
      position.set(
        (mercator.x - this.anchor.x) / this.meterUnits,
        height * total,
        (mercator.y - this.anchor.y) / this.meterUnits,
      )
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw)
      matrix.compose(position, quaternion, scale)
      mesh.setMatrixAt(index, matrix)
    }

    const paint = (mesh: THREE.InstancedMesh, count: number) => {
      this.turbines.forEach((turbine, turbineIndex) => {
        color.setHex(SOURCE_COLORS[turbine.source] ?? 0x38bdf8)
        mesh.setColorAt(turbineIndex, color)
      })
      mesh.count = count
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
    }

    // 塔筒 + 机舱：每台一个实例
    this.turbines.forEach((turbine, index) => {
      placeAt(this.towerMesh!, index, turbine, 0)
      placeAt(this.nacelleMesh!, index, turbine, 60)
    })
    paint(this.towerMesh, this.turbines.length)
    paint(this.nacelleMesh, this.turbines.length)

    // 叶片：每台 3 片（沿叶轮圆周 120° 分布），实例数 = 台数 × 3
    this.turbines.forEach((turbine, turbineIndex) => {
      this.bladeOffsets.forEach((offset, bladeIndex) => {
        placeAt(this.bladeMesh!, turbineIndex * 3 + bladeIndex, turbine, 60, offset + turbineIndex * 0.7)
      })
    })
    paint(this.bladeMesh, this.turbines.length * 3)
  }

  render(_gl: WebGLRenderingContext, options: maplibregl.CustomRenderMethodInput) {
    if (!this.renderer || !this.map || !this.meshes.length) return
    const zoom = this.map.getZoom()
    if (Math.abs(zoom - this.lastZoom) > 0.25) {
      this.lastZoom = zoom
      this.updateInstances()
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
  }
}
