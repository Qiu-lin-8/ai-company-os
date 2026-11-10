# Project038_AICompanyOS

- 项目目标：调研并选型 AI 一人公司多智能体工作台底座。
- 第一阶段范围：对 Paperclip 与 OPC-Web 做源码级、架构级、界面级和集成能力调研，不修改上游仓库，不部署服务。
- 开始日期：20261110
- 当前状态：第一阶段调研已完成（20261110）
- 主要交付物：`output/AI一人公司多智能体工作台选型报告_20261110.md`
- 部门工作台（唯一页面）：`code/demo/department-workbench.html`（7个可点击页面，hash 路由 `#/overview` 等；总览/生产/仓储/采购读取飞书多维表格真实数据，CEO 总助/财务为示例数据并有标注；`index.html`、`workflow-demo.html` 已移除）
- UUMit 客户端：`assets/UUMit-Setup-1.0.4-prod.exe`（官方 OSS 下载；未安装；Windows 显示无 Authenticode 数字签名）
- 部门工作台（唯一页面）：`code/demo/department-workbench.html`（7个可点击页面，hash 路由 `#/overview` 等；总览/生产/仓储/采购读取飞书多维表格真实数据，CEO 总助/财务为示例数据并有标注；`index.html`、`workflow-demo.html` 已移除）
- 飞书接入验证（20261110）：官方 Lark CLI v1.0.99 已校验 SHA-256 后安装到 `tools/lark-cli-v1.0.99/`。CLI 自动创建应用成功，但 Base 最小只读授权（app/table/field/record/view read）被当前飞书组织安全策略拒绝；设备授权回收明确返回 `These permissions are restricted by your organization's security policy`。后续不再重复二维码授权，改用目标公司租户内的自建应用、管理员审批和指定多维表格授权。
- UUMit 公网部署（20261110）：本机服务运行于 `127.0.0.1:8765`，UUMit 服务 `ai-company-os` 已设为公开访问；客户端状态为 `online`、本机目标 `reachable: true`，公网地址 `https://ai-company-os--qiu.uua2a.ai/` 已在真实网络环境验收返回 HTTP 200。
- GitHub 仓库：`https://github.com/Qiu-lin-8/ai-company-os`（Public，默认分支 `main`）。
- 前端视觉升级（20261110）：主工作台融合产品型表单/导航、柔和聚光玻璃卡片、低密度交互粒子、动态网格与渐变氛围；保持原生 HTML/CSS/JS，无新增运行依赖，并为移动端和“减少动态效果”偏好提供降级。


## 飞书多维表格同步（20261110）

- `sync/worker.cjs`：只读全量读取多维表格里所有数据表，整理成普通值后写入 `data/snapshot.json`，变更追加到 `data/changes.jsonl`。长连接事件推送 + 每 60 秒轮询兜底。不写飞书、不发群消息。
- 页面通过 `GET /api/base/data` 取全部表；用 SSE `GET /api/base/stream` 接收更新通知，并每 30 秒检查一次 `GET /api/base/status`（序号变化即重新拉取），所以经 UUMit 公网访问也会跟着表格更新。
- 配置：复制 `.env.example` 为 `.env` 并填写 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_BASE_TOKEN`（`.env`、`data/` 已被 `.gitignore`，不会提交）；`npm install`（依赖 `@larksuiteoapi/node-sdk`）；`npm start` 启动。
- 后台常驻（Windows）：`Start-Process 'D:\nodejs\node.exe' 'code\demo\serve.cjs' -WorkingDirectory <项目目录> -WindowStyle Hidden -RedirectStandardOutput data\server.log -RedirectStandardError data\server.err.log`；停止：结束命令行包含 `code\demo\serve.cjs` 的 node 进程。
- 只读接口（GET）：`/api/base/status`（同步状态，不含凭据/错误详情）、`/api/base/data`（全部表记录）、`/api/base/changes?limit=`（变更日志）、`/api/base/stream`（SSE）。`POST /api/base/refresh` 仅限本机直接访问（带代理头的公网请求返回 403）。
- 飞书后台所需权限与事件配置：应用身份开通 `bitable:app:readonly`、`docs:event:subscribe`（实时推送，缺它则只轮询）；事件订阅选「长连接」并添加「多维表格记录变更」；发布版本；把应用加为多维表格协作者。
- 安全提示：公网地址（UUMit）能读到 `/api/base/*` 返回的真实业务数据，不含任何凭据。如需限制访问，请在 UUMit 侧设置访问控制，或在 `serve.cjs` 里加登录/令牌校验。
- 展示口径：飞书「合格率」公式 = 合格套数 / 计划生产套数，页面显示为「合格完成率」。