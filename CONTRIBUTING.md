# 贡献指南

感谢你考虑为本项目出力。

## 最重要的一条：保持零依赖

本项目的核心价值是**双击 `index.html` 就能用、断网也能用、数据不出本机**。

因此以下改动**不会被接受**，无论功能多有用：

- 引入 npm 包 / `package.json` 依赖
- 引入 CDN 脚本标签
- 引入任何构建、编译、打包步骤（webpack / vite / babel / TypeScript 编译等）
- 引入需要后端服务的功能

如果某个功能确实需要第三方库，正确做法是**用浏览器原生 API 手写一个够用的最小实现**（参考 `js/io.js` 里的 ZIP 读写器），或者放弃这个功能。

唯一的例外是 `webllm`：它按需从 CDN 懒加载，且**不加载就不影响任何其他功能**。新增此类可选能力请先开 issue 讨论。

## 开发环境

不需要 Node.js，不需要安装依赖。

```bash
# 启动本地服务
python -m http.server 8080

# 浏览器测试需要 Playwright
pip install playwright
playwright install chromium
# 跨浏览器套件另外需要：
playwright install firefox webkit
```

## 提交前必须做的

跑完整测试套件，**283 个用例必须全绿，且 0 个 JS 错误**：

```bash
python tools/test_rules.py              # 35
python tools/test_engine_browser.py     # 41
python tools/test_io_browser.py         # 61
python tools/test_e2e_browser.py        # 23
python tools/test_regression_browser.py # 36，全程 file://
pip install openpyxl                    # 仅真实工作簿测试需要
python tools/test_real_xlsx_browser.py  # 8
python tools/test_transforms_browser.py # 25
python tools/test_worker_browser.py     # 27；默认真实临时 12 万行 CSV
python tools/test_cross_browser.py      # 27；Chromium / Firefox / WebKit
python tools/test_smoke_size.py         # 结构冒烟
```

浏览器测试会监听 `pageerror`。如果你的改动引入了未捕获异常，测试会失败 —— 这是刻意的。

**新增功能必须配套测试。** 修 bug 请先加一个能复现该 bug 的用例。

## 代码风格

- 2 空格缩进
- 原生 DOM API，不用框架
- 各层通过全局对象通信：`DCRules`（规则）、`DCIO`（读写）、`DCAI`（模型）、`DCWorker`（后台任务）
- 注释写"**为什么**"，而不是"做了什么"—— 尤其是处理格式怪癖的地方（比如为什么 `007` 必须存成文本）
- 用户可见的文案用中文

## 分层约定

| 文件 | 职责 | 不该出现的东西 |
|---|---|---|
| `js/rules.js` | 纯数据变换 | DOM 操作、网络请求 |
| `js/io.js` | 解析与序列化（含 Worker 安全 XML） | 页面 DOM 操作、业务逻辑 |
| `js/worker.js` | Worker 任务、分块传输、缓存与取消 | 网络请求、AI Provider、业务配置 |
| `js/ai.js` | Provider 与 Prompt | DOM 操作 |
| `js/app.js` | UI 与状态 | 底层解析逻辑 |

保持这个边界，测试才能脱离 UI 单独验证核心逻辑。

`rules.js` 和 `io.js` 的工厂函数体会被序列化到 Blob Worker，**函数体必须自包含**；不要把工厂内的实现改成依赖页面闭包、DOM 或外部模块。XLSX 的轻量 XML 解析器也必须保持 Worker 安全，不能改回 `DOMParser`。修改这些文件后必须运行 Worker 和跨浏览器套件，不需要也不能引入生成 Worker 的构建步骤。

## 报告问题

数据格式相关的 bug，请尽量附一个**最小可复现文件**（记得先去掉真实敏感数据）。请说明浏览器及版本 —— Excel 功能依赖较新的浏览器 API。
