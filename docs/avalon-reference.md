# Avalon-web 调研报告（flow 同系列对齐基准）

> 调研日期：M1 完成后的需求对齐阶段。仓库：`../avalon-web`（Electron + Web 双宿主）。
> 目标：flow 作为 Avalon 同系列应用，在 ①UI/视觉 ②项目/任务管理 ③与本地电脑交互 三方面保持一致。

## 0. Avalon 架构速览

```
浏览器/Electron ──invoke(HTTP/IPC)──▶ Node 服务
  ├─ src/main/appCore.ts          业务核心（桌面/Web 共用，零分叉）
  ├─ src/main/ipc/handlers/      全部 handler（fs/registry/workspace-roots/web…）
  └─ src/renderer/               React 渲染层（AvalonApi 接口：桌面=preload，Web=HTTP+WS shim）
```

- 前端：**React 18 + 纯手写 CSS 设计系统**（`styles.css` 1.26 万行 + 分域 css），图标 **lucide-react**，状态 **zustand**。**不用 AntD**。
- 持久化：**`registry.json`（应用数据目录，项目/任务索引）+ 目录内 `.avalon/project.md`、`.avalon/task.md`（YAML frontmatter 元数据）**。
- 桌面/宿主差异收拢在一个 `CoreHostBridge` 接口（窗口、事件推送、目录选择等）。
- Web 版已验证懒猫微服部署（`tools/avalon-lzcapp/`），目录选择默认打开「网盘/Avalon」工作目录。

## 1. UI / 视觉设计系统

### 1.1 设计令牌（`styles.css` 第二个 `:root`，light-only）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--ui-bg` / `--ui-stage` | `#f4f4f5` | 全局灰底（"一块工作台、一张纸"：灰底白面板） |
| `--ui-panel` / `--ui-rail-surface` | `#ffffff` | 卡片/列表行/弹窗 |
| `--ui-panel-subtle` / `--ui-rail-bg` / `--ui-chrome` | `#f4f4f5` | 次级面板、顶栏 |
| `--ui-border` | `rgba(28,34,48,.08)` | 默认描边 |
| `--ui-border-strong` | `rgba(28,34,48,.13)` | 强调描边 |
| `--ui-text` / `--ui-muted` / `--ui-faint` | `#1b1d24` / `#5c616c` / `#8b909b` | 三级文字 |
| `--ui-hover` / `--ui-active` | `rgba(28,34,48,.045)` / `.07` | 行/按钮 hover、选中 |
| `--ui-primary` | `#3d5ccc`（hover `#324db8`） | 主色 |
| `--ui-danger` / `--ui-success` | `#c43d48` / `#2a8f56` | 语义色 |
| `--ui-radius` / `--ui-radius-sm` | 8px / 6px | 圆角 |
| `--ui-shadow-lg` | `0 10px 28px rgba(16,24,40,.08)` | 浮层阴影 |
| 字体 | `Segoe UI Variable Text, Segoe UI, PingFang SC, Microsoft YaHei`；正文 **13px**，行高 1.45 | 全局 |
| 滚动条 | `.avalon-root *` 全部隐藏（`scrollbar-width:none`） | 全局 |

其他要点：focus ring `2px solid rgba(61,92,204,.36)`；隐藏滚动条；按钮过渡 120ms。

### 1.2 布局骨架

- **顶栏 AppChrome**（`app-chrome`，高 36px，`--ui-chrome` 底 + 1px 下边框）：
  - 左：标签页 `app-chrome-tab`（首页/上下文标签，26px 高、7px 圆角；active = 白底 + 主色字 + 1px 边框阴影）；
  - 上下文标签 = `ChromeContextTab`：当前项目/当前任务 + 下拉切换最近 5 个（含「在新窗口打开」）；
  - 右：设置图标 + Windows 窗口控制（最小/最大/关闭）。
- **首页（任务管理页 `task-home`）**：`h1 24px/600` + 副标题（muted）+ 右侧操作栏（`primary-button` 新建 + `secondary-button` 导入）；筛选区（网格、`select`/带图标搜索框 13px、重置链接）；**列表 = ListRow table**（无传统表格线：行高 36px、10px 圆角、hover `--ui-hover`、列 = 创建日期 84px | 标题 flex | 字段列 120px…；表头 11px/600 muted）；行尾 `⋯` 菜单（portal 弹层，112px 宽，右点击也呼出）；空态 `task-home-empty`（h3+p+操作按钮）。
- **项目详情（ProjectDetailView）**：顶部项目条（名称+备注+路径 chip+动作菜单：绑定目录/编辑/删除），右侧任务面板；`ProjectFocusSwitcher` 聚焦模式。
- **弹窗**：`modal-backdrop`（`rgba(12,28,48,.38)` + `backdrop-filter: blur(6px)`）+ `modal-dialog`（白、12px 圆角、`0 24px 80px rgba(15,47,82,.26)` 阴影、宽 min(560px,100vw-36px)、22px 内边距）；label 纵向（6px 间隔）；`modal-lead` 说明段；`modal-actions` 右对齐（取消=secondary、确认=primary，间距 8px）。
- **按钮**（compact 基准）：`primary-button` = `#3d5ccc` 实心、白字、6px 圆角、32px 高、无边框阴影（`:hover` 加深）；`secondary-button` = 白底 + `--ui-border` 边框 + 深灰字；图标 14-15px。
- **输入框**：32px 高、`--ui-border` 边框、6px 圆角、白底；focus 主色 ring。
- **侧边栏（聊天视图）**：深蓝渐变 `#0f2f52→#123b67→#102f50`、浅蓝字 `#d8e8fb`——flow 若做左导航可参考，但 Avalon 任务视图本身**没有左侧导航**，全走顶栏。

### 1.3 可整体搬用的组件（Avalon 源码路径）

| 组件 | 路径 | flow 用途 |
|---|---|---|
| `AppChrome` + `ChromeContextTab` | `components/AppChrome.tsx` + `styles/appChrome.css` | 顶栏：首页/项目切换/设置 |
| `ListRow`（table 变体 + 行菜单） | `components/ListRow.tsx` + `styles/listRow.css` | 项目列表、交易表、修正队列、主体表 |
| `ModalBackdrop` | `components/ModalBackdrop.tsx` | 全部弹窗 |
| `ProjectOverview` / `TaskOverview` 列表页模式 | 同目录 | 首页/全局列表页（header+筛选+ListRow） |
| `showPathPickerModal` 目录选择器 | `web/webAvalonApi.ts` L49-230（纯 DOM 实现，可直接 React 化） | **新建项目选文件夹** |
| `StatusMessage` / `task-home-error` / `task-home-notice` | 样式类 | 操作反馈（M1.2 设置页已仿其交互） |

## 2. 项目 / 任务管理方式（Avalon 模型）

### 2.1 数据模型（`shared/types/workItem.ts`）

- **Project**：`id, name, description, status(active|done|archived), projectTypeId, rootPath?（项目根目录）, materialsPath?, fieldValues（自定义字段值）, createdAt/updatedAt`。
- **Task**：`id, title, rootPath（任务目录，必填）, projectId?, priority, deadline, status, lastOpenedAt`。
- 自定义字段体系：`EntityTypeDefinition`（类型模板=字段绑定）+ `CustomFieldDefinition`（text/number/date/select，支持 required/filterable/sortable/visibleInList）→ 列表页筛选/排序/列展示全部字段驱动。
- 快照：`ProjectRegistrySnapshot { schemaVersion, revision, projects[], tasks[], activeTaskId }`。

### 2.2 项目与目录的关系（核心差异点：目录即项目）

- **新建项目**：`CreateProjectInput { name, parentDirectory?, folderName? }` → 服务在 `parentDirectory/folderName`（默认=name）**创建项目根目录并写入 `.avalon/project.md`**（YAML frontmatter=结构化元数据，body=可写 Markdown 备注）。
- **导入/绑定已有项目**：选一个已含 `.avalon/project.md` 的目录 → 登记进 registry（幂等去重）；「绑定目录」给无目录项目补绑。
- **扫描任务**：对项目根目录子目录做 `previewProjectTasks`（每个子目录=任务候选，读 `.avalon/task.md`）→ 勾选导入。
- **registry.json 只是索引**：真身在目录里 → 换机/目录被移走时可恢复；配套「设置→数据迁移→库内数据升级」检查：目录丢失、重复 ID/路径、缺失 project.md/task.md、登记与磁盘差异，逐条回填。
- 目录元数据文件：`<项目目录>/.avalon/project.md`、`<任务目录>/.avalon/task.md`（旧 `task.json` 只读迁移）。

## 3. 与本地电脑的交互方式

### 3.1 目录选择（本次需求重点）

- 桌面：原生对话框（`registry:pick-directory` → `dialog.showOpenDialog`）。
- Web（懒猫/自部署）：**目录浏览器弹窗**（`showPathPickerModal`，`pick`/`browse` 两种模式）：
  - 元素：标题 → 路径输入框（monospace，Enter=进入，Esc=取消）→ 工具条「↑ 上级」「＋ 新建文件夹」（输入名→「创建并进入」）→ 子目录列表（📁 行：名称+完整路径，点击进入；browse 模式额外列文件 📄）→ 状态行 → 底部「取消 / 打开此目录」。
  - 起始目录优先级：调用方指定 > 服务端 `fs:doc-root`（`AVALON_WORKSPACE_DIR` 工作目录 > `AVALON_DOC_ROOT` 网盘根）> 未探测到则提示"请手动输入绝对路径"。
  - 服务端三通道（`fsHandlers.ts`，Node 侧干活、前端只渲染）：
    - `fs:doc-root` → `{ docRoot?, workspaceDir? }`
    - `fs:list(path, includeFiles?)` → `{ path, parent, entries[{name,path}], files? }`（中文 localeCompare 排序，错误友好化：ENOENT=目录不存在/已被删除、EACCES=权限不足、ENOTDIR=不是目录）
    - `fs:create-dir({parent,name})` → `{ path }`（EEXIST=文件夹已存在…）
  - 绑定类通道复用同一弹窗：`registry:bind-project-directory(projectId, path?)` / `bind-task-directory` / `workspace-roots:mount` —— **handler 见到 path 参数即跳过原生对话框**，桌面端行为不变。
- 「在资源管理器中打开」：桌面 `shell.openPath`；Web 降级为 **browse 模式目录浏览器**（可看文件、不可"选中"）。

### 3.2 其他本地交互

- 文件拖拽上传：`workspace-roots:upload-file`（base64 走 invoke，单文件 20MB），上传后文件树即时刷新，非 md 文件自动弹 MD 化对话框。
- 文件树能力：列目录/新建/重命名/删除/移动、Markdown 转换（Excel 合并/切片/图片 OCR/PDF 转图）。
- 打开新窗口 = 新浏览器标签（Web 会话机制：每标签一个 sid）。

## 4. flow 采纳建议（待确认）

### A. 视觉（建议全量对齐 Avalon 设计系统）

1. 引 Avalon 令牌 + 基础样式（tokens/appChrome/listRow/modal/button/input/empty/error/notice）到 `apps/web/src/styles/`；AntD 保留但 `ConfigProvider` 主题对齐（primary `#3d5ccc`、borderRadius 6/8、fontSize 13、灰底白卡），交易浏览器等高密度表格继续用 AntD Table（行样式覆写为 ListRow 观感）。
2. 布局改为 Avalon 骨架：**去掉左侧深色 Sider**，改 36px 顶栏 AppChrome：
   - 标签：`首页`（项目列表）｜`交易`｜`修正`｜`主体`｜`规则`（全局页）｜**当前项目 ▾**（上下文切换器，最近项目，含「项目看板」固定项）｜设置图标
   - 选中项目后主区=项目详情：项目条（名称+路径 chip+文件数/交易数/风险数+动作菜单：重新扫描/打开文件夹/导出/编辑/删除）+ 页内视图切换（文件/交易/风险/修正，仿 `WorkspaceViewSwitcher` 分段控件）。
   - ⚠️ 结构决策：flow 现左导航 6 页 → Avalon 式"全局页做顶栏标签 + 项目做上下文"，需确认。
3. 弹窗/按钮/列表行全部换成 Avalon 模式（ListRow 表格、白底 12px 圆角弹窗、主色 #3d5ccc）。

### B. 项目管理（借鉴 Avalon「目录即实体」，flow 为三级业务结构）

- **客户**（xx 上市公司）→ **项目**（融资事项：IPO/再融资/可转债）→ **任务**（报告期分析）；每级创建时选定或由 flow 创建目录，并写标记文件（对应 Avalon `.avalon/project.md` 模式：目录是真身，SQLite 是索引）
- 目录布局：`客户目录/项目目录/任务目录/`，任务目录内：输入 PDF（递归）+ 输出 `flow-output/`（Excel/MD 报告）
- 关联方登记挂**客户层**（基础清单）+ **任务层**（报告期差异：本期新增/排除），v1.1 启用

### C. 本地电脑交互（借鉴 Avalon Web 目录浏览器）

1. 服务端新增 fs 通道（对齐 Avalon 语义与错误文案）：
   - `GET /api/fs/root` → `{ root? }`（`FLOW_DOC_ROOT` 环境变量；默认=用户主目录；自部署/微服可配）
   - `GET /api/fs/list?path=`、`POST /api/fs/mkdir`
2. 前端 **DirectoryPicker 组件**（React 化 `showPathPickerModal`：路径输入+↑上级+新建文件夹+子目录列表+「打开此目录」，pick/browse 双模式）。
3. 新建项目对话框：名称 + 「选择文件夹」按钮（只读输入框+预览"将创建/使用：xxx"，仿 Avalon `task-create-location`）。
4. 项目条动作「打开文件夹」：Windows 本地 = `child_process` `explorer`；Web（懒猫 v2）= browse 模式目录浏览器。
5. 文件上传拖拽（微服场景）留到 v2，与 PLAN 一致。

### D. 落地拆分（M1.5，已完成 2026-10-14，待用户验收）

- [x] 设计令牌 + 基础组件（AppChrome/ListRow/Modal/Button/Input/Empty/Error）移植 `apps/web/src/styles/flow.css + components/`
- [x] 布局重构：顶栏（首页/交易/修正/规则 + 设置）+ 客户→项目→任务下钻（hash 深链）+ 实体条
- [x] 服务端 fs API + `FLOW_DOC_ROOT`；DirectoryPicker 组件（路径输入/↑上级/新建文件夹/子目录列表/打开此目录）
- [x] 新建客户/项目/任务对话框（选择/创建目录 + 标记文件 `.flow/client.json`/`.flow/project.json`/`.flow/task.json`；新建目录/使用已有目录两种模式）
- [x] 客户列表 ListRow 化 + 状态 chip（目录丢失/已完成/已归档）；M1 遗留库自动迁移（挂「遗留客户」）
- [x] 设置页观感对齐（AntD 主题令牌 = Avalon 值；「当前任务」上下文切换器 M2 随任务工作视图加入）
