/// <reference types="vite/client" />

import type { DshLauncherApi } from '../../shared/types'

declare global {
  interface Window {
    dshLauncher: DshLauncherApi
  }
}

export {}
