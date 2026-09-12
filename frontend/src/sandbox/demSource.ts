/**
 * Public terrain raster source configuration.
 * Terrarium encoding: elevation = R * 256 + G + B / 256 - 32768.
 *
 * Override from an environment file with:
 * VITE_DEM_TILE_URL_TEMPLATE=https://example.com/terrarium/{z}/{x}/{y}.png
 */
export type TileSource = {
  id: string
  urlTemplate: string
}

const CUSTOM_SOURCE = import.meta.env.VITE_DEM_TILE_URL_TEMPLATE?.trim()

export const DEM_TILE_SOURCES: TileSource[] = CUSTOM_SOURCE
  ? [{ id: 'custom', urlTemplate: CUSTOM_SOURCE }]
  : [
      { id: 'public-terrain-a', urlTemplate: 'https://elevation-tiles-prod.mapterhorn.com/terrarium/{z}/{x}/{y}.png' },
      { id: 'public-terrain-b', urlTemplate: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png' },
    ]

export const DEM_TIMEOUT_MS = 10_000
export const DEM_TILE_SIZE = 256
export const DEM_MAX_TILES_PER_AXIS = 5
// Vertical exaggeration: 2x keeps ridges/valleys readable at sand-table scale.
export const ELEVATION_EXAGGERATION = 2.0
export const METERS_PER_SCENE_UNIT = 30

export function buildDemTileUrl(source: TileSource, z: number, x: number, y: number): string {
  return source.urlTemplate
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
}

/** Command kept in the README: verifies that a configured endpoint returns a PNG. */
export function verifyDemTileCommand(source = DEM_TILE_SOURCES[0]): string {
  const url = buildDemTileUrl(source, 13, 6_710, 3_104)
  return `curl -L -sS -o /tmp/terrain-tile.png -w '%{http_code} %{content_type}\\n' '${url}' && file /tmp/terrain-tile.png`
}
