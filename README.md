# UK 亚马逊店铺 Seller ID 独立采集项目

本项目是 UK 店铺 ASIN 流水线的独立迭代版本，代码、配置、运行数据库、页面缓存、事件日志和 Excel 输出均位于本目录。它读取 `UK店铺库-中国地址.xlsx` 的“卖家数据”工作表 B 列，从单元格超链接的 `me=` 参数提取 Seller ID，再执行店铺分页、SellerSprite 补全、筛选、七天销量判断、详情补全和 Excel 导出。

## 与上个版本的区别

上个版本（原店铺 ASIN v14 流程）通过语义表头读取卖家链接，初筛要求评分存在且 `>=3.5`、评论数存在且 `<=300`、GBP `6.99..50.00`，随后查询历史数据库并排除已出现 ASIN。SellerSprite 补全后保留 FBA、变体 `<=3` 和上架 `0..720` 天，并按 `0..365`、`366..550`、`551..720` 天分段检查子体销量；只有 0–30 天且子体销量为空的商品才请求七天销量接口。结果导出为 5 张年龄表加完整的“产品数据”表。

当前版本的业务合同如下：

- 输入固定为 B 列 Seller ID：优先读取 Amazon 超链接目标，兼容直接填写 Seller ID 或 Amazon UK 卖家链接；按原始行顺序去重。
- 历史数据库阶段固定跳过，不建立 MySQL 连接，也不读取历史库配置。
- 初筛为 `(评分为空或评分>=3.5) 且 (评论数为空或评论数<=300) 且价格在 £6.99..£50.00`。NA 在 Excel 中显示为 `NA`，不转换为 0。
- 保留 FBA、变体数 `<=3`、上架 `0..180` 天（包含第 180 天）。子体销量只保存和导出，不再参与年龄分段淘汰。
- 所有通过前面筛选的产品都请求 `/v1/asin-sales/last-7-days`，固定 `daily_sales_minimum=3`，只接受精确结果 `yes` 或 `No`。
- 输出 19 列，工作表固定为 `0-30天`、`31-180天`、`产品数据`。

## 运行

需要 Node.js 22 或更高版本，以及本机 SellerSprite MCP 服务 `http://127.0.0.1:8012`。店铺浏览器阶段继续使用 UK 共享代理控制器和 `7901..7904` 端口；配置中的 `stores.proxyControllerPath` 指向该控制器目录。

```powershell
pnpm install
pnpm check
pnpm test

# 正式配置，读取全部 11,459 个 Seller ID
pnpm start
pnpm seller-ids

# 单卖家受控小样
pnpm pipeline --config config/amazon-uk-canary.yaml

# 续跑已有任务
pnpm pipeline --resume <run_id>
pnpm status --run <run_id>
pnpm status --run <run_id> --json
```

正式运行前确认本地代理控制器已发布可用 generation，并确认 SellerSprite 服务健康。离线测试、代理检查、`/healthz` 和接口协议检查不能替代真实 Amazon、SellerSprite 或完整生产验收。

## 运行数据和回滚

每次运行写入 `output/runs/<run_id>/`，包括 v15 SQLite、页面缓存、`events.jsonl`、`summary.json` 和 `exports/`。源 Excel SHA-256、配置哈希和合同指纹会写入任务元数据；源文件或业务合同改变时必须创建新任务。旧 schema 仅可只读审计，不能迁移或续跑。

本仓库只提交源码、配置模板、测试、锁文件和文档。源 Excel、SQLite、页面缓存、日志、浏览器会话、本机配置和凭据均被忽略。使用 Git 标签回滚代码和业务合同，再安装对应锁定依赖；运行数据不与新合同混用。

## 验证状态

当前离线验证覆盖 B 列输入、NA 初筛、0/30/31/179/180/181 天边界、FBA 和变体限制、全量七天销量任务、`yes`/`No` 结果、v15 数据库和三张表导出。真实 Amazon 全量运行不会在提交或测试阶段自动启动；在线验收应使用 `config/amazon-uk-canary.yaml` 单卖家配置单独执行并记录结果。
