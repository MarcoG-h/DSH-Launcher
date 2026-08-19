// 插件市场来源常量。三个源都是 GitHub 仓库的索引,归一化为 MarketRepo 后
// 下载/README 完全复用现有链路(见 src/main/market-1024.ts / market-dshfind.ts)。
//
// 数据端点(2026-08 实测):
// - github:  GitHub Search API `topic:dsh-plugin`(+关键词 + topic: 分类),服务端分页
// - dsh1024: GET https://deepseek1024.com/api/v2/plugins?per_page=&page=&q=&category=
//            服务端分页/搜索/分类;插件带双语描述与 install 命令(可解析 #path: 子包)
// - dshfind: GET https://dshfind.com/api/plugins-data 全量 4.3MB JSON(7392 条),
//            无服务端搜索/分页 → 主进程缓存后过滤分页

import type { MarketSourceId, SourceCategory } from './types'

export interface MarketSource {
  id: MarketSourceId
  zhName: string
  enName: string
  /** 下拉 title 提示,可选。 */
  zhDesc?: string
  enDesc?: string
}

export const MARKET_SOURCES: MarketSource[] = [
  {
    id: 'github',
    zhName: 'GitHub',
    enName: 'GitHub',
    zhDesc: '官方 topic:dsh-plugin 搜索,服务端分页',
    enDesc: 'official topic:dsh-plugin search, server paged'
  },
  {
    id: 'dsh1024',
    zhName: 'DSH 1024Store',
    enName: 'DSH 1024Store',
    zhDesc: 'deepseek1024.com · 6300+ 插件',
    enDesc: 'deepseek1024.com · 6300+ plugins'
  },
  {
    id: 'dshfind',
    zhName: 'DSH Find',
    enName: 'DSH Find',
    zhDesc: 'dshfind.com · 7300+ 插件',
    enDesc: 'dshfind.com · 7300+ plugins'
  }
]

export function sourceById(id: string | null | undefined): MarketSource | undefined {
  return MARKET_SOURCES.find((s) => s.id === id)
}

/** 「全部」分类,新源 chips 行的首项(沿用 MARKET_CATEGORIES 的 id='all' 语义)。 */
export const ALL_CATEGORY: SourceCategory = { id: 'all', zhName: '全部', enName: 'All' }

/** 源C 的 category id 是英文单词,给常用项一个中英显示名,未知 id 原样显示。 */
export const DSHFIND_CATEGORY_NAMES: Record<string, { zh: string; en: string }> = {
  client: { zh: '客户端', en: 'Client' },
  skin: { zh: '皮肤', en: 'Skin' },
  ui: { zh: '界面增强', en: 'UI' },
  resource: { zh: '资源', en: 'Resource' },
  agent: { zh: '智能体', en: 'Agent' },
  fun: { zh: '娱乐', en: 'Fun' },
  memory: { zh: '记忆', en: 'Memory' },
  tools: { zh: '工具', en: 'Tools' },
  channel: { zh: '频道', en: 'Channel' }
}

/**
 * FNV-1a 32 位哈希 → MarketRepo.id(渲染层 key 需 number;两个新源适配器共用)。
 * 7k 条目规模下碰撞可忽略(约 32 位空间 vs 13 位条目)。
 */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
