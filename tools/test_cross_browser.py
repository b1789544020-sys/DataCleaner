"""Cross-engine smoke tests using the real application through file://.

Runs Chromium, Firefox and Playwright WebKit on the current machine. WebKit is
not a substitute for validating Safari on Apple hardware.
"""
from pathlib import Path
import zipfile
from playwright.sync_api import sync_playwright

BASE = Path(__file__).resolve().parents[1]
PAGE_URL = (BASE / "index.html").as_uri()
passed = 0
failed = 0


def check(ok, name):
    global passed, failed
    if ok:
        passed += 1
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name)


def first_cell(page):
    return page.locator("#table-wrap tbody tr").first.locator("td").nth(1).text_content()


def run_engine(playwright, name):
    errors = []
    browser = getattr(playwright, name).launch(headless=True)
    try:
        page = browser.new_page(accept_downloads=True)
        page.on("pageerror", lambda error: errors.append("pageerror: " + str(error)))
        page.on("console", lambda message: errors.append("console.error: " + message.text)
                if message.type == "error" else None)
        page.goto(PAGE_URL, wait_until="load")
        check(page.locator("#table-wrap tbody tr").count() == 10
              and page.locator(".rule-card").count() == 14,
              name + ": page load, sample data and all rule cards")

        result = page.evaluate(r'''async () => {
          const parsedJob = DCWorker.run('parseCSV', {
            text: 'Name,Note\n Alice ,N/A', delimiter: ',',
          });
          const parsed = await parsedJob.promise;
          const active = [{ ruleId: 'text', opts: { trim: true } }];
          const pipelineJob = DCWorker.run('pipeline', {
            activeRules: active, headers: parsed.headers, rows: parsed.rows,
          });
          const cleaned = await pipelineJob.promise;
          const profileJob = DCWorker.run('profile', { headers: cleaned.headers, rows: cleaned.rows });
          const profile = await profileJob.promise;
          const main = DCRules.runPipeline(active, parsed.headers, parsed.rows);
          return { modes: [parsedJob.mode, pipelineJob.mode, profileJob.mode],
            value: cleaned.rows[0][0], rows: profile.summary.rows,
            logsEqual: cleaned.log.join('|') === main.log.join('|') };
        }''')
        check(result["modes"] == ["worker"] * 3 and result["value"] == "Alice"
              and result["rows"] == 1 and result["logsEqual"],
              name + ": real Blob Worker parses, cleans, profiles and preserves Chinese logs")

        page.evaluate("""() => {
          const run = DCWorker.run; window.__csvFileJobs = []; window.__taskJobs = [];
          DCWorker.run = (...args) => {
            const job = run(...args);
            window.__taskJobs.push(job);
            if (job.kind === 'parseCSV') window.__csvFileJobs.push(job);
            return job;
          };
        }""")
        page.set_input_files("#file-input", {
            "name": "gbk.csv", "mimeType": "text/csv",
            "buffer": "姓名,城市\r\n 张三 ,北京\r\n".encode("gbk"),
        })
        page.wait_for_function("() => document.querySelector('#file-info').textContent.includes('gbk.csv')")
        file_read_fallback = page.evaluate("() => window.__csvFileJobs[0].fileReadFallback === true")
        check(first_cell(page) == " 张三 " and "1 行 × 2 列" in page.locator("#file-info").inner_text()
              and (name != "webkit" or file_read_fallback),
              name + ": GBK file input through the actual UI")

        page.click("#btn-run")
        page.wait_for_selector("#preview-bar:not([hidden])")
        preview_ok = first_cell(page) == "张三"
        page.click("#btn-apply")
        page.wait_for_selector("#preview-bar", state="hidden")
        page.click("#btn-undo")
        check(preview_ok and first_cell(page) == " 张三 ",
              name + ": preview, apply and undo")

        workbook = page.evaluate("""async () => {
          const blob = await DCIO.buildXLSX(['姓名', '日期', '编号'], [['张三', '2024-01-02', '007']]);
          const buffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          const wb = await DCIO.parseXLSX(buffer);
          return { bytes: Array.from(bytes), headers: wb.sheets[0].headers,
            rows: wb.sheets[0].rows };
        }""")
        check(workbook["headers"] == ["姓名", "日期", "编号"]
              and workbook["rows"] == [["张三", "2024-01-02", "007"]],
              name + ": native XLSX ZIP/XML build and parse")

        page.set_input_files("#file-input", {
            "name": "roundtrip.xlsx",
            "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "buffer": bytes(workbook["bytes"]),
        })
        page.wait_for_function("() => document.querySelector('#file-info').textContent.includes('roundtrip.xlsx')")
        check("1 行 × 3 列" in page.locator("#file-info").inner_text()
              and page.locator("#table-wrap").inner_text().find("007") >= 0
              and page.evaluate("window.__taskJobs.find(job => job.kind === 'parseXLSX').mode") == "worker",
              name + ": XLSX Worker file input preserves Chinese text and leading zeros")

        with page.expect_download() as download_info:
            page.click("#btn-export")
        download = download_info.value
        content = Path(download.path()).read_bytes().decode("utf-8-sig")
        check(content.splitlines()[0] == "姓名,日期,编号" and "007" in content
              and page.evaluate("window.__taskJobs.find(job => job.kind === 'buildCSV').mode") == "worker",
              name + ": real Worker CSV download")
        with page.expect_download() as xlsx_download_info:
            page.click("#btn-export-xlsx")
        xlsx_download = xlsx_download_info.value
        with zipfile.ZipFile(xlsx_download.path()) as archive:
            xlsx_ok = archive.testzip() is None and b"007" in archive.read("xl/worksheets/sheet1.xml")
        check(xlsx_ok and page.evaluate("window.__taskJobs.find(job => job.kind === 'buildXLSX').mode") == "worker",
              name + ": real Worker XLSX download is a valid ZIP workbook")
        check(not errors, name + ": zero JavaScript and console errors")
        if errors:
            print("\n".join(errors))
    finally:
        browser.close()


def main():
    print("=" * 60)
    print("Chromium / Firefox / Playwright WebKit file:// tests")
    print("=" * 60)
    with sync_playwright() as playwright:
        for name in ("chromium", "firefox", "webkit"):
            run_engine(playwright, name)
    print("=" * 60)
    print(f"RESULT: {passed} passed, {failed} failed (27 checks total)")
    print("=" * 60)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
