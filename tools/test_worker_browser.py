"""Real Worker/UI large-file checks through file:// (no server or network).

Optional benchmark size: set DC_BENCH_ROWS=250000 (default 120000).
Requires Playwright Chromium. Performance output is a measurement, not a capacity promise.
"""
from pathlib import Path
import os
import tempfile
import time
from playwright.sync_api import sync_playwright

BASE = Path(__file__).resolve().parents[1]
PAGE_URL = (BASE / "index.html").as_uri()
ROWS = int(os.environ.get("DC_BENCH_ROWS", "120000"))
passed = 0
failed = 0
errors = []


def check(ok, name):
    global passed, failed
    if ok:
        passed += 1
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name)


def watch(page):
    page.on("pageerror", lambda error: errors.append("pageerror: " + str(error)))
    page.on("console", lambda message: errors.append("console.error: " + message.text)
            if message.type == "error" else None)


DIRECT_SUITE = r'''
async gbkBytes => {
  const out = [];
  async function test(name, fn) {
    try { await fn(); out.push({ ok: true, name }); }
    catch (error) { out.push({ ok: false, name, error: error.message }); }
  }
  const assert = (ok, message) => { if (!ok) throw new Error(message || 'assertion'); };
  const wire = result => JSON.stringify({
    headers: result.headers, rows: result.rows, log: result.log,
    changed: [...result.changed].sort(), removed: [...result.removed].sort(),
    removedCols: [...result.removedCols].sort(),
  });
  const active = [
    { ruleId: 'text', opts: { trim: true } },
    { ruleId: 'missing', opts: { targets: ['Note'], tokens: ['N/A'] } },
    { ruleId: 'filter', opts: { column: 'Note', operator: 'equals', value: 'drop', action: 'remove' } },
  ];
  const headers = ['Name', 'Note', 'Amount'];
  const rows = [[' A ', 'keep', '10'], ['B', 'drop', '20'], ['C', 'N/A', 'abc']];

  await test('CSV Worker preserves escaped quotes and embedded newlines', async () => {
    const text = 'Name,Note\r\n"A,1","first line\r\nsecond ""quote"""\r\n';
    const main = DCIO.parseCSV(text, ',');
    const job = DCWorker.run('parseCSV', { text, delimiter: 'auto' });
    const actual = await job.promise;
    assert(job.mode === 'worker', 'not a real Worker');
    assert(JSON.stringify(actual.rows) === JSON.stringify(main.rows), 'CSV rows differ');
    assert(actual.delimiter === ',' && actual.encoding === 'utf-8');
  });
  await test('CSV Worker decodes GBK bytes', async () => {
    const result = await DCWorker.run('parseCSV', {
      buffer: new Uint8Array(gbkBytes).buffer, delimiter: ',',
    }).promise;
    assert(result.encoding === 'gbk', result.encoding);
    assert(result.headers.join(',') === '姓名,城市', result.headers.join(','));
    assert(result.rows[0].join(',') === '张三,北京');
  });
  await test('pipeline exactly matches the main-thread engine', async () => {
    const expected = DCRules.runPipeline(active, headers.slice(), rows.map(row => row.slice()));
    const job = DCWorker.run('pipeline', { activeRules: active, headers, rows });
    const actual = await job.promise;
    assert(job.mode === 'worker');
    assert(wire(actual) === wire(expected), 'pipeline results differ');
    assert(actual.changed instanceof Set && actual.removed instanceof Set, 'Sets not restored');
    assert(actual.removed.size === 1, 'structural removal metadata lost');
    assert(actual.affectedColumns.join(',') === '0,1', 'affected-column summary differs');
    assert(rows[0][0] === ' A ', 'caller input mutated');
  });
  await test('queued profile and pipeline tasks both complete', async () => {
    const pipeline = DCWorker.run('pipeline', { activeRules: active.slice(0, 1), headers, rows });
    const profile = DCWorker.run('profile', { headers, rows });
    const values = await Promise.all([pipeline.promise, profile.promise]);
    assert(values[0].rows[0][0] === 'A');
    assert(values[1].summary.rows === 3 && values[1].summary.columns === 3);
    assert(pipeline.mode === 'worker' && profile.mode === 'worker');
  });
  await test('profile reuses the latest Worker table without another row transfer', async () => {
    const source = DCWorker.run('parseCSV', { text: 'A,B\nx,1\ny,2', delimiter: ',' });
    await source.promise;
    const profile = DCWorker.run('profile', { headers: [], rows: [], sourceJob: source });
    const result = await profile.promise;
    assert(profile.usedCache === true, 'Worker result cache was not used');
    assert(result.summary.rows === 2 && result.summary.columns === 2);
  });
  await test('pipeline reuses the imported Worker source without another row transfer', async () => {
    const source = DCWorker.run('parseCSV', { text: 'Name,Note\n A ,N/A', delimiter: ',' });
    await source.promise;
    const pipeline = DCWorker.run('pipeline', {
      activeRules: active.slice(0, 2), headers: [], rows: [], sourceJob: source,
    });
    const result = await pipeline.promise;
    assert(pipeline.usedCache === true, 'pipeline source cache was not used');
    assert(result.rows[0][0] === 'A' && result.rows[0][1] === '');
    const repeatedJob = DCWorker.run('pipeline', {
      activeRules: active.slice(0, 2), headers: [], rows: [], sourceJob: source,
    });
    const repeated = await repeatedJob.promise;
    assert(repeatedJob.usedCache === true, 'repeated preview did not retain the source cache');
    assert(wire(repeated) === wire(result), 'repeated cached preview is not identical');
  });
  await test('a stale Worker cache transparently falls back to full rows', async () => {
    const oldSource = DCWorker.run('parseCSV', { text: 'A\nold', delimiter: '' });
    await oldSource.promise;
    const newSource = DCWorker.run('parseCSV', { text: 'A\nnew', delimiter: '' });
    await newSource.promise;
    const thirdSource = DCWorker.run('parseCSV', { text: 'A\nthird', delimiter: '' });
    await thirdSource.promise; // 两份 LRU 缓存中，oldSource 至此被淘汰。
    const profile = DCWorker.run('profile', {
      headers: ['A'], rows: [['old']], sourceJob: oldSource,
    });
    const result = await profile.promise;
    assert(profile.cacheFallback === true && profile.usedCache === false, 'cache miss was not retried');
    assert(result.summary.rows === 1);
  });
  await test('a rule error rejects without killing later Worker jobs', async () => {
    const bad = DCWorker.run('pipeline', {
      activeRules: [{ ruleId: 'ai', opts: { steps: [{ type: 'not-valid' }] } }], headers, rows,
    });
    let message = '';
    try { await bad.promise; } catch (error) { message = error.message; }
    assert(message.includes('不支持的步骤类型'), message);
    const good = await DCWorker.run('parseCSV', { text: 'A\nok', delimiter: '' }).promise;
    assert(good.rows[0][0] === 'ok');
  });
  await test('cancellation rejects and a fresh Worker accepts the next job', async () => {
    const job = DCWorker.run('profile', { headers, rows });
    job.cancel();
    let name = '';
    try { await job.promise; } catch (error) { name = error.name; }
    assert(name === 'AbortError', name);
    const next = DCWorker.run('pipeline', { activeRules: active.slice(0, 1), headers, rows });
    const result = await next.promise;
    assert(next.mode === 'worker' && result.rows[0][0] === 'A');
  });
  await test('XLSX Worker builds, parses and exports from its cached table', async () => {
    const build = DCWorker.run('buildXLSX', {
      headers: ['姓名', '编号', '备注'], rows: [['张三', '007', 'a,b'], ['李四', '008', 'line\nnext']], sheetName: '后台',
    });
    const blob = await build.promise;
    assert(build.mode === 'worker' && blob instanceof Blob && blob.size > 500, 'XLSX not built in Worker');
    const parse = DCWorker.run('parseXLSX', { buffer: await blob.arrayBuffer() });
    const workbook = await parse.promise;
    assert(parse.mode === 'worker' && parse.cacheable === true, 'XLSX not parsed/cached in Worker');
    assert(workbook.sheets[0].rows[0].join(',') === '张三,007,a,b', 'XLSX values differ');
    const csv = DCWorker.run('buildCSV', { headers: [], rows: [], sourceJob: parse });
    const csvText = await (await csv.promise).text();
    assert(csv.mode === 'worker' && csv.usedCache === true, 'CSV export did not reuse XLSX cache');
    assert(csvText.includes('"a,b"') && csvText.includes('"line\nnext"'), 'CSV escaping differs');
    const excel = DCWorker.run('buildXLSX', { headers: [], rows: [], sourceJob: parse, sheetName: '缓存' });
    assert((await excel.promise).size > 500 && excel.usedCache === true, 'XLSX export did not reuse cache');
  });
  await test('Worker-safe XML supports namespaces, entities, CDATA and rejects unsafe markup', async () => {
    const doc = DCIO.parseXML('<?xml version="1.0"?><x:root xmlns:x="urn:t"><x:item r:id="rId1" xmlns:r="urn:r"> A &amp; &#x4E2D; <![CDATA[<raw>]]><x:child>!</x:child></x:item></x:root>');
    const item = doc.getElementsByTagName('item')[0];
    assert(item && item.textContent === ' A & 中 <raw>!', item && item.textContent);
    assert(item.getAttribute('r:id') === 'rId1', 'namespace attribute lost');
    assert(DCIO.parseXML('<root><x></root>').getElementsByTagName('parsererror').length === 1,
      'malformed XML was not rejected');
    assert(DCIO.parseXML('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///secret">]><x>&e;</x>').getElementsByTagName('parsererror').length === 1,
      'DOCTYPE/external entity was not rejected');
  });
  await test('diff Worker returns arbitrary 100-item pages without rescanning on the main thread', async () => {
    const pipeline = DCWorker.run('pipeline', {
      activeRules: [{ ruleId: 'text', opts: { trim: true } }], headers: ['Name'],
      rows: Array.from({ length: 250 }, (_, index) => [' row ' + index + ' ']),
    });
    const cleaned = await pipeline.promise;
    assert(cleaned.changed.size === 250, 'expected 250 changed markers');
    const first = DCWorker.run('diff', { result: cleaned, sourceJob: pipeline, offset: 0, limit: 100 });
    const firstPage = await first.promise;
    const last = DCWorker.run('diff', { result: cleaned, sourceJob: pipeline, offset: 200, limit: 100 });
    const lastPage = await last.promise;
    assert(first.mode === 'worker' && first.usedCache === true && firstPage.entries.length === 100);
    assert(firstPage.total === 250 && firstPage.entries[0].after === 'row 0');
    assert(lastPage.entries.length === 50 && lastPage.entries[49].after === 'row 249', 'last diff page is incomplete');
  });
  return out;
}
'''

def large_csv(count):
    lines = ["Name,Phone,Date,Dept,Amount,Note"]
    for i in range(count - 1):
        lines.append(
            f" User {i} ,138{i:08d},2024/1/{i % 28 + 1}, Dept {i % 8} ,{i % 5000},"
            + ("N/A" if i % 7 == 0 else "ok")
        )
    lines.append(lines[1])  # exactly one duplicate data row
    return ("\n".join(lines)).encode("utf-8")


def first_name(page):
    return page.locator("#table-wrap tbody tr").first.locator("td").nth(1).text_content()


def reset_heartbeat(page):
    return page.evaluate("""() => {
      const h = window.__heartbeat, previous = { maxGap: h.maxGap, ticks: h.ticks };
      h.maxGap = 0; h.last = performance.now(); return previous;
    }""")


def main():
    payload = large_csv(ROWS)
    temporary = tempfile.TemporaryDirectory(prefix="dc-worker-bench-")
    large_path = Path(temporary.name) / "large.csv"
    large_path.write_bytes(payload)
    print("=" * 60)
    print(f"Worker / large-file tests: {ROWS:,} rows, {len(payload) / 1048576:.1f} MiB CSV")
    print("=" * 60)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            watch(page)
            page.goto(PAGE_URL, wait_until="load")
            results = page.evaluate(DIRECT_SUITE, list("姓名,城市\r\n张三,北京\r\n".encode("gbk")))
            for result in results:
                check(result["ok"], result["name"] + (" -- " + result.get("error", "") if not result["ok"] else ""))

            page.evaluate("""() => {
              window.__heartbeat = { last: performance.now(), maxGap: 0, ticks: 0 };
              window.__heartbeatTimer = setInterval(() => {
                const now = performance.now(), h = window.__heartbeat;
                h.maxGap = Math.max(h.maxGap, now - h.last); h.last = now; h.ticks++;
              }, 25);
            }""")
            started = time.perf_counter()
            page.set_input_files("#file-input", str(large_path))
            page.wait_for_function("name => document.querySelector('#file-info').textContent.includes(name)",
                                   arg="large.csv", timeout=60000)
            page.wait_for_selector("#quality-box .report-summary", timeout=60000)
            import_ms = round((time.perf_counter() - started) * 1000)
            import_heartbeat = reset_heartbeat(page)
            check(f"{ROWS} 行" in page.locator("#file-info").inner_text(), "large CSV imports through the real UI")
            check(first_name(page) == " User 0 ", "committed import retains the original whitespace")
            check("1 行重复" in page.locator("#quality-box").inner_text(), "background quality profile is rendered")

            started = time.perf_counter()
            page.click("#btn-run")
            page.wait_for_selector("#preview-bar:not([hidden])", timeout=60000)
            preview_ms = round((time.perf_counter() - started) * 1000)
            check(first_name(page) == "User 0", "large preview uses Worker-cleaned rows")
            check(f"修改 {ROWS * 2} 个单元格" in page.locator("#preview-summary").inner_text(),
                  "large preview preserves every changed-cell marker")
            page.wait_for_selector("#quality-box .report-summary", timeout=60000)
            preview_heartbeat = reset_heartbeat(page)
            page.click("#btn-preview-diff")
            total_changes = ROWS * 2
            total_pages = (total_changes + 99) // 100
            page.wait_for_function("total => document.querySelector('.preview-diff-page-info')?.textContent.includes('/ ' + total + ' 处')",
                                   arg=total_changes, timeout=15000)
            check(page.locator(".preview-diff-table tr").count() == 101,
                  "large diff UI renders only the first 100 changes with the full total")
            page.locator('.preview-diff-pager .btn-mini:has-text("末页")').click()
            page.wait_for_function("pages => document.querySelector('.preview-diff-page-info')?.textContent.includes('第 ' + pages + '/' + pages + ' 页')",
                                   arg=total_pages, timeout=15000)
            check(page.locator(".preview-diff-table tr").last.locator("td").first.inner_text() == str(ROWS),
                  "large diff UI can jump directly to the final changed cell")
            page.click("#modal-close")
            page.click("#btn-apply")
            page.wait_for_selector("#preview-bar", state="hidden")
            check(first_name(page) == "User 0", "large preview can be committed")
            page.click("#btn-undo")
            check(first_name(page) == " User 0 ", "undo restores the large committed import")
            heartbeat = page.evaluate("""() => {
              clearInterval(window.__heartbeatTimer); return window.__heartbeat;
            }""")
            max_gap = round(heartbeat["maxGap"])
            worst_gap = max(max_gap, import_heartbeat["maxGap"], preview_heartbeat["maxGap"])
            check(worst_gap < 1000, f"main-thread heartbeat stays below 1000 ms (measured {round(worst_gap)} ms)")
            print(f"  INFO  import+profile {import_ms} ms (max gap {round(import_heartbeat['maxGap'])} ms); "
                  f"preview {preview_ms} ms (max gap {round(preview_heartbeat['maxGap'])} ms); "
                  f"diff+apply+undo max gap {max_gap} ms; ticks {heartbeat['ticks']}")

            cancel_page = browser.new_page()
            watch(cancel_page)
            cancel_page.goto(PAGE_URL, wait_until="load")
            cancel_page.set_input_files("#file-input", str(large_path))
            visible = cancel_page.locator("#btn-cancel-task").is_visible()
            if visible:
                cancel_page.evaluate("document.querySelector('#btn-cancel-task').click()")
            cancel_page.wait_for_timeout(400)
            check(visible and "示例数据.csv" in cancel_page.locator("#file-info").inner_text(),
                  "cancelling import preserves the previous table")

            cancel_page.set_input_files("#file-input", str(large_path))
            cancel_page.set_input_files("#file-input", {
                "name": "new-small.csv", "mimeType": "text/csv", "buffer": "A,B\nnew,ok".encode(),
            })
            cancel_page.wait_for_function("() => document.querySelector('#file-info').textContent.includes('new-small.csv')")
            cancel_page.wait_for_timeout(500)
            check("new-small.csv · 1 行" in cancel_page.locator("#file-info").inner_text(),
                  "a newer import supersedes an older large import")

            fallback = browser.new_page()
            watch(fallback)
            fallback.add_init_script("Object.defineProperty(window, 'Worker', { value: undefined, configurable: true });")
            fallback.goto(PAGE_URL, wait_until="load")
            modes = fallback.evaluate("""async () => {
              const parsedJob = DCWorker.run('parseCSV', { text: 'A,B\\n x ,N/A', delimiter: ',' });
              const parsed = await parsedJob.promise;
              const pipelineJob = DCWorker.run('pipeline', {
                activeRules: [{ ruleId: 'text', opts: { trim: true } }],
                headers: parsed.headers, rows: parsed.rows,
              });
              const cleaned = await pipelineJob.promise;
              const profileJob = DCWorker.run('profile', { headers: cleaned.headers, rows: cleaned.rows });
              const profile = await profileJob.promise;
              const xlsxBuild = DCWorker.run('buildXLSX', { headers: cleaned.headers, rows: cleaned.rows });
              const xlsxBlob = await xlsxBuild.promise;
              const xlsxParse = DCWorker.run('parseXLSX', { buffer: await xlsxBlob.arrayBuffer() });
              const workbook = await xlsxParse.promise;
              const csvBuild = DCWorker.run('buildCSV', { headers: cleaned.headers, rows: cleaned.rows });
              const csvText = await (await csvBuild.promise).text();
              const diffJob = DCWorker.run('diff', { result: cleaned, offset: 0, limit: 100 });
              const diff = await diffJob.promise;
              return { modes: [parsedJob.mode, pipelineJob.mode, profileJob.mode,
                  xlsxBuild.mode, xlsxParse.mode, csvBuild.mode, diffJob.mode],
                value: cleaned.rows[0][0], rows: profile.summary.rows,
                xlsxValue: workbook.sheets[0].rows[0][0], csvValue: csvText.includes('x'),
                affected: cleaned.affectedColumns.join(','), diffValue: diff.entries[0].after,
                xlsxBytes: Array.from(new Uint8Array(await xlsxBlob.arrayBuffer())) };
            }""")
            fallback.set_input_files("#file-input", {
                "name": "fallback.csv", "mimeType": "text/csv", "buffer": "A,B\n z ,1".encode(),
            })
            fallback.wait_for_function("() => document.querySelector('#file-info').textContent.includes('fallback.csv')")
            check(modes["modes"] == ["fallback"] * 7 and modes["value"] == "x" and modes["rows"] == 1
                  and modes["xlsxValue"] == "x" and modes["csvValue"] and modes["diffValue"] == "x"
                  and modes["affected"] == "0" and first_name(fallback) == " z ",
                  "no-Worker compatibility covers CSV/XLSX IO, cleaning, profile, export and diff")
            fallback.set_input_files("#file-input", {
                "name": "xlsx-fallback.xlsx",
                "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "buffer": bytes(modes["xlsxBytes"]),
            })
            fallback.wait_for_function("() => document.querySelector('#file-info').textContent.includes('xlsx-fallback.xlsx')")
            check("1 行 × 2 列" in fallback.locator("#file-info").inner_text()
                  and first_name(fallback) == "x",
                  "no-Worker real XLSX file input completes through the UI")
        finally:
            browser.close()
            temporary.cleanup()

    check(not errors, "zero JavaScript page errors and zero browser console errors")
    if errors:
        print("\n".join(errors))
    print("=" * 60)
    print(f"RESULT: {passed} passed, {failed} failed")
    print("=" * 60)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
