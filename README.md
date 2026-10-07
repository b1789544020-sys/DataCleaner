<div align="center">

# DataCleaner Pro · AI

**纯前端、零依赖的表格数据清洗工具 —— 打开一个 HTML 文件就能用，数据永不离开你的浏览器。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#为什么是零依赖)
[![Tests](https://img.shields.io/badge/tests-155%20passing-brightgreen.svg)](#测试)
[![No Build](https://img.shields.io/badge/build%20step-none-orange.svg)](#快速开始)

</div>

---

## 这是什么

导入 CSV 或 Excel，用**规则流水线**或**自然语言**清洗数据，再导出回 CSV / Excel。

```
Excel / CSV  →  清洗（规则 or 说人话）  →  Excel / CSV
```

和同类工具的区别在于三点：

- **数据不上传。** 全部计算在浏览器本地完成，没有后端。处理身份证、手机号、工资表这类数据时，这不是"更放心"，而是合规前提。
- **零第三方依赖。** 不引 SheetJS、不引 Papa Parse、没有 `npm install`、没有构建步骤。整个项目 ~200 KB，双击 `index.html` 即可运行，断网也能用。
- **AI 是可选项。** 不填 API Key，内置启发式引擎照样能识别常见指令。AI 只是让"说人话"变成可能，不是运行的前提。

## 截图

<!-- 放一张主界面截图，命名为 docs/screenshot.png 后取消下面一行的注释：
![DataCleaner Pro AI 界面](docs/screenshot.png)
-->

## 功能

### 数据读写

| 能力 | 说明 |
|---|---|
| CSV 无损解析 | 字符流状态机：正确处理字段内换行、`""` 转义、CRLF；自动嗅探分隔符（`,` `\t` `;` `\|`） |
| 编码自适应 | UTF-8 / GBK 自动识别 + BOM 处理，直接吃中文 Excel 导出的 CSV |
| Excel 导入 | `.xlsx` 零依赖解析：共享字符串、`inlineStr`、日期序列号、多工作表选择 |
| Excel 导出 | `.xlsx` 零依赖生成，表头加粗；前导零与长数字串不失真 |
| 拖拽导入 | 拖文件到表格区即可加载 |

### 清洗

| 能力 | 说明 |
|---|---|
| 规则流水线 | 9 条内置规则：去空白 / 日期标准化 / 去重 / 脱敏 / 数字规整 / 大小写 / 填充空值 / 删列 / 改名 |
| 自然语言清洗 | 描述需求 → AI 生成步骤 → **你确认后**才注入流水线 |
| 改动高亮 | 被修改的单元格标黄，跨页依然准确 |
| 撤销 | 一键回到清洗前 |
| 失败回滚 | 规则执行出错自动恢复到上一个正确状态 |
| 质量分析 | 主动发现重复行、空值、日期格式不一致 |

### 使用体验

| 能力 | 说明 |
|---|---|
| 规则预设 | 把整套规则配置存下来复用，支持 JSON 导出导入（团队共享） |
| 分页 | 每页 100 行，首/上/下/末页 + 跳页，显示全局行号 |
| 多模型 | DeepSeek / 通义千问 / OpenAI / 自定义 OpenAI 兼容端点 / 浏览器本地 WebLLM |
| 流式输出 | AI 分析过程逐字渲染，不用干等 |
| 多轮对话 | 「不对，改成 DD/MM/YYYY」—— 在上一轮基础上调整，不重置 |


## 浏览器兼容性

Excel 读写用的是浏览器原生的 `DecompressionStream` / `CompressionStream`（这正是"零依赖"的实现前提），它比较新：

| 浏览器 | CSV 清洗 | Excel 读写 |
|---|---|---|
| Chrome / Edge 103+ | ✅ | ✅ |
| Firefox 113+ | ✅ | ✅ |
| Safari 16.4+ | ✅ | ✅ |
| 更早的版本 | ✅ | ❌ 会提示"当前浏览器不支持" |

**CSV 的全部功能不依赖这些新 API**，老浏览器一样能用。只有 Excel 导入导出会受限，且失败时有明确提示而不是静默出错。

`.xls`（Excel 97-2003 的二进制格式）**不支持** —— 它与 `.xlsx` 是完全不同的格式。请先在 Excel 里另存为 `.xlsx`。

## 隐私与安全

**数据本身**：不上传，不落盘，没有遥测。关掉标签页就什么都不剩。你可以断网后打开 `index.html` 验证这一点。

**唯一的例外**：当你主动配置了云端 Provider（DeepSeek / 通义 / OpenAI）并点击发送时，会把**列名和前 10 行数据**作为 Prompt 上下文发给该服务商。这是让 AI 理解你数据结构的必要代价。如果这些数据敏感：

- 用默认的「启发式（无 API）」Provider —— 完全不联网；
- 或用 `webllm` 在浏览器内本地推理（首次需联网下载模型权重）。

**关于 API Key**：填入的 Key 保存在浏览器 `localStorage`（键名 `dc_ai_config`），**明文存储**。这是纯前端应用无法回避的取舍 —— 没有后端就没有安全的密钥托管处。因此：

- 不要在公用电脑上填写 Key；
- 建议使用有额度上限的测试 Key；
- 同源的任何脚本都能读到它，请勿在本项目中引入不可信的第三方脚本。

如果你的场景不允许这种存储方式，请使用启发式或本地模型 Provider。

## 快速开始

**方式一：直接打开**

克隆或下载后双击 `index.html`。没有构建、没有安装、断网可用。

**方式二：本地 HTTP 服务**（推荐，某些浏览器对 `file://` 的限制更严）

```bash
python -m http.server 8080
# 打开 http://localhost:8080
```

**先点「📦 加载示例」** 就能看到完整流程，不需要任何配置。

### 不用 API Key 也能体验

默认 Provider 是「启发式（无 API）」，能识别这类指令：

- 把日期统一成 YYYY-MM-DD
- 把手机号中间四位隐藏
- 删除完全重复的行
- 把部门列空值填为未知
- 清理姓名列的空白

### 接入大模型

1. 点右上角「⚙ AI 设置」
2. 选择 Provider，填入 API Key（**请先读上面的隐私与安全**）
3. 输入自然语言指令 → 观察流式分析 → 点「✅ 一键应用」

单次调用约 1100 tokens（数据 500 + Prompt 300 + 回复 300）。主流国产模型的实际花费通常在每次一分钱以内，但**具体价格请以服务商当前页面为准**。


## 项目结构

```
.
├── index.html            # 单页界面（无模板引擎、无框架）
├── css/style.css         # 暗色主题
├── js/
│   ├── rules.js          # 规则引擎：9 条内置规则 + 流水线执行 + 改动追踪
│   ├── io.js             # IO 层：CSV 状态机、XLSX 读写（手写 ZIP + XML）、预设序列化
│   ├── ai.js             # AI 层：Provider 抽象、Prompt 构造、流式解析、启发式兜底
│   └── app.js            # UI 与状态：渲染、分页、对话、回滚、导入导出
└── tools/                # 测试（Python 驱动，见下）
```

四个 JS 文件各自通过一个全局对象通信（`DCRules` / `DCIO` / `DCAI`），没有模块打包器。这是刻意的：它让"双击 HTML 就能跑"成为可能。

## 为什么是零依赖

引入 SheetJS 读写 Excel 会带来约 1 MB 的体积，且通常需要 CDN 或构建步骤 —— 这会破坏"离线可用、双击即开"这个核心特性。

于是 Excel 支持是手写的：

- **读**：手写 ZIP 中央目录解析（含 ZIP64 分支）→ 原生 `DecompressionStream('deflate-raw')` 解压 → `DOMParser` 读 XML → 处理共享字符串、`inlineStr`、日期序列号（含 1900 闰年 Bug 补偿）
- **写**：手写 CRC32 查表 + 本地文件头 / 中央目录 / EOCD 组装 → 原生 `CompressionStream('deflate-raw')` 压缩 → 生成最小合法工作簿

代价是 `io.js` 增加了约 14 KB，换来体积减少 98% 和完整的离线能力。

写入时特意处理了三个真实场景的坑：前导零编号（`007`）、超长数字串（手机号、身份证）会被 Excel 静默破坏，因此它们被强制写为文本；XML 非法控制字符会被剔除，避免生成打不开的文件。

## 测试

**不需要 Node.js。** 全部测试由 Python 驱动，共 155 个用例：

```bash
# 1) 规则逻辑单元测试（零依赖，最快）
python tools/test_rules.py            # 35 用例

# 2) 在真实浏览器里跑真正的 js/rules.js + js/ai.js
pip install playwright && playwright install chromium
python tools/test_engine_browser.py   # 36 用例

# 3) IO 层：CSV 状态机 / XLSX 读写 / 预设 / 分页
python tools/test_io_browser.py       # 61 用例

# 4) 端到端 UI：点按钮、导入导出、撤销、质量分析
python tools/test_e2e_browser.py      # 23 用例
```

浏览器测试会监听 `pageerror`，任何未捕获的 JS 异常都会导致测试失败。

覆盖范围包括：规则引擎与流水线、改动高亮、AI 启发式识别、JSON 解析容错（fenced / 混合文本 / 非法列过滤）、编码兼容（UTF-8 / GBK）、CSV 边界（字段内换行、`""` 转义、CRLF、分隔符嗅探）、XLSX 读写往返闭环、预设持久化、分页。

其中 XLSX 导出的正确性由 Python 标准库 `zipfile.testzip()` **独立校验** —— 不让自己写的解析器给自己的生成器打分，CRC32 错一位都会失败。

`tools/_probe_gaps.py` 不是测试，而是行为探针：它只打印真实行为、不做断言，用于排查问题。
## AI 步骤协议

AI 被要求返回严格 JSON，前端解析后转成规则流水线：

```json
{
  "analysis": "检测到手机号列未脱敏，日期格式不统一",
  "steps": [
    { "type": "mask_column",    "column": "手机号", "pattern": "middle4" },
    { "type": "normalize_date", "column": "入职日期", "target_format": "YYYY-MM-DD" }
  ]
}
```

支持 9 种步骤类型：`mask_column`、`normalize_date`、`fill_empty`、`trim_whitespace`、`remove_duplicates`、`split_column`、`rename_column`、`delete_column`、`custom_formula`。

解析层做了容错：能从 ```` ```json ```` 代码块、裸 JSON、或夹在解释文字中的 JSON 里提取结果；**引用了不存在列名的步骤会被丢弃**，避免 AI 幻觉直接作用到数据上。

## Provider 说明

| Provider | 需要 Key | 联网 | 说明 |
|---|---|---|---|
| `heuristic` / `mock` | ❌ | ❌ | 本地关键词启发式；也是测试用的确定性 Provider |
| `deepseek` / `qwen` / `openai` / `custom` | ✅ | ✅ | OpenAI 兼容接口，流式输出；`custom` 可自填 Base URL 与模型名 |
| `webllm` | ❌ | 首次需要 | 浏览器内本地推理，需 WebGPU；首次会下载模型权重 |

## 已知限制

诚实地列出来，省得你踩坑：

- **不支持 `.xls`**（仅 `.xlsx`）。请在 Excel 里另存为。
- **导出不保留样式**。导入 Excel 时只取值，颜色、公式、合并单元格、批注都会丢失 —— 本工具的定位是清洗数据，不是编辑工作簿。
- **公式按值读取**。读的是 Excel 缓存的计算结果，不是公式本身。
- **大文件受内存限制**。全部数据驻留内存，几十万行的表格会明显变慢或卡顿。
- **AI 只看前 10 行**。它据此推断列的语义，如果你的数据前 10 行不具代表性，生成的步骤可能不准 —— 这也是为什么应用前一定要你确认。
- **单工作表导出**。导出只生成一个 sheet。

## 贡献

欢迎 issue 和 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

一句话版本：**保持零依赖**，跑通 155 个测试用例，新功能配套测试。

## License

[MIT](LICENSE) © DataCleaner Pro AI Contributors
