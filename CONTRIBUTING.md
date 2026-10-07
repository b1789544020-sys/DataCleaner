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
```

## 提交前必须做的

跑完整测试套件，**155 个用例必须全绿，且 0 个 JS 错误**：

```bash
python tools/test_rules.py            # 35
python tools/test_engine_browser.py   # 36
python tools/test_io_browser.py       # 61
python tools/test_e2e_browser.py      # 23
python tools/test_smoke_size.py       # 结构冒烟
```

浏览器测试会监听 `pageerror`。如果你的改动引入了未捕获异常，测试会失败 —— 这是刻意的。

**新增功能必须配套测试。** 修 bug 请先加一个能复现该 bug 的用例。

## 代码风格

- 2 空格缩进
- 原生 DOM API，不用框架
- 各层通过全局对象通信：`DCRules`（规则）、`DCIO`（读写）、`DCAI`（模型）
- 注释写"**为什么**"，而不是"做了什么"—— 尤其是处理格式怪癖的地方（比如为什么 `007` 必须存成文本）
- 用户可见的文案用中文

## 分层约定

| 文件 | 职责 | 不该出现的东西 |
|---|---|---|
| `js/rules.js` | 纯数据变换 | DOM 操作、网络请求 |
| `js/io.js` | 解析与序列化 | DOM 操作（`DOMParser` 除外）、业务逻辑 |
| `js/ai.js` | Provider 与 Prompt | DOM 操作 |
| `js/app.js` | UI 与状态 | 底层解析逻辑 |

保持这个边界，测试才能脱离 UI 单独验证核心逻辑。

## 报告问题

数据格式相关的 bug，请尽量附一个**最小可复现文件**（记得先去掉真实敏感数据）。请说明浏览器及版本 —— Excel 功能依赖较新的浏览器 API。
