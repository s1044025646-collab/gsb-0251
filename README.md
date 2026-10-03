# Conway 生命游戏演化与周期检测后端

使用 TypeScript + Node.js + SQLite 实现的 Conway 生命游戏**离线演化服务**。只提供 HTTP API 与命令行（CLI），无图形界面。

在 Windows 本地直接运行，**不依赖 Docker、WSL、付费服务或外部在线 API**。SQLite 使用 Node.js 内置的 `node:sqlite`（Node ≥ 22.5，推荐 Node 22.5+ / 已在 Node 25 上验证），无需安装原生模块。

## 规则与语义

- 每个细胞依据**上一代**的八邻域同步更新（双缓冲，绝不边扫描边修改）。
  - 死细胞恰好有 **3** 个活邻居时出生；
  - 活细胞有 **2 或 3** 个活邻居时存活，否则死亡。
- 两种边界，创建棋盘时二选一：
  - `fixed`：固定死边界，棋盘外一律视为死细胞；
  - `torus`：环面边界，左右、上下首尾相连（坐标对宽/高取模）。
- 坐标：原点 `(0,0)` 在左上角，`x` 向右、`y` 向下；`x ∈ [0,width)`、`y ∈ [0,height)`，越界坐标会被拒绝。
- 重复活点按一个细胞处理，同时返回重复个数 `duplicates` 作为提示。
- 全死棋盘正常工作。

## 周期检测

- 以**完整活细胞坐标集合**作为棋盘签名进行比对，逐代记录第一次出现的代数。
- 再次出现完全相同棋盘时返回 `firstSeen`（第一次出现代数）与 `period`（周期，代数差）。
- 固定点报告 `period = 1`；全死棋盘在第 0 代即固定（`firstSeen=0, period=1`）。
- **平移后的相同形状不是重复**；仅人口相同也不会判重。
- 用户要求演化到第 N 代时一定交付第 N 代；周期仅用于解释，不跳代、不改变代数含义（第 0 代为初始棋盘）。

## 资源限制

| 限制项 | 值 | 说明 |
| --- | --- | --- |
| 最小边长 | 3 | 宽、高均至少为 3 |
| 最大面积 | 10,000 | `width × height ≤ 10000` |
| 单次最大步数 | 2,000 | 一次 `run` 的最大目标代数 |
| 最多保存快照 | 2,000 | 每次运行保存第 0…N 代快照 |

限制可通过 `GET /api/limits` 或 `golife limits` 查询。

## 数据与版本

SQLite 数据库默认位于项目内 `data/golife.db`（可用 `--db` 覆盖），保存：

- 棋盘（尺寸、边界、名称、创建时间）；
- 棋盘的初始版本（每次 `edit` 产生一个**新版本**，旧版本保留）；
- 每次运行（所用棋盘版本、宽高、边界、目标代数、周期结果）；
- 每代快照（活点、人口、存活/出生/死亡差异）。

运行在创建时即固化所用的棋盘版本与快照，因此**之后编辑初始棋盘不会改变任何旧运行**。重启服务后可随时查询历史运行与各代结果。

## 快速开始

```powershell
npm install        # 仅安装 typescript 与类型声明
npm run build      # 编译到 dist/
npm test           # 编译并运行全部测试
npm run demo       # 方块/闪烁子/滑翔机 + 两种边界对照 + 重启读历史
npm start          # 启动 HTTP API（默认自动选择空闲端口）
```

也可指定端口：`node dist/src/cli.js serve --port 8080`。

## CLI 用法

```text
golife serve [--port P]
golife create --width W --height H --boundary fixed|torus --alive JSON [--name N]
golife list
golife show <boardId>
golife edit <boardId> --alive JSON          # 产生新版本
golife run <boardId> --steps N [--version V]
golife runs [--board <boardId>]
golife gen <runId> <generation>             # 活点、人口、差异
golife history <runId>                      # 各代人口
golife render <runId> <generation>          # 字符棋盘（# 活 / . 死）
golife limits
```

全局可选参数：`--db <path>`（默认 `data/golife.db`）、`--pretty`（JSON 缩进）。

PowerShell 示例（注意 JSON 引号转义，建议先存入变量）：

```powershell
$j = '[{"x":1,"y":2},{"x":2,"y":2},{"x":3,"y":2}]'
node dist/src/cli.js create --width 5 --height 5 --boundary fixed --alive $j
node dist/src/cli.js run 1 --steps 4
node dist/src/cli.js render 1 1
node dist/src/cli.js gen 1 2
```

字符棋盘示例（闪烁子第 1 代）：

```text
.....
..#..
..#..
..#..
.....
```

## HTTP API

所有响应为 `{ "ok": true, "data": ... }`；错误为 `{ "ok": false, "error": { "code", "message" } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/limits` | 资源限制 |
| POST | `/api/boards` | 创建棋盘 |
| GET | `/api/boards` | 棋盘列表 |
| GET | `/api/boards/:id` | 棋盘详情（含全部版本） |
| PUT | `/api/boards/:id` | 编辑初始棋盘（新版本），body：`{"alive":[...]}` |
| POST | `/api/boards/:id/run` | 演化并保存运行，body：`{"targetGeneration":N,"version":V?}` |
| GET | `/api/runs?boardId=` | 运行列表 |
| GET | `/api/runs/:id` | 运行详情（含 `cycle`） |
| GET | `/api/runs/:id/generations` | 各代人口 |
| GET | `/api/runs/:id/generations/:gen` | 某代活点、人口、差异 |
| GET | `/api/runs/:id/generations/:gen/render` | 某代字符棋盘 |

创建棋盘 body 示例：

```json
{
  "name": "blinker",
  "width": 5,
  "height": 5,
  "boundary": "fixed",
  "alive": [{ "x": 1, "y": 2 }, { "x": 2, "y": 2 }, { "x": 3, "y": 2 }]
}
```

某代响应示例：

```json
{
  "runId": 1,
  "generation": 1,
  "population": 3,
  "alive": [{ "x": 2, "y": 1 }, { "x": 2, "y": 2 }, { "x": 2, "y": 3 }],
  "diff": {
    "survived": [{ "x": 2, "y": 2 }],
    "born": [{ "x": 2, "y": 1 }, { "x": 2, "y": 3 }],
    "died": [{ "x": 1, "y": 2 }, { "x": 3, "y": 2 }]
  }
}
```

### 错误码

| HTTP | code | 触发场景 |
| --- | --- | --- |
| 400 | `INVALID_DIMENSION` | 宽高非整数或小于 3 |
| 422 | `LIMIT_EXCEEDED` | 面积/步数/快照超上限 |
| 400 | `INVALID_BOUNDARY` | 边界不是 `fixed`/`torus` |
| 400 | `INVALID_CELL` / `INVALID_ALIVE` / `INVALID_JSON` | 坐标或请求体非法 |
| 400 | `OUT_OF_BOUNDS` | 坐标越界 |
| 400 | `INVALID_GENERATION` / `INVALID_PORT` | 代数或端口非法 |
| 404 | `NOT_FOUND` | 棋盘/版本/运行不存在，或未知接口 |
| 404 | `GENERATION_NOT_FOUND` | 该运行未生成指定代数 |
| 500 | `INTERNAL` | 其他内部错误 |

## 引擎实现

- 正式引擎（`src/core.ts` 的 `step`）采用稀疏活点集合 + 邻居计数，先算出下一代完整集合，再与上一代求差异，保证同步语义。
- 参考实现 `stepDense` 使用简单的稠密双缓冲 `Uint8Array`，作为小棋盘基准；测试中连续多代核对两套引擎结果完全一致。
- 差异分为 `survived` / `born` / `died`；测试验证“把差异应用到上一代可精确恢复目标棋盘”，且人口始终等于去重后活坐标数量，批量演化与逐代单步结果一致。

## 演示内容

`npm run demo` 使用独立数据库 `data/demo.db`，依次展示：

1. 稳定方块（周期 1 固定点）；
2. 闪烁子（周期 2，横条 ⇄ 竖条）及每代差异；
3. 滑翔机（持续平移，因位置不同**不**判为循环）；
4. 同一贴边布局在 `fixed` 与 `torus` 下的不同结果；
5. 重复坐标提示与全死棋盘；
6. “服务重启”后重新打开数据库读取历史代数、周期与字符棋盘。

## 项目结构

```text
src/
  core.ts     规则、同步演化、稠密参考实现、差异、周期、字符渲染
  db.ts       SQLite 建表与连接
  service.ts 建模/版本/运行/快照查询（业务逻辑与资源限制）
  api.ts      HTTP 路由与空闲端口选择
  cli.ts      命令行入口
  demo.ts     演示脚本
test/         引擎、服务持久化、HTTP API 测试
data/         SQLite 数据库（运行时生成）
```

## 已知限制与假设

- 只实现 Conway 规则与两种边界，不支持自定义规则、图形界面或网络对战。
- 快照逐代全量保存以支持任意历史代查询与字符导出；为控制资源，步数/快照上限为 2000。
- 当前周期检测在检测到第一次重复后即记录周期，继续演化到用户要求的目标代数（不做周期跳算，代数含义严格保持）。
- 字符棋盘固定使用 `#`（活）与 `.`（死），等宽终端查看。
