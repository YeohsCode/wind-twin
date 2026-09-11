import { useEffect, useRef } from 'react'
import * as echarts from 'echarts'

export default function Chart({ option, height = 220 }: { option: any; height?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current, 'dark')
    chart.setOption({ backgroundColor: 'transparent', ...option })
    const resize = () => chart.resize()
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize); chart.dispose() }
  }, [option])
  return <div ref={ref} style={{ height, width: '100%' }} />
}
