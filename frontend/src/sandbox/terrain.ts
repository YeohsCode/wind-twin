export const TERRAIN_SIZE = 190
export const TURBINE_XZ: Array<[number, number]> = [
  [-54, -36], [-24, -46], [4, -34], [28, -46], [50, -26],
  [-48, 2], [-17, -8], [12, -10], [40, 6],
  [-42, 34], [-8, 28], [24, 40],
]

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
  // The main ridge runs diagonally; branches follow the turbine rows.
  const main = Math.abs((x * 0.30 + z * 0.94 + 4) / 1.18)
  const rowA = Math.abs((x * 0.94 - z * 0.30 + 8) / 1.45)
  const rowB = Math.abs((x * 0.86 - z * 0.50 - 12) / 1.70)
  return Math.min(main, rowA, rowB)
}

export function terrainHeight(x: number, z: number): number {
  const radius = Math.sqrt(x * x + z * z)
  const edgeFall = Math.exp(-Math.pow(radius / (TERRAIN_SIZE * 0.42), 4))
  const core = 7 + 29 * Math.exp(-Math.pow(radius / 84, 2.4)) * edgeFall
  const ridges = Math.pow(distanceToRidge(x, z) + 0.16, -0.75) * 6.4
  const details = (fbm(x * 0.019 + 11, z * 0.019 - 7) - 0.45) * 16
  const crest = ridged(x * 0.026 - 4, z * 0.026 + 9) * 13 * edgeFall
  const plateau = Math.round((core + ridges + details + crest) / 2.4) * 2.4

  let pads = 0
  for (const [px, pz] of TURBINE_XZ) {
    const padDistance = Math.sqrt((x - px) ** 2 + (z - pz) ** 2)
    pads += 2.8 * Math.exp(-Math.pow(padDistance / 8.5, 2))
  }
  return Math.max(0.8, plateau + pads)
}

export function forestCandidates(count = 1800) {
  const points: Array<{ x: number; z: number; y: number; scale: number; tone: number }> = []
  let seed = 431
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }

  while (points.length < count) {
    const x = (random() - 0.5) * TERRAIN_SIZE * 0.9
    const z = (random() - 0.5) * TERRAIN_SIZE * 0.9
    const y = terrainHeight(x, z)
    const cluster = fbm(x * 0.045 + 31, z * 0.045 + 17)
    const ridge = distanceToRidge(x, z)
    const tooNearTurbine = TURBINE_XZ.some(([tx, tz]) => Math.hypot(x - tx, z - tz) < 8)
    if (y < 8 || y > 37 || cluster < 0.46 || ridge < 0.35 || tooNearTurbine) continue
    points.push({
      x, z, y,
      scale: 0.55 + random() * 0.75,
      tone: 0.18 + random() * 0.30,
    })
  }
  return points
}
