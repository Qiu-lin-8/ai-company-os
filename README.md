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

