# flow — 银行流水分析核查工作台

上市公司银行流水（资金流）分析与核查工具：PDF 丢进任务文件夹 → 自动结构化 + 逐笔分类 + 规则预警 → WebUI 复核 → 导出 Excel/报告。

- 开发计划与范围：[PLAN.md](./PLAN.md)（里程碑 M1~M6；当前进度见 M1.5）
- 需求讨论记录（决策日志 + 问答过程）：[brainstorm-notes.md](./brainstorm-notes.md)
- Avalon 同系列对齐调研（UI 设计系统 / 项目管理 / 目录交互）：[docs/avalon-reference.md](./docs/avalon-reference.md)

## 业务结构（对齐 Avalon 两级模型）

```
客户（xx 上市公司）          ← .flow/client.json
 └─ 融资项目（IPO/再融资…）  ← .flow/project.json
     └─ 报告期任务（流水分析）← .flow/task.json；PDF 放任务目录，报告输出任务目录 flow-output/
```

## 开发运行（微服/本机 Linux）

```bash
pnpm install
pnpm --filter flow-web build     # 前端 → apps/web/dist
pnpm --filter flow-server build  # 服务端 → apps/server/dist/main.js
cd apps/server && node dist/main.js   # http://localhost:4120
```

- 数据目录：`FLOW_DATA_DIR`（默认 `apps/server/data/flow.db`，SQLite 单文件）
- 目录浏览器根：`FLOW_DOC_ROOT`（未设=用户主目录）；微服部署时设为网盘工作目录
- 端口：`PORT`（默认 4120）

## 发布 Windows 绿色包（v2 部署微服前）

```bash
node scripts/build-win-zip.mjs <版本号>   # 产物在 /tmp/flowpkg/flow-win-x64-<版本号>.zip
```

打包后：`git tag v<版本号>` → GitHub release 附 zip 资产（release/ 目录含 start.bat 与快速上手）。

## 当前里程碑状态

- [x] M1：monorepo 脚手架 + 设置页（LLM/OCR 端点探测、模型自动拉取）
- [x] M1.5：Avalon UI 对齐（设计令牌/顶栏/列表行/弹窗/目录选择器）+ 客户→项目→任务三级创建（选择/创建目录 + 标记文件）
- [ ] M2：任务目录 PDF 文字层解析 → LLM 结构化 → 交易入库 + 交易浏览器
