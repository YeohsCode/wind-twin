import { useEffect, useRef } from 'react'
import * as echarts from 'echarts'

export default function Chart({ option, height = 220 }: { option: any; height?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current, 'dark')
    chartRef.current = chart
    const resize = () => chart.resize()
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption({ backgroundColor: 'transparent', ...option }, true)
  }, [option])

  return <div ref={ref} style={{ height, width: '100%' }} />
}
