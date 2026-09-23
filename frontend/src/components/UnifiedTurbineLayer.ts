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
  private anchor = maplibregl.MercatorCoordinate.fromLngLat({ lng: 105, lat: 38 }, 900)
  private meterUnits = new maplibregl.MercatorCoordinate(0, 0).meterInMercatorCoordinateUnits()
  private turbines: UnifiedWindTurbine[] = []

  onAdd(map: MLMap, gl: WebGLRenderingContext) {
    this.map = map
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true, alpha: true })
    this.renderer.autoClear = false
    this.scene.add(new THREE.AmbientLight(0xffffff, 2.2), new THREE.DirectionalLight(0xffffff, 1.4))
    const towerGeometry = new THREE.CylinderGeometry(0.55, 1.2, 60, 7)
    towerGeometry.translate(0, 30, 0)
    const nacelleGeometry = new THREE.BoxGeometry(6, 2.8, 2.8)
    nacelleGeometry.translate(1, 60, 0)
    const bladeGeometry = new THREE.BoxGeometry(0.5, 26, 0.18)
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
    this.updateInstances()
  }

  setData(turbines: UnifiedWindTurbine[]) {
    this.turbines = turbines.slice(0, MAX_INSTANCES)
    if (this.meshes.length) this.updateInstances()
  }

  private updateInstances() {
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3(1, 1, 1)
    const color = new THREE.Color()
    this.meshes.forEach((mesh, meshIndex) => {
      this.turbines.forEach((turbine, index) => {
        const mercator = maplibregl.MercatorCoordinate.fromLngLat({ lng: turbine.lng, lat: turbine.lat }, 900)
        position.set(
          (mercator.x - this.anchor.x) / this.meterUnits,
          -(mercator.y - this.anchor.y) / this.meterUnits,
          1620,
        )
        if (meshIndex === 2) quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), (index % 3) * Math.PI * 2 / 3)
        else quaternion.identity()
        matrix.compose(position, quaternion, scale)
        mesh.setMatrixAt(index, matrix)
        color.setHex(SOURCE_COLORS[turbine.source] ?? 0x38bdf8)
        mesh.setColorAt(index, color)
      })
      mesh.count = this.turbines.length
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
    })
  }

  render(_gl: WebGLRenderingContext, options: maplibregl.CustomRenderMethodInput) {
    if (!this.renderer || !this.map || !this.meshes.length) return
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
