# UK 亚马逊店铺 Seller ID 独立采集项目

这是从原 UK 店铺 ASIN 流水线复制出来的独立项目。项目有自己的源码、锁文件、SQLite 运行目录、日志、导出目录和 Git 历史；运行时只通过 `stores.proxyControllerPath` 调用现有共享代理控制器，并继续使用本机 SellerSprite `http://127.0.0.1:8012`。

## 与上个版本的业务流程

原 v14 流程从语义表头读取卖家链接，店铺分页采集后做评分、评论数和 GBP 价格初筛；普通卖家入口连接历史数据库并排除历史 ASIN；SellerSprite 两轮补全后保留 FBA、变体数不超过 3、上架 0–720 天，并按 0–365、366–550、551–720 天检查子体销量。只有 0–30 天且子体销量为空的商品才调用七天销量接口，最后补全详情并导出 `0-30天`、`31-365天`、`366-550天`、`551-720天` 和完整 `产品数据` 共五张表。

## 当前版本的业务合同

- 读取 `UK店铺库-中国地址.xlsx` 的 `卖家数据` 工作表，从第 2 行开始读取 B 列。优先取超链接目标中的 `me`/`seller` 参数，也接受合法 Seller ID 和 Amazon UK 卖家链接；完全空行跳过，非空非法行在联网前按行号报错，按首次出现顺序去重。已离线核对 11,459 个唯一 Seller ID。
- 评分和评论数分别允许 `NA`：评分为空或 `>=3.5`，评论为空或 `<=300`；价格必须存在且为 £6.99–£50.00（含边界）。SQLite 保留 `NULL`，Excel 显示 `NA`。
- 历史数据库阶段固定标记为“已跳过”，不建立 MySQL 连接、不读取历史库凭据。
- SellerSprite 补全后保留 FBA、变体数 `<=3`（缺失淘汰）、上架 0–180 天（含第 180 天）。子体销量只保存和导出，不再分段筛选。
- 每个通过上述条件的 ASIN 都创建七天销量任务，固定 UK、run 冻结的 `as_of_date`、`daily_sales_minimum=3`；只接受精确 `yes`/`No`。协议错误、窗口或阈值回显不符会暂停并保留任务，续跑不会重复已完成任务。
- 输出保留原 19 列，固定三张表：`0-30天`、`31-180天`、`产品数据`。每条最终记录均完成七天销量判断并为 `yes`。

## 配置和运行

先复制模板并按本机路径保存为被忽略的本地配置；模板不会提交源 Excel、凭据或运行数据：

```powershell
Copy-Item config/amazon-uk.example.yaml config/amazon-uk.local.yaml
Copy-Item config/amazon-uk-canary.example.yaml config/amazon-uk-canary.local.yaml
```

正式配置保持 `source.limit: 0`；小样配置单独设为 1，不能修改正式配置后再忘记恢复。运行前确认共享代理控制器路径、SellerSprite 服务和浏览器依赖。

```powershell
pnpm install
pnpm check
pnpm test

# 全量入口（不会在安装、测试或提交阶段自动启动）
pnpm start

# 单卖家小样；最多扩展至 3 个卖家
pnpm seller-ids --config config/amazon-uk-canary.local.yaml

# 续跑
pnpm seller-ids --resume <run_id>
pnpm status --run <run_id>
pnpm status --run <run_id> --json
```

也可以使用 `pipeline` 及各阶段命令。每次 run 写入 `output/runs/<run_id>/`，包含 v15 SQLite、事件日志、摘要和 Excel。run 元数据冻结项目标识、业务合同版本、配置哈希、源文件 SHA-256、UTC `as_of_date` 和创建时 Git 提交号；文档提交不会改变续跑合同。旧项目 v14 或其他项目的 run 只可只读审计，不能写入或续跑。

## 版本、隔离和回滚

`baseline-store-v14-20260918` 是不含凭据和运行数据的 v14 源码基线，`v1.0.0` 是首个独立版本；后续修订使用新的标签。回滚时检出目标标签并按该标签的 `pnpm-lock.yaml` 安装依赖，运行数据只由合同匹配的版本续跑。公开仓库忽略 `.xlsx`、SQLite、缓存、日志、浏览器会话、本机配置和凭据。

离线测试、代理检查、`/healthz` 和 MCP 协议测试只证明对应边界；它们不能代替真实 Amazon、共享代理、SellerSprite 或完整生产验收。正式 11,459 家店铺任务必须由操作者明确启动。

## 验证状态

类型检查和 22 个测试文件（117 项）通过；测试覆盖 B 列链接/纯 ID/重复/非法行、评分评论 NA、价格和日期边界、FBA/变体、全量七天销量路由、精确 `yes`/`No`、协议暂停、v15 SQLite 和三张表导出。真实小样需单独记录实际覆盖到的阶段；若样本没有合格产品，不得据此宣称七天销量或详情链路已完成。

## Canary 实际记录（2026-09-18）

已使用独立 `config/amazon-uk-canary.local.yaml` 完成 1 个卖家 `A2T5LHS3VM5VWI` 的真实链路，run 为 `20260918T092624Z-6b26f541`。代理 generation 已健康发布，店铺阶段成功抓取 400 页、去重后 2,336 条商品，SQLite 完整性为 `ok`；SellerSprite、历史旁路、筛选、导出阶段均正常结束。该卖家所有候选均因评论数超过 300 被初筛淘汰，因此本次没有覆盖 7 天销量、详情补全或 NA 最终行；不能把这个 canary 当作这些阶段的线上验收。三张 Excel 表均生成表头并保持 19 列。
