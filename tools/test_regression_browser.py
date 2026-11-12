"""Data-safety/audit regressions. Runs through file:// without a server or network."""
from pathlib import Path
import sys
import tempfile
from playwright.sync_api import sync_playwright

BASE = Path(__file__).resolve().parents[1]
PAGE_URL = (BASE / "index.html").as_uri()

ENGINE_SUITE = r"""
() => {
  const R = window.DCRules, AI = window.DCAI, IO = window.DCIO;
  const out = [];
  function assert(ok, message) { if (!ok) throw new Error(message || 'assertion'); }
  function test(name, fn) {
    try { fn(); out.push({ ok: true, name }); }
    catch (e) { out.push({ ok: false, name, error: e.message }); }
  }
  const runAI = (type, opts, headers, rows) => R.runPipeline([
    { ruleId: 'ai', enabled: true, opts: { steps: [Object.assign({ type }, opts)] } },
  ], headers, rows);

  test('strict date accepts a real leap day', () => {
    assert(R.normalizeDate('2024/2/29') === '2024-02-29');
  });
  test('strict date rejects normalized overflow', () => {
    assert(R.normalizeDate('2024/2/30') === '2024/2/30');
    assert(R.parseDateParts('2023/2/29') === null);
    assert(R.parseDateParts('2024/13/1') === null);
    assert(R.parseDateParts('05/06/2024').y === 2024);
    assert(R.normalizeDate('13/01/2024') === '2024-01-13');
  });
  test('built-in date rule retains invalid values and logs them', () => {
    const result = R.runPipeline([{ ruleId: 'date', opts: { targets: ['Date'] } }],
      ['Date'], [['2024/2/30'], ['2024/1/2']]);
    assert(result.rows[0][0] === '2024/2/30');
    assert(result.rows[1][0] === '2024-01-02');
    assert(result.log.join('\n').includes('保留 1 个无效日期'));
  });
  test('AI date rule uses the same strict parser', () => {
    const result = runAI('normalize_date', { column: 'Date' }, ['Date'], [['2024/2/30']]);
    assert(result.rows[0][0] === '2024/2/30');
    assert(result.log.join('\n').includes('无效日期'));
  });
  test('single-column prose is not split on commas or semicolons', () => {
    const csv = 'Text\nhello, world\na;b\nplain';
    assert(IO.sniffDelimiter(csv) === '');
    const table = IO.parseCSV(csv);
    assert(table.headers.length === 1);
    assert(table.rows[0][0] === 'hello, world');
    assert(table.rows[1][0] === 'a;b');
  });
  test('multi-row delimiter detection still detects CSV/TSV/semicolon', () => {
    assert(IO.sniffDelimiter('a,b\n1,2\n3,4') === ',');
    assert(IO.sniffDelimiter('a\tb\n1\t2\n3\t4') === '\t');
    assert(IO.sniffDelimiter('a;b\n1;2\n3;4') === ';');
  });
  test('ragged CSV preserves extra fields and reports every irregular row', () => {
    const table = IO.parseCSV('a,b\n1,2,3\n4,5', ',');
    assert(table.headers.length === 3 && table.headers[2] === '列3');
    assert(table.rows[0][2] === '3');
    assert(table.rows[1].length === 3 && table.rows[1][2] === '');
    assert(table.stats.irregularRows.length === 2);
    assert(table.stats.extendedColumns === 1);
  });
  test('manual single-column override is honored', () => {
    const table = IO.parseCSV('A,B\n1,2', '');
    assert(table.headers[0] === 'A,B' && table.rows[0][0] === '1,2');
  });
  test('pipeline never mutates caller input', () => {
    const headers = ['Name'], rows = [['  A  ']];
    const result = R.runPipeline([{ ruleId: 'text', opts: { trim: true } }], headers, rows);
    assert(rows[0][0] === '  A  ' && result.rows[0][0] === 'A');
  });
  test('repeated split from the same source is identical', () => {
    const rules = [{ ruleId: 'split', opts: { column: 'Name', sep: ',', maxParts: 3 } }];
    const source = () => [['Doe, John'], ['Smith, Jane']];
    const first = R.runPipeline(rules, ['Name'], source());
    const second = R.runPipeline(rules, ['Name'], source());
    assert(JSON.stringify(first.headers) === JSON.stringify(second.headers));
    assert(JSON.stringify(first.rows) === JSON.stringify(second.rows));
  });
  test('arithmetic parser supports precedence, parentheses and unary signs', () => {
    const result = runAI('custom_formula', { column: 'Total', formula: 'col:0 * (2 + 1) - -2' },
      ['Total', 'Other'], [[5, 0]]);
    assert(result.rows[0][0] === 17);
  });
  test('formula cannot execute browser JavaScript', () => {
    window.__formulaAlert = 0;
    let rejected = false;
    try { runAI('custom_formula', { column: 'A', formula: 'globalThis.alert(1)' }, ['A'], [[1]]); }
    catch (e) { rejected = true; }
    assert(rejected && window.__formulaAlert === 0);
  });
  test('formula rejects property access, unknown identifiers and bad columns', () => {
    ['col:0.constructor', 'Math.max(1,2)', 'col:99 + 1'].forEach(formula => {
      let rejected = false;
      try { R.compileArithmetic(formula, 2); } catch (e) { rejected = true; }
      assert(rejected, formula);
    });
  });
  test('formula skips non-finite results', () => {
    const result = runAI('custom_formula', { column: 'A', formula: '1 / col:1' }, ['A', 'B'], [[7, 0]]);
    assert(result.rows[0][0] === 7);
  });
  test('AI parser rejects unknown types with a visible error', () => {
    const parsed = AI.parseAIResponse(JSON.stringify({ steps: [{ type: 'drop_database', column: 'A' }] }), ['A']);
    assert(parsed.steps.length === 0 && parsed.errors.length === 1);
  });
  test('AI parser validates enum and formula parameters', () => {
    let parsed = AI.parseAIResponse(JSON.stringify({ steps: [
      { type: 'normalize_date', column: 'A', target_format: 'anything' },
      { type: 'custom_formula', column: 'A', formula: 'globalThis.alert(1)' },
    ] }), ['A']);
    assert(parsed.steps.length === 0 && parsed.errors.length === 2);
    parsed = AI.parseAIResponse(JSON.stringify({ steps: [{ type: 'trim_whitespace', column: 'A' }] }), ['A']);
    assert(parsed.steps.length === 1 && parsed.errors.length === 0);
  });
  test('quality reports duplicate-only data', () => {
    const profile = R.profileData(['A'], [['x'], ['x'], ['x']]);
    assert(profile.summary.duplicateRows === 2);
    assert(profile.issues.filter(i => i.type === 'duplicates').length === 1);
  });
  test('quality reports invalid dates with data row numbers', () => {
    const profile = R.profileData(['Date'], [['2024/1/1'], ['2024/2/30']]);
    const issue = profile.issues.find(i => i.type === 'invalid_date');
    assert(issue && issue.count === 1 && issue.rows[0] === 2);
  });
  test('quality distinguishes date order even with one separator', () => {
    const issues = R.analyzeQuality(['Date'], [['05/06/2024'], ['13/01/2024']]);
    assert(issues.some(i => i.type === 'date_inconsistent'));
  });
  test('quality reports email and phone format errors', () => {
    const issues = R.analyzeQuality(['Email', '手机号'], [['bad', '13812345678'], ['a@b.com', '123']]);
    assert(issues.some(i => i.type === 'invalid_email'));
    assert(issues.some(i => i.type === 'invalid_phone'));
  });
  test('column profile includes numeric type, missing rate and unique count', () => {
    const profile = R.profileData(['Amount'], [[1], [''], [3], [3]]);
    const col = profile.columns[0];
    assert(col.type === 'number' && col.missingCount === 1 && col.uniqueCount === 2);
    const missing = profile.issues.find(i => i.type === 'missing');
    assert(missing && missing.columnType === 'number');
  });
  test('preset serializer is versioned and remains backward readable', () => {
    const text = IO.serializePresets([{ name: 'p', version: 2, rules: [] }]);
    assert(JSON.parse(text).v === 2);
    assert(IO.deserializePresets(JSON.stringify({ v: 1, presets: [{ name: 'old', rules: [] }] })).length === 1);
  });
  return out;
}
"""

def main():
    passed = failed = 0
    js_errors, console_errors = [], []

    def check(ok, name, detail=''):
        nonlocal passed, failed
        if ok:
            passed += 1
            print('  PASS ' + name)
        else:
            failed += 1
            print('  FAIL ' + name + (': ' + str(detail) if detail else ''))

    with tempfile.TemporaryDirectory(prefix='dc-regression-') as tmp:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
            page = browser.new_page(accept_downloads=True)
            page.on('pageerror', lambda exc: js_errors.append(str(exc)))
            page.on('console', lambda msg: console_errors.append(msg.text) if msg.type == 'error' else None)
            page.goto(PAGE_URL)
            page.wait_for_selector('#table-wrap tbody tr')
            print('=' * 60 + '\nEngine regressions (file://)\n' + '=' * 60)
            for result in page.evaluate(ENGINE_SUITE):
                check(result['ok'], result['name'], result.get('error', ''))

            def ui(name, fn):
                try:
                    fn()
                    check(True, name)
                except Exception as exc:
                    check(False, name, exc)

            def reset_sample():
                page.goto(PAGE_URL)
                page.wait_for_selector('#table-wrap tbody tr')

            def import_text(name, text, delimiter='auto'):
                page.select_option('#csv-delimiter', delimiter)
                page.set_input_files('#file-input', {
                    'name': name, 'mimeType': 'text/csv', 'buffer': text.encode('utf-8'),
                })
                page.wait_for_function("name => document.querySelector('#file-info').textContent.includes(name)", arg=name)

            print('=' * 60 + '\nUI regressions: preview/import/presets/report\n' + '=' * 60)

            def preview_apply_undo():
                reset_sample()
                assert page.locator('#preview-bar').is_hidden()
                page.click('#btn-run')
                page.wait_for_selector('#preview-bar:not([hidden])')
                page.click('#btn-preview-diff')
                page.wait_for_selector('#modal.open')
                assert '清洗前后差异' in page.locator('#modal-body').inner_text()
                page.click('#modal-close')
                page.click('#btn-apply')
                assert page.locator('#preview-bar').is_hidden()
                page.click('#btn-undo')
                assert '13812345678' in page.locator('#table-wrap').inner_text()
            ui('preview -> diff -> apply -> undo', preview_apply_undo)

            def no_preview_export():
                reset_sample()
                downloads = []
                page.on('download', lambda download: downloads.append(download))
                page.click('#btn-run')
                page.wait_for_selector('#preview-bar:not([hidden])')
                page.click('#btn-export')
                page.wait_for_timeout(350)
                assert not downloads
                assert '请先应用或取消' in page.locator('.toast').last.inner_text()
            ui('uncommitted preview cannot be exported as cleaned data', no_preview_export)

            def single_column_ui():
                reset_sample()
                import_text('single.csv', 'Text\nhello, world\na;b\nplain')
                body = page.locator('#table-wrap').inner_text()
                assert 'hello, world' in body and 'a;b' in body
                assert page.locator('#table-wrap thead th').count() == 2
            ui('single-column CSV survives real file import', single_column_ui)

            def manual_delimiter_ui():
                reset_sample()
                import_text('manual.csv', 'A,B\n1,2', 'single')
                assert 'A,B' in page.locator('#table-wrap thead').inner_text()
                assert '1,2' in page.locator('#table-wrap tbody').inner_text()
            ui('manual delimiter override works through UI', manual_delimiter_ui)

            def ragged_ui():
                reset_sample()
                import_text('ragged.csv', 'a,b\n1,2,3\n4,5')
                assert '列3' in page.locator('#table-wrap thead').inner_text()
                assert '3' in page.locator('#table-wrap tbody tr').first.inner_text()
                assert '列数异常' in page.locator('.toast').last.inner_text()
            ui('ragged import reports anomalies and retains extra field', ragged_ui)

            def repeated_split_ui():
                reset_sample()
                import_text('split.csv', 'Name\nDoe, John\nSmith, Jane')
                card = page.locator('.rule-card').filter(has_text='拆分列')
                card.locator('button').first.click()
                card.get_by_text('配置', exact=False).click()
                page.locator('#modal-body select').select_option(label='Name')
                page.locator('#modal-body input').first.fill(',')
                page.get_by_role('button', name='完成', exact=True).click()
                page.click('#btn-run')
                page.wait_for_selector('#preview-bar:not([hidden])')
                headers = page.locator('#table-wrap thead th').all_inner_texts()
                assert headers == ['#', 'Name_1', 'Name_2', 'Name_3'], headers
                first_table = page.locator('#table-wrap').inner_text()
                page.click('#btn-apply')
                page.click('#btn-run')
                page.wait_for_selector('#preview-bar:not([hidden])')
                assert page.locator('#table-wrap').inner_text() == first_table
            ui('split remains idempotent after apply and rerun', repeated_split_ui)

            def saved_ai_preset():
                reset_sample()
                preset = {'v': 2, 'presets': [{'name': 'saved-ai', 'version': 2, 'headers': ['手机号'], 'rules': [
                    {'ruleId': 'ai', 'enabled': True, 'opts': {'steps': [
                        {'type': 'mask_column', 'column': '手机号', 'pattern': 'middle4'},
                    ]}},
                ]}]}
                page.evaluate("localStorage.setItem('dc_presets', JSON.stringify(" + __import__('json').dumps(preset) + "))")
                page.reload()
                page.wait_for_selector('#table-wrap tbody tr')
                page.select_option('#preset-select', 'saved-ai')
                page.click('#btn-run')
                page.wait_for_function("document.querySelector('#table-wrap').innerText.includes('138****5678')")
            ui('restored AI preset is not overwritten before execution', saved_ai_preset)

            def mapped_ai_preset():
                reset_sample()
                preset = {'v': 2, 'presets': [{'name': 'mapped-ai', 'version': 2, 'headers': ['旧手机'], 'rules': [
                    {'ruleId': 'ai', 'enabled': True, 'opts': {'steps': [
                        {'type': 'mask_column', 'column': '旧手机', 'pattern': 'middle4'},
                    ]}},
                ]}]}
                page.evaluate("localStorage.setItem('dc_presets', JSON.stringify(" + __import__('json').dumps(preset) + "))")
                page.reload()
                page.wait_for_selector('#table-wrap tbody tr')
                page.select_option('#preset-select', 'mapped-ai')
                page.wait_for_selector('#modal.open')
                assert '预设列名映射' in page.locator('#modal-body').inner_text()
                page.locator('select[data-old-column="旧手机"]').select_option(label='手机号')
                page.get_by_role('button', name='应用列映射', exact=True).click()
                page.click('#btn-run')
                page.wait_for_function("document.querySelector('#table-wrap').innerText.includes('138****5678')")
            ui('preset schema mismatch requires and applies column mapping', mapped_ai_preset)

            def preset_version_ui():
                reset_sample()
                page.click('#btn-preset-save')
                page.locator('#modal-body input').first.fill('v2-ui')
                page.get_by_role('button', name='保存', exact=True).click()
                item = page.evaluate("JSON.parse(localStorage.getItem('dc_presets')).presets.find(p => p.name === 'v2-ui')")
                assert item['version'] == 2 and len(item['headers']) == 6
            ui('UI saves versioned presets with source schema', preset_version_ui)

            def duplicate_quality_ui():
                reset_sample()
                import_text('duplicates.csv', 'A\nx\nx\nx')
                page.click('#btn-suggest')
                text = page.locator('#modal-body').inner_text()
                assert '2 行完全重复' in text and '逐列画像' in text
            ui('quality modal reports duplicates and column profiles', duplicate_quality_ui)

            def numeric_suggestion_ui():
                reset_sample()
                import_text('numeric.csv', 'Amount,Other\n1,x\n,y\n3,x')
                page.click('#btn-suggest')
                text = page.locator('#modal-body').inner_text()
                assert '用列均值填充 Amount' in text
                page.get_by_role('button', name='将安全建议加入流水线', exact=False).click()
                page.click('#btn-run')
                page.wait_for_selector('#preview-bar:not([hidden])')
                value = page.locator('#table-wrap tbody tr').nth(1).locator('td').nth(1).inner_text()
                assert value == '2', (value, page.locator('#table-wrap').inner_text(), page.locator('#rules-list').inner_text(), page.locator('#ai-log').inner_text())
            ui('numeric missing values suggest mean, not unknown text', numeric_suggestion_ui)

            def audit_report_ui():
                reset_sample()
                page.click('#btn-run')
                page.wait_for_selector('#preview-bar:not([hidden])')
                with page.expect_download() as info:
                    page.click('#btn-report')
                download = info.value
                target = Path(tmp) / download.suggested_filename
                download.save_as(str(target))
                report = target.read_text(encoding='utf-8-sig')
                assert '清洗步骤' in report and '操作日志' in report and '逐列画像' in report
                assert '预览未提交' in report
            ui('offline audit report contains steps, quality and logs', audit_report_ui)

            browser.close()

    print('=' * 60)
    print('JavaScript page errors:', len(js_errors))
    print('Console errors:', len(console_errors))
    for error in js_errors + console_errors:
        print('  ', error)
    check(not js_errors, 'zero uncaught JavaScript errors', js_errors)
    check(not console_errors, 'zero browser console errors', console_errors)
    print('RESULT: %d passed, %d failed' % (passed, failed))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
