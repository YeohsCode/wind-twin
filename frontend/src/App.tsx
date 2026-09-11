import { useEffect, useState } from 'react'
import GisView from './pages/GisView'
import SandboxView from './pages/SandboxView'

type Route = 'sandbox' | 'gis'

function currentRoute(): Route {
  const path = window.location.pathname.replace(/\/$/, '')
  return path.endsWith('/gis') ? 'gis' : 'sandbox'
}

export default function App() {
  const [route, setRoute] = useState<Route>(currentRoute)

  useEffect(() => {
    const onPopState = () => setRoute(currentRoute())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = (next: Route) => {
    setRoute(next)
    const path = next === 'gis' ? '/gis' : '/'
    if (window.location.pathname !== path) window.history.pushState({}, '', path)
  }

  return route === 'gis' ? <GisView /> : <SandboxView onNavigate={navigate} />
}
