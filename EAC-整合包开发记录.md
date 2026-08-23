# EAC 整合包开发记录(已下架)

> 本文档记录在 dsh-launcher 中加入「EAC 整合包」功能过程中遇到的问题与解决方法、以及最终**下架**的原因与清理范围,供日后在「整合包 / 插件管理」方向上继续开发时参考。

## 背景

- 时间:2026 年。
- **EAC 整合包** = 官方自研插件 18 个 + 社区插件 9 个 + Agent 预设 9 套。用户点「下载」后,launcher 拉取 EAC 仓库、把自研插件同步进本地库并逐套预设同步到全局 `~/.dsh/.agent-presets/`,再新建一个预配置实例,最后 `dsh plugin add` 直装社区插件。
- 与它并列的「新手起步套装」(原「第三方测试包」)是**纯社区包**(11 个插件),功能保留,不受下架影响。

---

## 一、插件矩阵:直装插件「没有行」

**现象**:TP / EAC 整合包插件 `dsh plugin add` 直装成功、实例内可见,但 launcher「本地插件」页的矩阵与「已启用插件」列表看不到。

**根因**:矩阵 rows 只来自 `scanLocal()`(扫描 `pluginDir` 本地库)。直装插件落在 profile 的 `node_modules`,不在 `pluginDir`,因此没有任何行可渲染;cells 里即使有该插件的 enabled 记录,UI 也只渲染 rows 中存在的插件,孤儿 cells 被忽略。

**解法**(`listPluginMatrix`):合并两路行——

1. 本地库行:`scanLocal()` 逐项。
2. 直装行:遍历各实例 `listInstalled(profile)`,只收 `enabled && localPath === null && 不在本地库名单` 的包,`spec` 记为 `github:owner/repo` 或 npm 包名。

```ts
// 只收 enabled、localPath===null、不在 localNames 的直装插件
for (const inst of shown) {
  const { installed } = listInstalled(inst.profile)
  for (const p of installed) {
    if (p.enabled) (cells[p.name] ??= {})[inst.id] = 'enabled'
    if (!p.enabled || p.localPath !== null || localNames.has(p.name) || seen.has(p.name)) continue
    seen.add(p.name)
    directRows.push({ name: p.name, path: '', platform: null, spec: p.spec, /* … */ })
  }
}
```

**必须注意**:合并**只收 enabled**,否则下面的运行时依赖会被当成假插件行,用户一「启用」就破坏 boot。

---

## 二、schemastery / cosmokit 运行时依赖污染

**现象**:启用一个「看起来是插件」的包后,boot 报 `invalid plugin`。

**根因**:`ensureRuntimeLinks` 会把 schemastery、cosmokit 等**非 cordis 运行时依赖**直装进 profile(但 `enabled=false`)。若把 `installed` 全量并入矩阵 rows,它们会变成假插件行。

**解法**:矩阵合并只收 `enabled`;这些依赖也永远不写进 `bundles` / `insert`。

---

## 三、链接插件解析不到宿主依赖(`Cannot find package`)

**现象**:EAC 自研插件是 `link:` 依赖(真实路径在 `~/.dsh` 之外),实例一启动就报 `Cannot find package`。

**根因**:Node 从真实路径向上找 `node_modules`,永远够不到 harness 维护的**扁平回退层**(`~/.dsh/profiles/node_modules`,由 `healProfilesModuleFallback` 在每次 boot 维护的完整运行时闭包);EAC 插件里若干 `@deepseek-ai/dsh-*` 宿主包都在该层解析。

**解法**(`ensureRuntimeLinks`,幂等,一次修好所有复用该库的 profile):

1. 回退层补齐 harness 闭包之外的依赖(无 scope 的 `schemastery` / `cosmokit`、`dsh-side-session` 的 peer 及其传递依赖)。源取目标 profile 的 `node_modules`;都没有时按需 `dsh plugin add` 直装 —— 纯依赖,**不走 setEnabled**。
2. 把回退层 junction 到 `<pluginDir>/node_modules`:链接插件从此像 profile 内插件一样解析整个 dsh 运行时闭包,且随 harness 每次 boot 自动愈合。

**保留原因**:`ensureRuntimeLinks` 在每次启动实例时(`harness.ts`)都会被调用,是通用机制,不只 EAC 用,因此下架时保留。

---

## 四、bundle 层 vs insert 挂载

**现象**:旧版 launcher 会把**非 bundle 插件**写进 `dsh.profile.bundles`,导致 boot 报 `invalid plugin (received object)`。

**根因**:bundles 层只应承载「bundle 插件」(随包自研,声明 `dsh.bundle.patch`);社区插件是普通直装,应走 insert 挂载。

**解法**(`repairProfile`,幂等):bundles 只含 bundle 层,非 bundle 插件改以 insert 挂载。

---

## 五、非法版本号导致 pnpm 装不上

**现象**:EAC 源里 `dsh-undo-savepoint` 的版本号是 `0.3.3.1`(4 段,非法 semver),`dsh plugin add` 底层走 pnpm,报 `ERR_PNPM_BAD_PACKAGE_JSON`。

**解法**:把插件拷贝进本地库时改写 `package.json` 的版本号为合法 3 段(`0.3.3.1 → 0.3.3`)。EAC 官方直接拷贝不解析版本号,launcher 因为走 pnpm 必须做这一步。

---

## 六、peer 依赖冲突

**现象**:TP 的 `dsh-better-sidebar` peer 要求 `rc.6`,运行时 dsh 是 `rc.5` → 装不上。

**结论**:符合预期、不阻塞;装不上的插件在下载完成后以 warning 形式集中展示。

---

## 七、EAC 源收集不能按 `dsh` 字段过滤

**现象**:`@deepseek-ai/dsh-file-changes` 是合法插件(EAC 注册表用 insert 挂载它),但它的 `package.json` **没有 `dsh` 字段**,若按 `looksLikeDshPlugin` 过滤会漏拷。

**解法**(`seedEac` 的收集逻辑):按「目录里有 `package.json` 就是插件包」收集(`collectManifestDirs`,含 scope 目录 `@deepseek-ai/` 的递归下钻),与 EAC 官方「整体复制」一致。此逻辑随 EAC 下架一并删除。

---

## 八、下载流程的防呆

- `bundleInFlight` ref 做同步门闩,避免重复触发重跑整套安装(installBundle 本身幂等复用同名实例,但重复触发会重跑)。
- 已下载过的包:卡片下载按钮置灰(想重装去详情弹窗)。
- 失败插件:完成后集中展示(`instances.bundleWarningsTitle`)。
- 整体进度:installBundle 用 `taskProgress` 广播 0..1 总进度,任务标签统一取 `bundleTaskLabel(bundle)`(`整合包: TP` 这种),实例页进度弹窗显示当前阶段。

---

## 九、实例卡片与新建按钮的 UI 打磨

- 新建实例按钮:改到实例网格**末尾**,与实例卡片同尺寸(`h-[104px]`),灰色**虚线**边框、不填充。
- 所有实例卡片固定高度(`h-[104px]`),统一视觉。

---

## 十、第三方测试包改名「新手起步套装」

- 「第三方测试包」→「新手起步套装」。
- 两个整合包的描述都重写为**功能导向**(列出核心能力,而非罗列机制)。
- 给每个插件配了**中文功能简介**(随包自研 18 条 + 社区 20 条),详情弹窗展示。

---

## 十一、EAC 设置页左侧边栏无法滚动(下架的直接原因)

**现象**:下载 EAC 整合包之后,DSH Web UI 内部的「设置」页**左侧分类边栏无法滚动**。

**排查状态**:已开始定位,怀疑是某个改设置页布局的 EAC 插件注入的 CSS 覆盖了滚动容器(候选:`dsh-dock-settings` / `dsh-easy-setup` / `dsh-plugin-manager` 都扩展设置页)。**未定位到根因**即决定下架 EAC。

**结论与教训**:若日后要恢复 EAC,建议先隔离是哪个插件注入的 CSS 覆盖了设置页侧边栏的 `overflow` 属性,再决定修插件还是修包。**在下架之前,应先确认问题是否由某个插件导致,以及该插件是否真的必要。**

---

## 十二、下架与清理范围

- **UI**:`RECOMMENDED_BUNDLES` 只留「新手起步套装」;EAC 卡片不再展示、不可下载。
- **代码**:
  - 删除 `BUNDLED_BUILTINS` / `BUNDLED_DESC` / `COMMUNITY` / `PRESETS` / `bundledDisplayName`(`bundles.ts`)。
  - `RecommendedBundle` 去掉 `bundled` / `presets` 字段;`PluginMeta` 去掉 `bundled` 标记;`PluginMatrixRow` 去掉 `bundled` 字段(`types.ts`)。
  - `installBundle` 简化为「建实例 + repairProfile + 逐个直装社区插件」。
  - 删除 `seedEac` / `eacSourceDir` / `bundledPlugins` / `fullySeeded` / `installPreset` / `collectManifestDirs` / `isValidSemver` / `sanitizeSemver`。
  - 插件矩阵与注册表子包扫描去掉 `bundled` 分支。
  - 移除 `instances.bundlePresets` / `bundleBundled` / `bundleOfficialNote` / `bundleGroupBundled` 等 i18n 键。
- **保留**:
  - `ensureRuntimeLinks`(harness boot 通用)。
  - `repairProfile`(bundle 层 vs insert 修复)。
  - 插件矩阵的直装行合并(TP 还需要)。
  - TP 包及其 11 个插件的中文简介。
- **不动**:用户已建的 EAC 实例(如 `web-11`)与其已装插件、本地库 `DSH-Plugin` 里的插件目录 —— 这些是用户环境,不属于「本软件包」。

---

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `src/shared/bundles.ts` | 整合包数据(当前仅「新手起步套装」) |
| `src/shared/types.ts` | `BundlePlugin` / `RecommendedBundle` / 矩阵类型 |
| `src/main/plugins.ts` | `installBundle` / `listPluginMatrix` / `ensureRuntimeLinks` |
| `src/renderer/src/pages/Instances.tsx` | 实例页:整合包卡片 + 详情弹窗 + 下载进度 |
