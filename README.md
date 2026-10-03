# 生命游戏棋盘演化与周期检测后端

使用 **TypeScript + Node.js + SQLite** 实现的 Conway 生命游戏离线演化服务，只提供 **HTTP API 与 CLI**，无图形界面、无外部在线依赖、无需 Docker/WSL。

SQLite 使用 Node 内置的 `node:sqlite`（Node 22+ 提供，建议 Node 22.5+；本项目在 Node 25 上验证），无需任何原生编译。

## 规则与语义

- 规则固定（Conway）：
  - 死细胞在八邻域中**恰好有 3 个**活邻居时出生；
  - 活细胞在有 **2 或 3 个**活邻居时存活，否则死亡。
- **同步更新**：每一代所有细胞只依据上一代状态计算，内部使用稠密双缓冲（两个 `Uint8Array`），绝不边扫描边修改。
- **坐标约定**：原点 `(0,0)` 在左上角，`x` 向右，范围 `[0, width-1]`；`y` 向下，范围 `[0, height-1]`。
- 两种边界（创建棋盘时二选一，之后不可更改）：
  - `dead`：固定死边界，棋盘外恒为死细胞；
  - `torus`：环面，左右、上下首尾相连，坐标按模映射。
- 最小尺寸 `3×3`；越界坐标（含负数）返回校验错误；重复活点按一个细胞处理并返回 `duplicates` 数量与中文提示。
- 全死棋盘正常处理，演化后仍为全死。

## 限制

可通过 `GET /api/limits` 或 `gol limits` 查询：

| 限制 | 默认值 |
| --- | --- |
| 最小边长 | 3 |
| 最大宽 / 高 | 200 |
| 最大面积 | 10000 |
| 单次运行最大代数 | 10000 |
| 每个运行保存快照上限 | 1024 |

检测到周期后只保存「进入周期前 + 一个完整周期」的快照，之后按模安全跳算，但**返回代数始终是你请求的目标代**。平移后的形状（如滑翔机）签名不同，不会被当作重复；也不会仅凭人口数判定循环。固定点报告周期 `1`。

## 快速开始

```powershell
npm install
npm run build
npm test
npm run demo
npm start
```

- `npm start` 默认自动选择一个**空闲端口**并在终端打印 `http://127.0.0.1:<port>`。
 指定端口：

```powershell
$env:PORT=8080; npm start
```

- 数据库文件默认在项目内 `data/gol.sqlite`，可用环境变量 `GOL_DB` 覆盖。
- 也可用 `npm run dev` / `npm run cli` 通过 `tsx` 直接运行 TypeScript（无需先构建）。

## HTTP API

所有响应为 `{ ok: true, data }` 或 `{ ok: false, error: { code, message, details } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/limits` | 查询限制 |
| POST | `/api/boards` | 创建棋盘（含初始版本） |
| GET | `/api/boards` | 列出棋盘 |
| GET | `/api/boards/:id` | 查询棋盘（含最新版本号） |
| PUT | `/api/boards/:id` | 编辑初始棋盘，生成**新版本** |
| GET | `/api/boards/:id/versions` | 列出版本 |
| POST | `/api/boards/:id/run` | 演化到 `targetGen`（`mode`: `single`/`batch`，可选 `version`） |
| GET | `/api/boards/:id/runs` | 某棋盘的运行 |
| GET | `/api/runs` | 全部运行 |
| GET | `/api/runs/:id` | 运行元信息（含周期） |
| GET | `/api/runs/:id/generations/:gen` | 查询已生成的某一代及差异 |
| GET | `/api/runs/:id/generations/:gen/ascii` | 字符棋盘导出 |

创建棋盘请求示例：

```json
{
  "name": "闪烁子",
  "width": 5,
  "height": 5,
  "boundary": "dead",
  "alive": [{ "x": 1, "y": 2 }, { "x": 2, "y": 2 }, { "x": 3, "y": 2 }]
}
```

演化结果包含 `population`、`alive`、`diff.born/died/survived` 与 `cycle`：

```json
{
  "gen": 4,
  "population": 3,
  "alive": [{ "x": 1, "y": 2 }, { "x": 2, "y": 2 }, { "x": 3, "y": 2 }],
  "diff": { "born": [], "survived": [], "died": [] },
  "cycle": { "detected": true, "firstOccurrenceGen": 1, "repeatGen": 3, "period": 2 }
}
```

### 错误码

| code | HTTP 状态 | 含义 |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | 参数非法（尺寸、坐标、代数等） |
| `INVALID_JSON` | 400 | 请求体不是合法 JSON |
| `NOT_FOUND` | 404 | 棋盘 / 版本 / 运行 / 代不存在 |
| `CONFLICT` | 409 | 状态冲突（预留） |
| `PAYLOAD_TOO_LARGE` | 413 | 超出面积、步数或快照限制 |
| `METHOD_NOT_ALLOWED` | 405 | 方法不允许 |
| `INTERNAL_ERROR` | 500 | 内部错误 |

## CLI

```powershell
npm run cli -- limits
npm run cli -- create 5 5 dead "[[1,2],[2,2],[3,2]]" 闪烁子
npm run cli -- boards
npm run cli -- board 1
npm run cli -- versions 1
npm run cli -- edit 1 "[[0,0]]" 改成单点
npm run cli -- run 1 4 batch
npm run cli -- runs 1
npm run cli -- gen 1 3
npm run cli -- export 1 0
npm run cli -- cycle 1
```

`export`/`run` 用等宽字符输出棋盘（`█` 活，`·` 死）并列出出生 / 死亡 / 存活清单。

## 演示与测试

```powershell
npm run demo
```

演示包含：稳定方块（周期 1）、闪烁子（周期 2）、会平移的滑翔机、以及**同一边缘布局在 `dead` 与 `torus` 下的对照**与环面角落环绕。

```powershell
npm test
```

测试覆盖：

- 出生规则的全部邻居数量（死细胞 0–8 邻居，仅 3 出生）；
- 生存规则的全部邻居数量（活细胞 0–8 邻居，仅 2/3 存活）；
- 同步更新、矩形（非正方形）棋盘、`3×3` 下限、越界拒绝；
- 环面角落环绕与死边界对照、全死棋盘、重复坐标去重；
- 独立稠密双缓冲**基准实现**与正式引擎多代结果交叉核对；
- 差异应用后恢复目标棋盘、人口等于活坐标数；
- 批量与逐步演化结果完全一致；
- 周期 1 / 周期 2 检测，且以完整相同棋盘签名为依据；
- 编辑初始棋盘生成新版本、旧运行不被改变；
- 周期跳算仍交付正确目标代、资源限制错误码；
- **重启服务后**从 SQLite 读取历史代数与结果；
- HTTP 主流程与错误码。

## 持久化模型

- `boards`：初始棋盘尺寸与边界方式；
- `board_versions`：每次编辑产生新版本（旧版本保留）；
- `runs`：每次运行记录所用棋盘版本、目标代数、模式与检测到的周期；
- `snapshots`：每代的完整棋盘（RLE 位图）、人口与出生/存活/死亡坐标。

运行永久绑定到创建时的版本，因此之后编辑初始棋盘不会改变任何历史运行结果。
