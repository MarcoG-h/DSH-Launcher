import { useState } from 'react'
import type { JSX } from 'react'
import { HarnessProvider } from './hooks/useHarness'
import { Sidebar, type PageId } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { Dashboard } from './pages/Dashboard'
import { Plugins } from './pages/Plugins'
import { Settings } from './pages/Settings'

const TITLES: Record<PageId, string> = {
  dashboard: '控制台',
  plugins: '插件',
  settings: '设置'
}

function Shell(): JSX.Element {
  const [page, setPage] = useState<PageId>('dashboard')

  return (
    <div className="flex h-full">
      <Sidebar page={page} setPage={setPage} />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar title={TITLES[page]} />
        <main className="flex-1 overflow-y-auto">
          {page === 'dashboard' && <Dashboard />}
          {page === 'plugins' && <Plugins />}
          {page === 'settings' && <Settings />}
        </main>
      </div>
    </div>
  )
}

export default function App(): JSX.Element {
  return (
    <HarnessProvider>
      <Shell />
    </HarnessProvider>
  )
}
