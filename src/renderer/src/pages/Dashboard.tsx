import type { JSX } from 'react'
import { useI18n } from '../i18n'
import { PowerIcon } from '../lib/icons'
import { LogConsole } from '../components/LogConsole'
import { BalanceCard } from '../components/BalanceCard'
import { InstanceList } from '../components/InstanceList'

export function Dashboard(): JSX.Element {
  const { t } = useI18n()
  return (
    <div className="p-5 space-y-5">
      {/* Status list — every instance's state + controls on one page */}
      <InstanceList />

      {/* Balance widget */}
      <BalanceCard />

      {/* Log console — one merged console for every instance */}
      <LogConsole />

      <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--muted)' }}>
        <PowerIcon />
        {t('dashboard.footer')}
      </div>
    </div>
  )
}
