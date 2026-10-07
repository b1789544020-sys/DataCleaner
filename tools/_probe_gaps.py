"""Probe suspicious behaviours of DataCleaner Pro AI in a real browser.

Not a pass/fail suite - it prints what actually happens so gaps are visible:
  1. does the AI rule report changed cells (yellow highlight)?
  2. what happens to a GBK-encoded CSV (typical Excel export in China)?
  3. is tools/test_engine.js callable at all (rule.run vs rule.apply)?
  4. does a second AI turn merge or replace the previous steps?
"""
import functools
import http.server
import os
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8478


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    handler = functools.partial(QuietHandler, directory=BASE)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


PROBE_CHANGED = r"""
() => {
  const R = window.DCRules;
  const headers = ['姓名', '手机号'];
  const rows = [['张三', '13812345678'], ['李四', '13987654321']];
  const res = R.runPipeline(
    [{ ruleId: 'ai', enabled: true, opts: { steps: [
        { type: 'mask_column', column: '手机号', pattern: "keep_first(3) + '****' + keep_last(4)" }
    ] } }], headers, rows);
  return { rows: res.rows, changedSize: res.changed.size, modified: res.modifiedCount };
}
"""

PROBE_RULE_API = r"""
() => window.DCRules.RULES.map(r => ({
  id: r.id, hasRun: typeof r.run === 'function', hasApply: typeof r.apply === 'function'
}))
"""


def main():
    httpd = serve()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_context().new_page()
            page.goto("http://127.0.0.1:%d/index.html" % PORT, wait_until="load")
            page.wait_for_timeout(500)

            print("PROBE 1 - AI rule changed-cell tracking")
            out = page.evaluate(PROBE_CHANGED)
            print("   result rows      :", out["rows"])
            print("   changed set size :", out["changedSize"], "(0 => no yellow highlight for AI edits)")
            print()

            print("PROBE 2 - rule public API used by tools/test_engine.js")
            for r in page.evaluate(PROBE_RULE_API):
                print("   %-8s run()=%-5s apply()=%s" % (r["id"], r["hasRun"], r["hasApply"]))
            print("   test_engine.js calls rule.run(...) and rule id 'remove'")
            print()

            print("PROBE 3 - GBK CSV import (Excel default on Chinese Windows)")
            gbk = os.path.join(BASE, "tools", "_probe_gbk.csv")
            with open(gbk, "w", encoding="gbk", newline="") as f:
                f.write("姓名,手机号\n张三,13812345678\n")
            page.set_input_files("#file-input", gbk)
            page.wait_for_timeout(600)
            print("   header row shown :", page.locator("table.data-table thead").inner_text().replace("\n", " | "))
            print("   first data row   :", page.locator("table.data-table tbody tr").first.inner_text().replace("\n", " | "))
            print("   enabled rules    :", page.evaluate(
                "() => document.querySelectorAll('.rule-card .btn-mini.on').length"), "(0 => must re-enable manually)")
            os.remove(gbk)
            print()

            print("PROBE 4 - multi-turn: does turn 2 merge or replace turn 1 steps?")
            page.evaluate("localStorage.setItem('dc_ai_config', JSON.stringify({provider:'mock'}))")
            page.click("#btn-sample")
            page.wait_for_timeout(300)
            page.fill("#ai-input", "把手机号中间四位用星号隐藏")
            page.click("#ai-send")
            page.wait_for_selector(".ai-step-box", timeout=20000)
            page.locator(".ai-step-btns .btn.primary").last.click()
            page.wait_for_timeout(300)
            first = page.locator(".rule-card[data-rule='ai'] .ai-step-item").all_inner_texts()
            page.fill("#ai-input", "删除完全重复的行")
            page.click("#ai-send")
            page.wait_for_timeout(1500)
            page.locator(".ai-step-btns .btn.primary").last.click()
            page.wait_for_timeout(300)
            second = page.locator(".rule-card[data-rule='ai'] .ai-step-item").all_inner_texts()
            print("   after turn 1 :", first)
            print("   after turn 2 :", second)
            print("   panel keeps history?", page.locator(".ai-msg.user").count(), "user bubble(s) visible")
            print()

            print("PROBE 5 - webllm provider availability")
            print("   window.webllm loaded:", page.evaluate("() => !!window.webllm"))
            print("   index.html has web-llm script tag:",
                  "web-llm" in open(os.path.join(BASE, "index.html"), encoding="utf-8").read())
            browser.close()
    finally:
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
