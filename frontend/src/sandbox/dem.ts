import {
  buildDemTileUrl,
  DEM_MAX_TILES_PER_AXIS,
  DEM_TILE_SIZE,
  DEM_TILE_SOURCES,
  DEM_TIMEOUT_MS,
} from './demSource'
import { createSceneProjection, type DemGrid } from './terrain'

export type DemLoadResult = {
  grid: DemGrid
  sourceId: string
  zoom: number
  tileCount: number
}

const EarthRadius = 6_378_137

function mercatorY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
}

function latitudeFromMercatorY(y: number): number {
  return (Math.atan(Math.exp(y / EarthRadius)) * 2 - Math.PI / 2) * 180 / Math.PI
}

function chooseZoom(sideMeters: number, lat: number): number {
  const latitudeScale = Math.cos((lat * Math.PI) / 180)
  for (let zoom = 14; zoom >= 6; zoom -= 1) {
    const tileMeters = (2 * Math.PI * EarthRadius * latitudeScale) / (1 << zoom)
    const tilesNeeded = Math.ceil(sideMeters / tileMeters)
    if (tilesNeeded <= DEM_MAX_TILES_PER_AXIS) return zoom
  }
  return 6
}

type TileDownload = { blob: Blob; sourceId: string }

async function fetchTile(
  zoom: number,
  tileX: number,
  tileY: number,
  signal?: AbortSignal,
): Promise<TileDownload> {
  let lastError: unknown
  for (const source of DEM_TILE_SOURCES) {
    if (signal?.aborted) throw new DOMException('DEM load cancelled', 'AbortError')
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = window.setTimeout(abort, DEM_TIMEOUT_MS)
    try {
      const url = buildDemTileUrl(source, zoom, tileX, tileY)
      const response = await fetch(url, {
        signal: controller.signal,
        mode: 'cors',
        credentials: 'omit',
        cache: 'force-cache',
      })
      if (!response.ok) throw new Error(`${source.id}: HTTP ${response.status}`)
      const blob = await response.blob()
      if (!blob.type.includes('png')) {
        throw new Error(`${source.id}: response is not PNG`)
      }
      return { blob, sourceId: source.id }
    } catch (error) {
      if (signal?.aborted) throw new DOMException('DEM load cancelled', 'AbortError')
      lastError = error
    } finally {
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('No terrain source configured')
}

async function decodeTile(blob: Blob, canvas: HTMLCanvasElement, dx: number, dy: number) {
  const bitmap = await createImageBitmap(blob)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas 2D is unavailable')
  context.drawImage(bitmap, dx, dy)
  bitmap.close()
}

function decodeTerrariumPixel(data: Uint8ClampedArray, offset: number): number {
  return data[offset] * 256 + data[offset + 1] + data[offset + 2] / 256 - 32_768
}

/** Load and stitch a square terrarium DEM window around the selected turbine cluster. */
export async function loadDemForTurbines(
  turbines: Array<{ lat: number; lng: number }>,
  signal?: AbortSignal,
): Promise<DemLoadResult> {
  if (!turbines.length) throw new Error('No turbine coordinates')
  const projection = createSceneProjection(turbines)
  const centerLng = ((projection.centerX / EarthRadius) * 180) / Math.PI
  const centerLat = latitudeFromMercatorY(projection.centerZ)
  const zoom = chooseZoom(projection.sideMeters, centerLat)
  const worldTileSize = (2 * Math.PI * EarthRadius) / (1 << zoom)
  const halfTileSpan = projection.sideMeters / worldTileSize / 2
  const centerTileX = ((centerLng + 180) / 360) * (1 << zoom)
  const centerTileY = ((1 - Math.asinh(Math.tan((centerLat * Math.PI) / 180)) / Math.PI) / 2) * (1 << zoom)
  const minX = Math.floor(centerTileX - halfTileSpan)
  const maxX = Math.floor(centerTileX + halfTileSpan)
  const minY = Math.floor(centerTileY - halfTileSpan)
  const maxY = Math.floor(centerTileY + halfTileSpan)
  const columns = maxX - minX + 1
  const rows = maxY - minY + 1

  const canvas = document.createElement('canvas')
  canvas.width = columns * DEM_TILE_SIZE
  canvas.height = rows * DEM_TILE_SIZE

  const tileRequests: Array<Promise<{ x: number; y: number; blob: Blob; sourceId: string }>> = []
  for (let tileY = minY; tileY <= maxY; tileY += 1) {
    for (let tileX = minX; tileX <= maxX; tileX += 1) {
      tileRequests.push(fetchTile(zoom, tileX, tileY, signal)
        .then(download => ({ x: tileX, y: tileY, blob: download.blob, sourceId: download.sourceId })))
    }
  }
  const tiles = await Promise.all(tileRequests)
  await Promise.all(tiles.map(tile => decodeTile(
    tile.blob,
    canvas,
    (tile.x - minX) * DEM_TILE_SIZE,
    (tile.y - minY) * DEM_TILE_SIZE,
  )))

  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D is unavailable')
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  const gridWidth = Math.min(1_024, canvas.width)
  const gridHeight = Math.min(1_024, canvas.height)
  const heights = new Float32Array(gridWidth * gridHeight)
  let minElevation = Number.POSITIVE_INFINITY
  let maxElevation = Number.NEGATIVE_INFINITY

  for (let gy = 0; gy < gridHeight; gy += 1) {
    const sourceY = Math.min(canvas.height - 1, Math.floor((gy / (gridHeight - 1)) * (canvas.height - 1)))
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const sourceX = Math.min(canvas.width - 1, Math.floor((gx / (gridWidth - 1)) * (canvas.width - 1)))
      const sourceOffset = (sourceY * canvas.width + sourceX) * 4
      const elevation = decodeTerrariumPixel(image.data, sourceOffset)
      heights[gy * gridWidth + gx] = elevation
      minElevation = Math.min(minElevation, elevation)
      maxElevation = Math.max(maxElevation, elevation)
    }
  }

  return {
    sourceId: tiles[0]?.sourceId ?? 'unknown',
    zoom,
    tileCount: columns * rows,
    grid: {
      columns: gridWidth,
      rows: gridHeight,
      heights,
      minElevation,
      maxElevation,
      projection,
    },
  }
}

const demCache = new Map<string, DemLoadResult>()

export async function loadDemCached(turbines: Array<{ lat: number; lng: number }>, cacheKey: string, signal?: AbortSignal) {
  const cached = demCache.get(cacheKey)
  if (cached) return cached
  let result: DemLoadResult
  try {
    result = await loadDemForTurbines(turbines, signal)
  } catch (error) {
    if (signal?.aborted) throw error
    // Tile sources unreachable (proxy/DNS issues) — sample real elevation via backend proxy.
    result = await loadDemViaElevationApi(turbines, signal)
  }
  demCache.set(cacheKey, result)
  return result
}

/**
 * Fallback DEM: sample a real-elevation grid from Open-Meteo (Copernicus GLO-90)
 * through the backend proxy at /api/elevation. Coarser than terrarium tiles but
 * fully real terrain, no third-party tile host needed.
 */
export async function loadDemViaElevationApi(
  turbines: Array<{ lat: number; lng: number }>,
  signal?: AbortSignal,
): Promise<DemLoadResult> {
  if (!turbines.length) throw new Error('No turbine coordinates')
  const projection = createSceneProjection(turbines)
  const centerLat = ((projection.centerZ / EarthRadius) * 180) / Math.PI
  const centerLng = ((projection.centerX / EarthRadius) * 180) / Math.PI
  const latSpan = projection.sideMeters / 110_570
  const lngSpan = projection.sideMeters / (111_320 * Math.max(0.2, Math.cos((centerLat * Math.PI) / 180)))

  const samples = 64
  const lats: number[] = []
  const lngs: number[] = []
  for (let i = 0; i < samples; i += 1) {
    lats.push(centerLat - latSpan / 2 + (latSpan * i) / (samples - 1))
    lngs.push(centerLng - lngSpan / 2 + (lngSpan * i) / (samples - 1))
  }

  const batchSize = 40 // 1600 points per request stays well under the 10k cap
  const heights = new Float32Array(samples * samples)
  let minElevation = Number.POSITIVE_INFINITY
  let maxElevation = Number.NEGATIVE_INFINITY
  let done = 0

  for (let yStart = 0; yStart < samples; yStart += batchSize) {
    const yEnd = Math.min(samples, yStart + batchSize)
    for (let xStart = 0; xStart < samples; xStart += batchSize) {
      const xEnd = Math.min(samples, xStart + batchSize)
      const batchLats: number[] = []
      const batchLngs: number[] = []
      for (let y = yStart; y < yEnd; y += 1) {
        for (let x = xStart; x < xEnd; x += 1) {
          batchLats.push(lats[y])
          batchLngs.push(lngs[x])
        }
      }
      const params = new URLSearchParams({
        lat: batchLats.map(v => v.toFixed(5)).join(','),
        lng: batchLngs.map(v => v.toFixed(5)).join(','),
      })
      const response = await fetch(`/api/elevation?${params.toString()}`, { signal })
      if (!response.ok) throw new Error(`elevation proxy HTTP ${response.status}`)
      const payload = (await response.json()) as { elevation: number[] }
      let index = 0
      for (let y = yStart; y < yEnd; y += 1) {
        for (let x = xStart; x < xEnd; x += 1) {
          const value = payload.elevation[index] ?? 0
          index += 1
          heights[y * samples + x] = value
          minElevation = Math.min(minElevation, value)
          maxElevation = Math.max(maxElevation, value)
        }
      }
      done += 1
      if (done % 8 === 0) await new Promise(resolve => setTimeout(resolve, 120)) // be nice to the free API
    }
  }

  return {
    sourceId: 'open-meteo-proxy',
    zoom: 0,
    tileCount: 0,
    grid: {
      columns: samples,
      rows: samples,
      heights,
      minElevation,
      maxElevation,
      projection,
    },
  }
}
