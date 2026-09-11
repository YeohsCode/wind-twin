import { ELEVATION_EXAGGERATION, METERS_PER_SCENE_UNIT } from './demSource'

export const TERRAIN_SIZE = 190
export type SceneProjection = {
  centerX: number
  centerZ: number
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  sideMeters: number
}

export type DemGrid = {
  columns: number
  rows: number
  heights: Float32Array
  minElevation: number
  maxElevation: number
  projection: SceneProjection
}

export type ScenePoint = { x: number; z: number }

let activeGrid: DemGrid | null = null
let activeProjection: SceneProjection = {
  centerX: 0, centerZ: 0,
  minX: -TERRAIN_SIZE * METERS_PER_SCENE_UNIT / 2,
  maxX: TERRAIN_SIZE * METERS_PER_SCENE_UNIT / 2,
  minZ: -TERRAIN_SIZE * METERS_PER_SCENE_UNIT / 2,
  maxZ: TERRAIN_SIZE * METERS_PER_SCENE_UNIT / 2,
  sideMeters: TERRAIN_SIZE * METERS_PER_SCENE_UNIT,
}
let activeTurbinePoints: ScenePoint[] = []
let terrainElevationMin = 1
let terrainElevationMax = 36

function hash(x: number, y: number): number {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  return value - Math.floor(value)
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const a = hash(xi, yi)
  const b = hash(xi + 1, yi)
  const c = hash(xi, yi + 1)
  const d = hash(xi + 1, yi + 1)
  const u = smooth(xf)
  const v = smooth(yf)
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

function fbm(x: number, y: number, octaves = 5): number {
  let sum = 0
  let amplitude = 0.52
  let frequency = 1
  for (let index = 0; index < octaves; index += 1) {
    sum += valueNoise(x * frequency, y * frequency) * amplitude
    frequency *= 2.04
    amplitude *= 0.5
  }
  return sum
}

function ridged(x: number, y: number, octaves = 4): number {
  let sum = 0
  let amplitude = 0.5
  let frequency = 1
  for (let index = 0; index < octaves; index += 1) {
    const noise = 1 - Math.abs(valueNoise(x * frequency, y * frequency) * 2 - 1)
    sum += noise * noise * amplitude
    frequency *= 2.1
    amplitude *= 0.48
  }
  return sum
}

function distanceToRidge(x: number, z: number): number {
  const main = Math.abs((x * 0.30 + z * 0.94 + 4) / 1.18)
  const rowA = Math.abs((x * 0.94 - z * 0.30 + 8) / 1.45)
  const rowB = Math.abs((x * 0.86 - z * 0.50 - 12) / 1.70)
  return Math.min(main, rowA, rowB)
}

function mercatorY(lat: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat))
  return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360))
}

/**
 * Build a local Web-Mercator layout. XZ is always true to the horizontal scale:
 * one scene unit represents METERS_PER_SCENE_UNIT metres at ground level.
 */
export function createSceneProjection(points: Array<{ lat: number; lng: number }>, minimumSideMeters = 4_000): SceneProjection {
  const usable = points.length ? points : [{ lat: 41.05, lng: 111.45 }]
  const projected = usable.map(point => ({
    x: (point.lng * Math.PI) / 180 * 6_378_137,
    y: mercatorY(point.lat) * 6_378_137,
  }))
  const minX = Math.min(...projected.map(point => point.x))
  const maxX = Math.max(...projected.map(point => point.x))
  const minY = Math.min(...projected.map(point => point.y))
  const maxY = Math.max(...projected.map(point => point.y))
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  const spanMeters = Math.max(maxX - minX, maxY - minY)
  const margin = Math.max(800, spanMeters * 0.12)
  const sideMeters = Math.max(minimumSideMeters, spanMeters + margin * 2)
  const half = sideMeters / 2
  return {
    centerX,
    centerZ: centerY,
    minX: centerX - half,
    maxX: centerX + half,
    minZ: centerY - half,
    maxZ: centerY + half,
    sideMeters,
  }
}

export function projectToScene(lat: number, lng: number, projection = activeProjection): ScenePoint {
  const x = (lng * Math.PI) / 180 * 6_378_137
  const y = mercatorY(lat) * 6_378_137
  return {
    x: (x - projection.centerX) / METERS_PER_SCENE_UNIT,
    z: (projection.centerZ - y) / METERS_PER_SCENE_UNIT,
  }
}

/** Called before a new sandbox farm is shown; DEM data replaces the null fallback later. */
export function setTerrainScene(grid: DemGrid | null, projection: SceneProjection, turbinePoints: ScenePoint[] = []) {
  activeGrid = grid
  activeProjection = projection
  activeTurbinePoints = turbinePoints
  if (grid) {
    terrainElevationMin = (grid.minElevation - grid.minElevation) / METERS_PER_SCENE_UNIT * ELEVATION_EXAGGERATION + 1
    terrainElevationMax = (grid.maxElevation - grid.minElevation) / METERS_PER_SCENE_UNIT * ELEVATION_EXAGGERATION + 1
  } else {
    terrainElevationMin = 1
    terrainElevationMax = 36
  }
}

function sampleDemGrid(x: number, z: number, grid: DemGrid): number | null {
  const u = (x - grid.projection.minX) / (grid.projection.maxX - grid.projection.minX)
  const v = (z - grid.projection.minZ) / (grid.projection.maxZ - grid.projection.minZ)
  if (u < 0 || u > 1 || v < 0 || v > 1) return null

  const fx = u * (grid.columns - 1)
  const fy = v * (grid.rows - 1)
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(grid.columns - 1, x0 + 1)
  const y1 = Math.min(grid.rows - 1, y0 + 1)
  const tx = fx - x0
  const ty = fy - y0
  const top = grid.heights[y0 * grid.columns + x0] * (1 - tx) + grid.heights[y0 * grid.columns + x1] * tx
  const bottom = grid.heights[y1 * grid.columns + x0] * (1 - tx) + grid.heights[y1 * grid.columns + x1] * tx
  const elevation = top * (1 - ty) + bottom * ty
  return Math.max(0.8, (elevation - grid.minElevation) / METERS_PER_SCENE_UNIT * ELEVATION_EXAGGERATION + 1)
}

export function terrainHeight(x: number, z: number): number {
  if (activeGrid) {
    const demHeight = sampleDemGrid(x, z, activeGrid)
    if (demHeight !== null) return demHeight
    return 0.8
  }

  // The fallback uses the legacy, hand-tuned relief but adapts to the true farm extent.
  const scale = TERRAIN_SIZE / (activeProjection.sideMeters / METERS_PER_SCENE_UNIT)
  const lx = x * scale
  const lz = z * scale
  const radius = Math.sqrt(lx * lx + lz * lz)
  const edgeFall = Math.exp(-Math.pow(radius / (TERRAIN_SIZE * 0.42), 4))
  const core = 7 + 29 * Math.exp(-Math.pow(radius / 84, 2.4)) * edgeFall
  const ridges = Math.pow(distanceToRidge(lx, lz) + 0.16, -0.75) * 6.4
  const details = (fbm(lx * 0.019 + 11, lz * 0.019 - 7) - 0.45) * 16
  const crest = ridged(lx * 0.026 - 4, lz * 0.026 + 9) * 13 * edgeFall
  const plateau = Math.round((core + ridges + details + crest) / 2.4) * 2.4

  let pads = 0
  for (const point of activeTurbinePoints) {
    const padDistance = Math.hypot(x - point.x, z - point.z)
    pads += 2.8 * Math.exp(-Math.pow(padDistance / 8.5, 2))
  }
  return Math.max(0.8, plateau + pads)
}

export function terrainElevationRange() {
  return { min: terrainElevationMin, max: Math.max(terrainElevationMin + 1, terrainElevationMax) }
}

export function activeTerrainProjection() {
  return activeProjection
}

export function forestCandidates(count = 1800) {
  const points: Array<{ x: number; z: number; y: number; scale: number; tone: number }> = []
  let seed = 431
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const size = activeProjection.sideMeters / METERS_PER_SCENE_UNIT
  const range = terrainElevationRange()
  const lower = range.min + (range.max - range.min) * 0.18
  const upper = range.min + (range.max - range.min) * 0.87
  let attempts = 0
  const maxAttempts = count * 48

  while (points.length < count && attempts < maxAttempts) {
    attempts += 1
    const x = (random() - 0.5) * size * 0.92
    const z = (random() - 0.5) * size * 0.92
    const y = terrainHeight(x, z)
    const cluster = fbm(x * 0.045 + 31, z * 0.045 + 17)
    const tooNearTurbine = activeTurbinePoints.some(point => Math.hypot(x - point.x, z - point.z) < 8)
    if (y < lower || y > upper || cluster < 0.46 || tooNearTurbine) continue
    points.push({
      x, z, y,
      scale: 0.55 + random() * 0.75,
      tone: 0.18 + random() * 0.30,
    })
  }
  return points
}
