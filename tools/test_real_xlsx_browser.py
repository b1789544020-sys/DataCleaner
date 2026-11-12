"""Real openpyxl import/export through file://, including a 20,000-row Worker heartbeat check."""
from datetime import datetime
from pathlib import Path
import sys
import tempfile
import zipfile

from openpyxl import Workbook, load_workbook
from playwright.sync_api import sync_playwright

BASE = Path(__file__).resolve().parents[1]


def make_workbook(path):
    source = path / 'openpyxl-source.xlsx'
    wb = Workbook()
    ws = wb.active
    ws.title = 'RealData'
    ws.append(['When', 'Amount', 'Code'])
    ws.append([datetime(2024, 2, 29), 12.5, '007'])
    ws['A2'].number_format = 'yyyy-mm-dd hh:mm'
    wb.save(source)

    # Force the absolute Target form used by real-world producers. The parser must
    # resolve it from the ZIP root, not by blindly prefixing xl/.
    with zipfile.ZipFile(source) as zin, zipfile.ZipFile(path / 'real-absolute.xlsx', 'w', zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            if info.filename == 'xl/_rels/workbook.xml.rels':
                text = data.decode('utf-8').replace('Target="xl/', 'Target="/xl/')
                data = text.encode('utf-8')
            zout.writestr(info, data)
    return path / 'real-absolute.xlsx'


def make_large_workbook(path, rows=20000):
    target = path / 'large-worker.xlsx'
    wb = Workbook(write_only=True)
    ws = wb.create_sheet('LargeData')
    ws.append(['Name', 'Amount', 'Code', 'Department'])
    for index in range(rows):
        ws.append(['用户' + str(index), index + 0.5, '007', ' Dept ' + str(index % 8) + ' '])
    wb.save(target)
    return target, rows


def main():
    errors = []
    with tempfile.TemporaryDirectory(prefix='dc-real-xlsx-') as tmp:
        fixture = make_workbook(Path(tmp))
        large_fixture, large_rows = make_large_workbook(Path(tmp))
        with zipfile.ZipFile(fixture) as archive:
            rels = archive.read('xl/_rels/workbook.xml.rels').decode('utf-8')
            assert 'Target="/xl/worksheets/sheet1.xml"' in rels
            assert archive.testzip() is None
        print('PASS real workbook has absolute workbook relationships')

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
            page = browser.new_page()
            page.on('pageerror', lambda exc: errors.append(str(exc)))
            page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
            page.goto((BASE / 'index.html').as_uri())
            page.evaluate("""() => {
              const run = DCWorker.run; window.__xlsxJobs = [];
              DCWorker.run = (...args) => {
                const job = run(...args); window.__xlsxJobs.push(job); return job;
              };
            }""")
            page.set_input_files('#file-input', str(fixture))
            page.wait_for_function("document.querySelector('#file-info').textContent.includes('real-absolute.xlsx')")
            text = page.locator('#table-wrap').inner_text()
            assert '2024-02-29' in text, text
            print('PASS custom openpyxl date format becomes 2024-02-29')
            assert '12.5' in text and '007' in text, text
            print('PASS numeric and leading-zero values survive import')
            assert page.evaluate("window.__xlsxJobs.find(job => job.kind === 'parseXLSX').mode") == 'worker'
            print('PASS real openpyxl workbook is parsed in a Worker')

            page.evaluate("""() => {
              window.__xlsxHeartbeat = { last: performance.now(), maxGap: 0 };
              window.__xlsxTimer = setInterval(() => {
                const now = performance.now(), heartbeat = window.__xlsxHeartbeat;
                heartbeat.maxGap = Math.max(heartbeat.maxGap, now - heartbeat.last);
                heartbeat.last = now;
              }, 25);
            }""")
            page.set_input_files('#file-input', str(large_fixture))
            page.wait_for_function("name => document.querySelector('#file-info').textContent.includes(name)",
                                   arg='large-worker.xlsx', timeout=60000)
            page.locator('.pager .btn-mini:has-text("末页")').click()
            large_text = page.locator('#table-wrap').inner_text()
            assert f'{large_rows} 行' in page.locator('#file-info').inner_text()
            assert '用户19999' in large_text, large_text
            import_gap = page.evaluate('window.__xlsxHeartbeat.maxGap')
            print(f'PASS {large_rows} real XLSX rows import in a Worker and reach the last page ({import_gap:.0f} ms max gap)')

            page.evaluate('window.__xlsxHeartbeat.maxGap = 0; window.__xlsxHeartbeat.last = performance.now()')
            exported = Path(tmp) / 'large-exported.xlsx'
            with page.expect_download(timeout=60000) as download_info:
                page.click('#btn-export-xlsx')
            download_info.value.save_as(str(exported))
            export_gap = page.evaluate('window.__xlsxHeartbeat.maxGap')
            export_mode = page.evaluate("window.__xlsxJobs.find(job => job.kind === 'buildXLSX').mode")
            with zipfile.ZipFile(exported) as archive:
                assert archive.testzip() is None
            check_wb = load_workbook(exported, read_only=True, data_only=True)
            check_ws = check_wb.active
            last_row = None
            for row in check_ws.iter_rows(values_only=True):
                last_row = row
            check_wb.close()
            assert export_mode == 'worker' and last_row[0] == '用户19999' and last_row[2] == '007'
            print(f'PASS {large_rows} rows export in a Worker and openpyxl reads them back ({export_gap:.0f} ms max gap)')
            page.evaluate('clearInterval(window.__xlsxTimer)')
            assert max(import_gap, export_gap) < 1000, (import_gap, export_gap)
            print(f'PASS XLSX import/export heartbeat stays below 1000 ms ({max(import_gap, export_gap):.0f} ms)')
            browser.close()
    assert not errors, errors
    print('PASS zero JavaScript errors')
    print('RESULT: 8 passed, 0 failed')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        print('FAIL:', exc, file=sys.stderr)
        sys.exit(1)
