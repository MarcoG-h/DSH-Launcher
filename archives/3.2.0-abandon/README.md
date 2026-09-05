# DSH-Launcher 3.2.0 (abandon) — 存档

> 状态:**已放弃,不回滚启用,不发布**。记作 `3.2.0-abandon`,仅存档以便日后可能重新启用。
> 基线:此前发布的 **v3.1.2**(D 盘 git main `081653d`)。以后继续开发/发版都从 v3.1.2 走,与本次改动无关。
> 2026-09-05。

## 为什么放弃
本轮「扩展聚合页(插件/技能/MCP)+ 库矩阵」与 **dsh 官方/社区插件生态位重叠**(市面上已有
dsh-plug-skills / dsh-skill-manager / dsh-skill-mcp-manager / dsh-skill-mcp-center 等成熟插件,
且 MCP 按需加载/热重载等能力必须住在 dsh 进程内、launcher 侧结构性抄不来),同时本次改动
催生了过多 bug,投入产出比崩溃。故整体放弃、回滚到 v3.1.2。

## 相比 v3.1.2 改了什么(本轮全部内容)
统一把 插件 / 技能 / MCP 收进一个「扩展」聚合页,并做了大量 UI/交互迭代:
- 侧栏导航 `plugins` → `extensions`(新聚合页;插件本地矩阵迁入,市场进右侧抽屉)。
- 技能 / MCP 采用「**库 + 矩阵分配**」模型(先入库再分配实例):
  - 技能库 `<runtimeRoot>/skill-library/<name>/…`;MCP 库 `<runtimeRoot>/mcp-library.json`。
  - 技能启停=目录移动 `<home>/skills ⇄ .skill-off`;名称须 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`。
  - MCP 行写 `<home>/profiles/<profile>/cordis.patch.yml` 的 `@deepseek-ai/dsh-mcp-client` loader 行;
    启停=行 `disabled:true`;下次启动实例生效;需 profile 已装该 loader(缺失有提示/一键装)。
- 右侧市场抽屉:悬浮叠层、可拖宽(拖过 85% 全展开、≤15% 自动关、点空白关闭)、竖向柔和小把手、
  自适应卡片(全开 3 列)。
- 新建技能弹窗:拖放 .md/文件夹直建 + 从仓库 URL 安装 + 手动粘贴。
- MCP 一键预置源(github/fetch/playwright/sequential-thinking/memory/filesystem)。
- 性能/健壮细节:MCP cordis.patch 写前 `.bak` + 原子写、与插件共用 `!!js` schema 只改写 MCP 行。

## 涉及文件(delta/ 内含完整新内容,按相对路径可放回 v3.1.2 之上)
新增:
- src/main/mcp.ts、src/main/skills.ts
- src/renderer/src/components/ExtDrawer.tsx、McpPresets.tsx、McpTab.tsx、SkillTab.tsx
- src/renderer/src/pages/Extensions.tsx
修改:
- src/main/ipc.ts(src */* IPC、库导向 skills:/mcp: 通道)
- src/preload/index.ts、src/shared/types.ts、src/renderer/src/lib/api.ts
- src/renderer/src/App.tsx、components/Sidebar.tsx、components/MarketTab.tsx、i18n.tsx、pages/Plugins.tsx

## 若要重新启用
1. 把 `delta/` 下文件按相对路径拷回 v3.1.2 源码树;
2. `git diff` 以 v3.1.2 为基即可得到完整补丁(本目录即其快照);
3. 核对 IPC channel 表(main↔preload↔types↔api 必须一致)与「库目录在 runtimeRoot 下」的路径假设。

## 注意
- v3.1.2 之后 C 盘工作副本里另有**你自己的文档/截图**(EAC-整合包开发记录.md、V3-功能概述.md、screenshots/*),
  与本次改动无关,回滚时保留。
- 本存档同时以 Git 分支 `3.2.0-abandon` 形式保存在 D 盘仓库与 GitHub(不影响 main/tag/Release)。
