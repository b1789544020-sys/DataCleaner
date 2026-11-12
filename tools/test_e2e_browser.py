"""Real-browser E2E check for DataCleaner Pro AI (Playwright + Chromium).

Serves the folder over HTTP and drives the actual UI:
  load sample -> AI instruction (mock provider) -> apply steps -> run pipeline
  -> undo -> export CSV -> quality analysis -> missing-key error path
Collects all console errors / page errors so broken JS is caught.

Usage:  python tools/test_e2e_browser.py
"""
import functools
import http.server
import os
import re
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8477

passed, failed = 0, 0


def check(cond, msg):
    global passed, failed
    if cond:
        passed += 1
        print("  PASS  " + msg)
    else:
        failed += 1
        print("  FAIL  " + msg)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    handler = functools.partial(QuietHandler, directory=BASE)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    httpd = serve()
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context(accept_downloads=True)
            page = ctx.new_page()
            page.on("console", lambda m: errors.append("console." + m.type + ": " + m.text)
                    if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))

            print("=" * 60)
            print("E2E 1: page load + auto sample data")
            print("=" * 60)
            page.goto("http://127.0.0.1:%d/index.html" % PORT, wait_until="load")
            page.wait_for_timeout(600)
            check(page.locator("table.data-table").count() == 1, "data table rendered")
            check(page.locator("table.data-table tbody tr").count() == 10,
                  "sample data has 10 rows")
            check("示例数据" in page.locator("#file-info").inner_text(),
                  "file info shows sample file name")
            check(page.locator(".rule-card").count() == 14, "14 rule cards rendered (13 built-in + AI)")

            print()
            print("=" * 60)
            print("E2E 2: AI instruction with mock provider (streaming)")
            print("=" * 60)
            page.evaluate(
                "localStorage.setItem('dc_ai_config', JSON.stringify({provider:'mock'}))")
            page.fill("#ai-input", "把手机号中间四位用星号隐藏，日期统一成 YYYY-MM-DD")
            page.click("#ai-send")
            page.wait_for_selector(".ai-step-box", timeout=20000)
            steps_text = page.locator(".ai-step-list").inner_text()
            check("mask_column" in steps_text, "AI produced mask_column step")
            check("normalize_date" in steps_text, "AI produced normalize_date step")
            check(page.locator(".ai-response .md-code").count() >= 1,
                  "AI reply rendered a fenced json code block")

            print()
            print("=" * 60)
            print("E2E 3: apply steps into pipeline + run")
            print("=" * 60)
            page.click(".ai-step-btns .btn.primary")
            page.wait_for_timeout(400)
            ai_card = page.locator(".rule-card[data-rule='ai']")
            check("已启用" in ai_card.inner_text(), "AI rule became enabled")
            check(ai_card.locator(".ai-step-item").count() >= 2,
                  "AI steps listed inside the rule card")

            page.click("#btn-run")
            page.wait_for_timeout(800)
            table = page.locator("table.data-table").inner_text()
            check(re.search(r"138\*{4}5678", table) is not None,
                  "phone masked in table after run (138****5678)")
            check("2023-01-05" in table, "date normalized in table after run")
            log_lines = page.locator("#ai-log .log-line").count()
            check(log_lines > 0, "execution log has %d line(s)" % log_lines)

            print()
            print("=" * 60)
            print("E2E 4: undo / export / quality analysis")
            print("=" * 60)
            page.click("#btn-undo")
            page.wait_for_timeout(400)
            check("13812345678" in page.locator("table.data-table").inner_text(),
                  "undo restored original phone value")

            with page.expect_download() as dl:
                page.click("#btn-export")
            path = dl.value.path()
            content = open(path, "r", encoding="utf-8-sig").read()
            check(content.splitlines()[0].startswith("姓名,手机号"),
                  "exported CSV header correct")
            check(len(content.splitlines()) == 11, "exported CSV has header + 10 rows")

            page.click("#btn-suggest")
            page.wait_for_selector("#modal.open", timeout=5000)
            modal = page.locator("#modal-body").inner_text()
            check("数据质量分析" in modal, "quality analysis modal opened")
            check(page.locator("#modal-body .suggest-list li").count() > 0,
                  "quality analysis listed issues")
            page.click("#modal-close")

            print()
            print("=" * 60)
            print("E2E 5: real API provider without key -> friendly error")
            print("=" * 60)
            page.evaluate("localStorage.setItem('dc_ai_config',"
                          " JSON.stringify({provider:'deepseek', apiKey:''}))")
            page.fill("#ai-input", "删除完全重复的行")
            page.click("#ai-send")
            page.wait_for_selector(".ai-err", timeout=10000)
            check("API Key" in page.locator(".ai-err").inner_text(),
                  "missing API key shows friendly error")

            print()
            print("=" * 60)
            print("E2E 6: built-in dedupe rule + GBK csv import")
            print("=" * 60)
            page.click("#btn-sample")
            page.wait_for_timeout(300)
            page.locator(".rule-card[data-rule='remove'] .btn-mini").first.click()
            page.click("#btn-run")
            page.wait_for_timeout(600)
            check(page.locator("table.data-table tbody tr").count() == 9,
                  "dedupe rule removed the 1 duplicate row (10 -> 9)")

            gbk = os.path.join(BASE, "tools", "_e2e_gbk.csv")
            with open(gbk, "w", encoding="gbk", newline="") as fh:
                fh.write("姓名,城市\n张三,北京\n")
            page.set_input_files("#file-input", gbk)
            page.wait_for_timeout(600)
            check("姓名" in page.locator("table.data-table thead").inner_text(),
                  "GBK csv header decoded correctly")
            check("北京" in page.locator("table.data-table tbody").inner_text(),
                  "GBK csv body decoded correctly")
            os.remove(gbk)

            # 拖拽导入（用 DataTransfer 模拟真实 drop 事件）
            page.evaluate(
                """() => {
                    const dt = new DataTransfer();
                    dt.items.add(new File(['a,b\\n1,2\\n'], 'drop.csv', { type: 'text/csv' }));
                    const el = document.getElementById('table-wrap');
                    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
                    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
                }"""
            )
            page.wait_for_timeout(600)
            check("drop.csv" in page.locator("#file-info").inner_text(),
                  "drag & drop csv imported (file-info updated)")
            check("a" in page.locator("table.data-table thead").inner_text(),
                  "drag & drop csv headers rendered")

            browser.close()
    finally:
        httpd.shutdown()

    print()
    print("=" * 60)
    print("Console / page errors: %d" % len(errors))
    for e in errors:
        print("   - " + e[:300])
    print("=" * 60)
    print("RESULT: %d passed, %d failed, %d js errors" % (passed, failed, len(errors)))
    print("=" * 60)
    sys.exit(0 if failed == 0 and not errors else 1)


if __name__ == "__main__":
    main()
