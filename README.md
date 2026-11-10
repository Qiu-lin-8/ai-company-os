# Project038_AICompanyOS

- 项目目标：调研并选型 AI 一人公司多智能体工作台底座。
- 第一阶段范围：对 Paperclip 与 OPC-Web 做源码级、架构级、界面级和集成能力调研，不修改上游仓库，不部署服务。
- 开始日期：20261110
- 当前状态：第一阶段调研已完成（20261110）
- 主要交付物：`output/AI一人公司多智能体工作台选型报告_20261110.md`
- 交互样本：`code/demo/index.html`（静态模拟数据，不连接模型或飞书）
- 多智能体协作演示：`code/demo/workflow-demo.html`（总助→生产→仓储→采购→财务→审批）
- 详细部门工作台：`code/demo/department-workbench.html`（7个可点击页面，含BOM、库存、比价、财务和追溯）
- UUMit 客户端：`assets/UUMit-Setup-1.0.4-prod.exe`（官方 OSS 下载；未安装；Windows 显示无 Authenticode 数字签名）
- 本地网页服务：`code/demo/serve.cjs`，默认入口 `http://127.0.0.1:8765/`，首页为详细部门工作台
- 飞书接入验证（20261110）：官方 Lark CLI v1.0.99 已校验 SHA-256 后安装到 `tools/lark-cli-v1.0.99/`。CLI 自动创建应用成功，但 Base 最小只读授权（app/table/field/record/view read）被当前飞书组织安全策略拒绝；设备授权回收明确返回 `These permissions are restricted by your organization's security policy`。后续不再重复二维码授权，改用目标公司租户内的自建应用、管理员审批和指定多维表格授权。
- UUMit 公网部署（20261110）：本机服务运行于 `127.0.0.1:8765`，UUMit 服务 `ai-company-os` 已设为公开访问；客户端状态为 `online`、本机目标 `reachable: true`，公网地址 `https://ai-company-os--qiu.uua2a.ai/` 已在真实网络环境验收返回 HTTP 200。
- GitHub 仓库：`https://github.com/Qiu-lin-8/ai-company-os`（Public，默认分支 `main`）。
- 前端视觉升级（20261110）：主工作台融合产品型表单/导航、柔和聚光玻璃卡片、低密度交互粒子、动态网格与渐变氛围；保持原生 HTML/CSS/JS，无新增运行依赖，并为移动端和“减少动态效果”偏好提供降级。


## 飞书多维表格同步

### 它做什么
- `sync/worker.cjs`:全量读取多维表格里**所有数据表**(动态发现,不写死表名),整理成干净的普通值(选项 id → 选项名、文本数组 → 字符串、关联 → 文本列表、数字字符串 → 数字、时间戳 → 北京时间 ISO),写入 `data/snapshot.json`;和上一份快照对比,把新增/更新/删除(含变化的字段名和前后值)追加到 `data/changes.jsonl`。
- 实时:通过**长连接**(WSClient,不需要公网 IP)接收 `drive.file.bitable_record_changed_v1` 事件,收到后 1.5 秒防抖,只重新同步变更的那张表。
- 兜底:**始终每 60 秒轮询**一次(`FEISHU_POLL_MS` 可调),事件没配好也照常更新。
- `code/demo/serve.cjs` 在同一进程里启动同步,并提供只读 JSON 接口和页面 `/base-live.html`。
- 不写多维表格、不给任何群发消息。

### 1. 飞书开发者后台配置
在 <https://open.feishu.cn/app> 打开自建应用:

1. **权限管理**(应用身份权限)开通:
   | 权限 | 用途 | 状态 |
   |---|---|---|
   | `bitable:app:readonly` | 读取多维表格 | 必需 |
   | `docs:event:subscribe`(或 `drive:drive` / `docs:doc` / `sheets:spreadsheet` 任一) | 调用「订阅云文档事件」接口,开启记录变更推送 | 实时推送必需,不开则只轮询 |
   | `im:message`、`im:chat:readonly` | 以后往群里推送/读群信息 | 暂不使用,可先开 |
2. **事件与回调 → 事件配置**:订阅方式选「**使用长连接接收事件**」,点「添加事件」,搜索「多维表格记录变更」(`drive.file.bitable_record_changed_v1`)并添加(可顺手加上「多维表格字段变更」)。添加时页面若提示还需要某个权限,一并开通。
3. **版本管理与发布**:创建版本并发布;租户要求管理员审批的话,等审批通过才生效(权限、事件都要发布后才生效)。
4. **把应用加为多维表格协作者**:打开多维表格 → 右上角「分享」/「…」→「添加文档应用」(或协作者)→ 搜索你的应用 → 权限选「可阅读」即可。

### 2. 配置 `.env`
复制 `.env.example` 为 `.env`(已在 `.gitignore`,不会被提交;`data/` 同样不会被提交):

```
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=你的 App Secret
FEISHU_BASE_TOKEN=NoYAbHrBEak736sNy7CcHv4AnOh   # 多维表格链接 /base/ 后面那一串
# 可选:FEISHU_POLL_MS=60000  PORT=8765  QUALITY_WARN=0.9  LOW_STOCK_RATIO=0.3
```
凭证只从环境变量/`.env` 读取,不会写入日志或快照。

### 3. 运行
```powershell
cd D:\enterprise\ai-company-os\ai-company-os
npm install            # 只依赖 @larksuiteoapi/node-sdk(长连接),没有它则自动退化为纯轮询
npm start              # 等价于 node code/demo/serve.cjs
```
打开 <http://127.0.0.1:8765/base-live.html>(其他演示页面路由不变)。只做一次同步并打印各表记录数:`npm run sync`。

后台常驻、停止与重启(Windows):
```powershell
# 启动(隐藏窗口,日志写 data\server.log)
Start-Process -FilePath node -ArgumentList 'code\demo\serve.cjs' -WorkingDirectory . -WindowStyle Hidden -RedirectStandardOutput data\server.log -RedirectStandardError data\server.err.log
# 停止
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*code\demo\serve.cjs*' | ForEach-Object { Stop-Process -Id $_.ProcessId }
```
重启 = 先停止再启动。

### 4. 接口(只读,仅 127.0.0.1)
| 接口 | 说明 |
|---|---|
| `GET /api/base/status` | 同步状态、事件订阅/长连接状态 |
| `GET /api/base/tables` | 所有表:名称、记录数、字段名 |
| `GET /api/base/tables/:name` | 某张表(表名或 table_id)的字段与标准化记录 |
| `GET /api/base/changes?since=` | 变更日志;`since` 可以是序号(整数)或 ISO 时间;`limit` 默认 200 |
| `GET /api/base/summary` | 规则生成的中文摘要:工单进度、合格率、库存预警、领料不足、最近变更 |
| `GET /api/base/stream` | SSE,同步完成/有变更时推送 `sync` 事件 |
| `POST /api/base/refresh` | 立即重新从飞书读取(仍是只读) |

摘要规则:合格率 = 合格数量 / 已完工数量,低于 90% 提示;物料「剩余库存」≤ 0 为缺料、≤ 目前库存 30% 为偏低;「实领 < 应领」提示领料不足;状态为「待生产」却已有投产/完工数量提示核对。阈值可用环境变量调整。

### 5. 安全说明
- 服务只监听 127.0.0.1。若通过 UUMit 等隧道公开了演示页,`/api/base/*` 和 `/base-live.html` 会拒绝带代理头或非本机 Host 的请求,真实业务数据不会被公开;其他演示页行为不变。
- `.env`、`data/`(快照与变更日志含真实业务数据)均不入库。

### 6. 排错
- 启动日志出现「⚠ 事件订阅失败:应用缺少权限」:按上表开通 `docs:event:subscribe` 并发布版本,重启服务。期间自动用 60 秒轮询。
- 日志出现「长连接失败」:确认事件配置里订阅方式是「长连接」,并已发布版本。
- `91402 NOTEXIST` / `91403 Forbidden`:多维表格 token 不对,或应用还没被加为协作者。
- `99991672`:缺权限,错误信息里会列出需要的权限名。
