// Curated "recommended" plugins, surfaced in the local-plugins tab when the
// profile has nothing installed yet. This is renderer-only data — the install
// button drives the existing download/install pipeline (downloadPlugin), so the
// recommended entries remain ordinary, uninstallable plugins. Nothing here is
// force-installed: once uninstalled, the profile simply returns to the empty
// state and the recommendations reappear.
export interface RecommendedPlugin {
  name: string
  github: string
  author: string
  descKey: string
}

export const RECOMMENDED_PLUGINS: RecommendedPlugin[] = [
  {
    name: '@baihejiangnan/dsh-session-context-menu',
    github: 'github:baihejiangnan/dsh-session-context-menu',
    author: 'baihejiangnan',
    descKey: 'plugins.recommended.contextMenu.desc'
  }
]
