"""DataCleaner Pro · AI · 引擎测试（浏览器版，替代 tools/test_engine.js）

test_engine.js 需要 Node.js，本机没有安装；而 tools/test_rules.py 只是用 Python
复刻了一份规则逻辑，测不到真正的 js/rules.js。这个脚本用 Playwright 打开真实页面，
在浏览器里直接调用 window.DCRules / window.DCAI，因此测的是线上真正跑的代码。

用法:  python tools/test_engine_browser.py
"""
import functools
import http.server
import os
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8479


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    handler = functools.partial(QuietHandler, directory=BASE)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


# 在浏览器里跑完整断言，返回 [{ok, msg}, ...]
SUITE = r"""
async () => {
  const R = window.DCRules;
  const AI = window.DCAI;
  const out = [];
  const assert = (cond, msg) => out.push({ ok: !!cond, msg });
  const rule = id => R.RULES.find(r => r.id === id);

  const headers = ['姓名', '手机号', '入职日期', '部门', '邮箱', '备注'];
  const rows = [
    ['张三', '13812345678', '2023/1/5', '  技术部  ', 'a@b.com', '正常'],
    ['李四', '13987654321', '2022-11-20', '市场部', 'c@d.com', '  优秀  '],
    ['王五', '  15611223344  ', '2021.08.15', '技术部', '', '后端'],
    ['赵六', '13700001111', '2020/3/2', 'HR', 'e@f.com', ''],
    ['张三', '13812345678', '2023/1/5', '  技术部  ', 'a@b.com', '正常'],
    ['周八', '', '2022-06-15', '技术部', 'g@h.com', '前端'],
  ];
  const h = headers.slice();
  const rs = rows.map(r => r.slice());

  // ---- Test 1: 单条规则 ----
  const r1 = rule('text').run(h, rs, { trim: true, removeSpecial: false, caseMode: 'none' });
  assert(r1.rows[0][3] === '技术部', 'trim 空白：部门列首尾空白被去除');
  assert(r1.rows[2][1] === '15611223344', 'trim 空白：手机号首尾空白被去除');

  const r2 = rule('date').run(h, r1.rows, { targets: ['入职日期'], format: 'YYYY-MM-DD' });
  assert(r2.rows[0][2] === '2023-01-05', '日期标准化：2023/1/5 → 2023-01-05');
  assert(r2.rows[2][2] === '2021-08-15', '日期标准化：2021.08.15 → 2021-08-15');

  const r3 = rule('remove').run(h, r2.rows, {});
  assert(r3.rows.length === 5, '去重：6 行 → 5 行');

  const r4 = rule('number').run(h, r3.rows, { phone: true, strip: false });
  assert(r4.rows[0][1] === '138****5678', '手机号脱敏：13812345678 → 138****5678');

  // ---- Test 2: 完整流水线 ----
  const pipeline = [
    { ruleId: 'text', enabled: true, opts: { trim: true, removeSpecial: false, caseMode: 'none' } },
    { ruleId: 'date', enabled: true, opts: { targets: ['入职日期'], format: 'YYYY-MM-DD' } },
    { ruleId: 'remove', enabled: true, opts: {} },
    { ruleId: 'number', enabled: true, opts: { phone: true, strip: false } },
  ];
  const result = R.runPipeline(pipeline, headers.slice(), rows.map(r => r.slice()));
  assert(result.rows.length === 5, '流水线：去重后剩 5 行');
  assert(result.rows[0][1] === '138****5678', '流水线：手机号脱敏');
  assert(result.rows[0][2] === '2023-01-05', '流水线：日期标准化');
  assert(result.rows[0][3] === '技术部', '流水线：trim 空白');
  assert(result.changed.size > 0, '流水线：标记改动位置');

  // ---- Test 3: AI 启发式 ----
  let hr = AI.heuristicSteps('把日期统一成 YYYY-MM-DD', headers, rows);
  assert(hr.steps.length > 0, '启发式：日期指令有步骤');
  assert(hr.steps[0].type === 'normalize_date', '启发式：识别日期类型');

  hr = AI.heuristicSteps('把手机号中间四位隐藏', headers, rows);
  assert(hr.steps.length > 0, '启发式：手机号脱敏指令有步骤');
  assert(hr.steps[0].type === 'mask_column', '启发式：识别脱敏类型');

  hr = AI.heuristicSteps('把部门列的空值填为未知', headers, rows);
  assert(hr.steps.length > 0, '启发式：填充空值指令有步骤');

  hr = AI.heuristicSteps('删除完全重复的行', headers, rows);
  assert(hr.steps.length > 0, '启发式：去重指令有步骤');
  assert(hr.steps[0].type === 'remove_duplicates', '启发式：识别去重类型');


  // ---- Test 4: JSON 解析 ----
  const t1 = '```json\n{"analysis": "测试", "steps": [{"type": "trim_whitespace", "column": "姓名", "description": "去空白"}]}\n```';
  let parsed = AI.parseAIResponse(t1, headers);
  assert(parsed.steps.length === 1, 'JSON 解析：fenced code block 解析正确');
  assert(parsed.steps[0].type === 'trim_whitespace', 'JSON 解析：步骤类型正确');

  const t2 = '{"analysis": "直接 JSON", "steps": [{"type": "normalize_date", "column": "入职日期", "target_format": "YYYY-MM-DD", "description": "标准化日期"}]}';
  parsed = AI.parseAIResponse(t2, headers);
  assert(parsed.steps.length === 1, 'JSON 解析：直接 JSON 也能解析');
  assert(parsed.steps[0].target_format === 'YYYY-MM-DD', 'JSON 解析：嵌套字段正确');

  const t3 = '解释一下：先看数据```json\n{"analysis": "测试3", "steps": [{"type": "mask_column", "column": "手机号", "pattern": "keep_first(3)+****", "description": "脱敏"}]}\n```然后结束';
  parsed = AI.parseAIResponse(t3, headers);
  assert(parsed.steps.length === 1, 'JSON 解析：混合文本中提取 JSON');
  assert(parsed.steps[0].type === 'mask_column', 'JSON 解析：脱敏类型');

  const t4 = '{"analysis": "测试4", "steps": [{"type": "mask_column", "column": "不存在列", "description": "x"}, {"type": "trim_whitespace", "column": "姓名", "description": "去空白"}]}';
  parsed = AI.parseAIResponse(t4, headers);
  assert(parsed.steps.length === 1, 'JSON 解析：过滤无效列名');
  assert(parsed.steps[0].column === '姓名', 'JSON 解析：保留有效列名');

  // ---- Test 5: Markdown 渲染 ----
  let md = AI.renderMarkdown('# 标题\n## 副标题\n正文 **粗体** 和 `代码`\n- 列表项1\n- 列表项2');
  assert(md.indexOf('<h2>') >= 0, 'Markdown 渲染：h1 → h2');
  assert(md.indexOf('<h3>') >= 0, 'Markdown 渲染：h2 → h3');
  assert(md.indexOf('<strong>') >= 0, 'Markdown 渲染：粗体');
  assert(md.indexOf('md-inline') >= 0, 'Markdown 渲染：行内代码');
  assert(md.indexOf('<ul>') >= 0, 'Markdown 渲染：列表');
  md = AI.renderMarkdown('```js\nconsole.log("hi")\n```');
  assert(md.indexOf('md-code') >= 0, 'Markdown 渲染：代码块');

  // ---- Test 6: AI 步骤执行（JSON → 真实清洗，含改动高亮） ----
  const aiResult = AI.heuristicSteps('把手机号中间四位用星号隐藏，日期统一成 YYYY-MM-DD', headers, rows.slice(0, 5));
  const aiRun = R.runPipeline(
    [{ ruleId: 'ai', enabled: true, opts: { steps: aiResult.steps } }],
    headers.slice(), rows.slice(0, 5).map(r => r.slice()));
  assert(aiRun.rows.length > 0, 'AI 步骤执行：有输出');
  assert(String(aiRun.rows[0][1]).indexOf('****') >= 0, 'AI 步骤执行：手机号脱敏生效');
  assert(aiRun.changed.size > 0, 'AI 步骤执行：改动单元格被标记（黄色高亮）');

  // ---- Test 7: 质量分析 ----
  const issues = R.analyzeQuality(headers, rows);
  assert(issues.length > 0, '质量分析：示例数据能发现问题（共 ' + issues.length + ' 个）');

  // ---- Test 8: WebLLM 协议（伪引擎，不下载真实模型）----
  let capturedMessages = null;
  const streamed = [];
  const localEngine = {
    chat: { completions: { create: async options => {
      capturedMessages = options.messages;
      return (async function* () {
        yield { choices: [{ delta: { content: '{"analysis":"本地",' } }] };
        yield { choices: [{ delta: { content: '"steps":[]}' } }] };
      })();
    } } },
    interruptGenerate: () => Promise.resolve(),
  };
  window.webllm = { CreateMLCEngine: () => Promise.resolve(localEngine) };
  window.__dcWebLLMEnginePromise = Promise.resolve(localEngine);
  const local = await AI.chat({
    provider: 'webllm', instruction: '改成 DD/MM/YYYY', headers, sampleRows: rows,
    conversation: [{ role: 'user', content: '统一日期格式' }, { role: 'assistant', content: '{"steps":[]}' }],
    onChunk: text => streamed.push(text),
  });
  assert(capturedMessages.length === 4 && capturedMessages[1].content === '统一日期格式'
    && capturedMessages[2].role === 'assistant' && capturedMessages[3].content.includes('改成 DD/MM/YYYY'),
  'WebLLM：保留多轮历史且不重复当前指令');
  assert(local.fullText === '{"analysis":"本地","steps":[]}' && local.parsed.analysis === '本地'
    && streamed[streamed.length - 1] === local.fullText,
  'WebLLM：异步 token 流聚合和 JSON 解析正确');

  let generationStarted, interruptionCount = 0;
  const started = new Promise(resolve => { generationStarted = resolve; });
  const waitingEngine = {
    chat: { completions: { create: async () => {
      generationStarted();
      return { next: () => new Promise(() => {}) };
    } } },
    interruptGenerate: () => { interruptionCount++; return Promise.resolve(); },
  };
  window.__dcWebLLMEnginePromise = Promise.resolve(waitingEngine);
  const controller = new AbortController();
  const pending = AI.chat({ provider: 'webllm', instruction: '等待中', headers, sampleRows: rows,
    signal: controller.signal });
  await started;
  controller.abort();
  let abortName = '';
  try { await pending; } catch (error) { abortName = error.name; }
  assert(abortName === 'AbortError' && interruptionCount === 1,
    'WebLLM：停止会中断挂起的推理并返回 AbortError');

  let initializationStarted, lateProgress, staleProgressCount = 0;
  const initializing = new Promise(resolve => { initializationStarted = resolve; });
  window.webllm.CreateMLCEngine = (model, options) => {
    lateProgress = options.initProgressCallback;
    initializationStarted();
    return new Promise(() => {});
  };
  window.__dcWebLLMEnginePromise = null;
  const initController = new AbortController();
  const initializingRequest = AI.chat({ provider: 'webllm', instruction: '首次加载', headers, sampleRows: rows,
    signal: initController.signal, onProgress: () => { staleProgressCount++; } });
  await initializing;
  initController.abort();
  let initializationAbortName = '';
  try { await initializingRequest; } catch (error) { initializationAbortName = error.name; }
  lateProgress({ text: '旧任务进度' });
  assert(initializationAbortName === 'AbortError' && staleProgressCount === 0,
    'WebLLM：首次模型加载可停止等待，旧进度不会覆盖取消状态');

  let attempts = 0;
  window.webllm.CreateMLCEngine = () => {
    attempts++;
    return attempts === 1 ? Promise.reject(new Error('模拟初始化失败')) : Promise.resolve(localEngine);
  };
  window.__dcWebLLMEnginePromise = null;
  let initializationFailed = false;
  try { await AI.initWebLLM(); } catch (error) { initializationFailed = true; }
  const retriedEngine = await AI.initWebLLM();
  assert(initializationFailed && attempts === 2 && retriedEngine === localEngine,
    'WebLLM：初始化失败不污染缓存，可以重新初始化');
  delete window.__dcWebLLMEnginePromise;
  delete window.webllm;

  return out;
}
"""


def main():
    httpd = serve()
    passed = failed = 0
    js_errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.on("pageerror", lambda e: js_errors.append(str(e)))
            page.on("console", lambda m: js_errors.append(m.text) if m.type == "error" else None)
            page.goto(f"http://127.0.0.1:{PORT}/index.html")
            page.wait_for_selector("table.data-table", timeout=15000)

            results = page.evaluate(SUITE)
            print("=" * 60)
            print("引擎测试（真实浏览器 · js/rules.js + js/ai.js）")
            print("=" * 60)
            for r in results:
                if r["ok"]:
                    passed += 1
                    print("  PASS  " + r["msg"])
                else:
                    failed += 1
                    print("  FAIL  " + r["msg"])
            browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()

    print()
    print("=" * 60)
    print(f"汇总: {passed} 通过, {failed} 失败, {len(js_errors)} 个 JS 错误")
    for e in js_errors:
        print("  JS ERROR: " + e)
    print("=" * 60)
    return 1 if (failed or js_errors) else 0


if __name__ == "__main__":
    sys.exit(main())
