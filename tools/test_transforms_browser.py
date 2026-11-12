"""High-frequency transformation tests, executed in Chromium through file://."""
from pathlib import Path
import sys
from html import unescape
import tempfile
from playwright.sync_api import sync_playwright

BASE = Path(__file__).resolve().parents[1]
PAGE_URL = (BASE / "index.html").as_uri()

ENGINE_SUITE = r"""
() => {
  const R = window.DCRules;
  const out = [];
  function assert(ok, message) { if (!ok) throw new Error(message || 'assertion'); }
  function test(name, fn) {
    try { fn(); out.push({ ok: true, name }); }
    catch (error) { out.push({ ok: false, name, error: error.message }); }
  }
  function run(ruleId, opts, headers, rows) {
    return R.runPipeline([{ ruleId, enabled: true, opts }], headers, rows);
  }

  test('merge keeps source columns and skips empty parts', () => {
    const result = run('merge', { columns: ['First', 'Last'], separator: ' ', newName: 'Full', keepOriginal: true },
      ['First', 'Last', 'Note'], [['John', 'Doe', 'x'], ['Jane', '', 'y']]);
    assert(JSON.stringify(result.headers) === JSON.stringify(['First', 'Last', 'Note', 'Full']));
    assert(result.rows[0][3] === 'John Doe' && result.rows[1][3] === 'Jane');
    assert(result.rows[0][0] === 'John' && result.rows[0][1] === 'Doe');
  });

  test('merge can remove sources and honors selected column order', () => {
    const result = run('merge', { columns: ['Last', 'First'], separator: ', ', newName: 'Full', keepOriginal: false },
      ['First', 'Last', 'Note'], [['John', 'Doe', 'x']]);
    assert(JSON.stringify(result.headers) === JSON.stringify(['Full', 'Note']));
    assert(JSON.stringify(result.rows[0]) === JSON.stringify(['Doe, John', 'x']));
  });

  test('merge never overwrites a colliding output header', () => {
    const result = run('merge', { columns: ['A', 'B'], newName: 'Full', keepOriginal: true },
      ['A', 'B', 'Full', 'Full_2'], [['a', 'b', 'old', 'older']]);
    assert(result.headers[4] === 'Full_3' && result.rows[0][2] === 'old');
  });

  test('merge with fewer than two columns is a safe no-op', () => {
    const result = run('merge', { columns: ['A'] }, ['A', 'B'], [['a', 'b']]);
    assert(result.rows[0].length === 2 && result.headers.length === 2);
    assert(result.log.join('\n').includes('跳过'));
  });

  test('missing markers normalize exact targeted cells only', () => {
    const result = run('missing', { tokens: ['N/A', 'NULL', '-'], targets: ['A'], replacement: '' },
      ['A', 'B'], [[' N/A ', 'N/A text'], ['null', 'NULL'], ['ok', '-']]);
    assert(result.rows[0][0] === '' && result.rows[1][0] === '');
    assert(result.rows[0][1] === 'N/A text' && result.rows[1][1] === 'NULL' && result.rows[2][1] === '-');
    assert(result.changed.size === 2);
  });

  test('missing markers can replace tokens and real blanks together', () => {
    const result = run('missing', { tokens: ['N/A'], replacement: '未知', includeBlank: true },
      ['A'], [[''], ['N/A'], ['ok']]);
    assert(result.rows[0][0] === '未知' && result.rows[1][0] === '未知' && result.rows[2][0] === 'ok');
  });

  test('missing marker case sensitivity is explicit', () => {
    const result = run('missing', { tokens: ['N/A'], caseSensitive: true }, ['A'], [['n/a'], ['N/A']]);
    assert(result.rows[0][0] === 'n/a' && result.rows[1][0] === '');
  });

  test('missing rule without markers is a safe no-op', () => {
    const result = run('missing', { tokens: [], includeBlank: false, replacement: 'x' }, ['A'], [['']]);
    assert(result.rows[0][0] === '' && result.changed.size === 0);
  });

  test('conditional replacement is case-insensitive by default and target-only', () => {
    const result = run('conditional', {
      column: 'Status', targetColumn: 'Note', operator: 'equals', value: 'active', replaceWith: 'done',
    }, ['Status', 'Note'], [['active', 'x'], ['ACTIVE', 'y'], ['inactive', 'z']]);
    assert(result.rows[0][1] === 'done' && result.rows[1][1] === 'done' && result.rows[2][1] === 'z');
    assert(result.rows[0][0] === 'active' && result.changed.size === 2);
  });

  test('conditional numeric comparison rejects partial numbers', () => {
    const result = run('conditional', {
      column: 'Amount', targetColumn: 'Flag', operator: 'gt', value: '10', replaceWith: 'ok',
    }, ['Amount', 'Flag'], [[10, 'a'], ['12abc', 'b'], ['1,200', 'c'], ['', 'd']]);
    assert(result.rows[0][1] === 'a' && result.rows[1][1] === 'b');
    assert(result.rows[2][1] === 'ok' && result.rows[3][1] === 'd');
  });

  test('conditional empty operator supports explicit replacement', () => {
    const result = run('conditional', {
      column: 'Note', targetColumn: 'Note', operator: 'empty', replaceWith: 'Missing',
    }, ['Note'], [[''], ['   '], [null], ['ok']]);
    assert(result.rows[0][0] === 'Missing' && result.rows[1][0] === 'Missing');
    assert(result.rows[2][0] === 'Missing' && result.rows[3][0] === 'ok');
  });

  test('conditional replacement can explicitly clear a target', () => {
    const result = run('conditional', {
      column: 'Status', targetColumn: 'Note', operator: 'equals', value: 'bad', replaceWith: '',
    }, ['Status', 'Note'], [['bad', 'remove'], ['good', 'keep']]);
    assert(result.rows[0][1] === '' && result.rows[1][1] === 'keep');
  });

  test('incomplete or invalid conditional configuration is a no-op', () => {
    let result = run('conditional', { column: 'A', targetColumn: 'B', operator: 'equals', value: '' },
      ['A', 'B'], [['', 'keep']]);
    assert(result.rows[0][1] === 'keep' && result.changed.size === 0);
    result = run('conditional', { column: 'A', targetColumn: 'B', operator: 'gt', value: 'abc', replaceWith: 'x' },
      ['A', 'B'], [[100, 'keep']]);
    assert(result.rows[0][1] === 'keep' && result.changed.size === 0);
  });

  test('filter keep mode keeps matches and logs removed source rows', () => {
    const result = run('filter', { column: 'Status', operator: 'contains', value: 'active', action: 'keep' },
      ['Status', 'Note'], [['active', 'a'], ['inactive', 'b'], ['done', 'c']]);
    assert(JSON.stringify(result.rows) === JSON.stringify([['active', 'a'], ['inactive', 'b']]));
    assert(result.removed.size === 1 && result.log.join('\n').includes('原数据行 3'));
  });

  test('filter numeric comparison supports thousand separators and strict values', () => {
    const result = run('filter', { column: 'Amount', operator: 'gt', value: '100', action: 'keep' },
      ['Amount'], [[101], ['1,200'], ['100abc'], ['abc'], ['']]);
    assert(result.rows.length === 2 && result.rows[0][0] === 101 && result.rows[1][0] === '1,200');
    assert(result.removed.size === 3);
  });

  test('filter remove and empty/not-empty operators are available', () => {
    let result = run('filter', { column: 'A', operator: 'empty', action: 'remove' },
      ['A'], [[''], [' '], [null], ['ok']]);
    assert(result.rows.length === 1 && result.rows[0][0] === 'ok' && result.removed.size === 3);
    result = run('filter', { column: 'A', operator: 'not_empty', action: 'keep' }, ['A'], [[''], ['ok']]);
    assert(result.rows.length === 1 && result.rows[0][0] === 'ok');
  });

  test('filter case sensitivity can be enabled', () => {
    const result = run('filter', { column: 'A', operator: 'equals', value: 'abc', action: 'keep', caseSensitive: true },
      ['A'], [['abc'], ['ABC']]);
    assert(result.rows.length === 1 && result.rows[0][0] === 'abc');
  });

  test('invalid filter value cannot delete the entire table', () => {
    let result = run('filter', { column: 'A', operator: 'gt', value: 'abc', action: 'keep' },
      ['A'], [[1], [2]]);
    assert(result.rows.length === 2 && result.removed.size === 0 && result.log.join('\n').includes('跳过'));
    result = run('filter', { column: 'A', operator: 'equals', value: '', action: 'remove' },
      ['A'], [[''], ['ok']]);
    assert(result.rows.length === 2 && result.removed.size === 0);
  });

  test('transformations do not mutate source and can be chained', () => {
    const headers = ['Status', 'First', 'Last'];
    const rows = [['active', 'John', 'Doe'], ['inactive', 'Jane', 'N/A']];
    const result = R.runPipeline([
      { ruleId: 'missing', opts: { tokens: ['N/A'] } },
      { ruleId: 'merge', opts: { columns: ['First', 'Last'], separator: ' ', newName: 'Name' } },
      { ruleId: 'conditional', opts: { column: 'Status', targetColumn: 'Name', operator: 'equals', value: 'active', replaceWith: 'J. Doe' } },
      { ruleId: 'filter', opts: { column: 'Status', operator: 'equals', value: 'active', action: 'keep' } },
    ], headers, rows);
    assert(rows[0][0] === 'active' && rows[1][2] === 'N/A');
    assert(result.rows.length === 1 && result.rows[0][3] === 'J. Doe');
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

    with tempfile.TemporaryDirectory(prefix='dc-transforms-') as tmp:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=['--no-sandbox'], downloads_path=tmp)
            context = browser.new_context(accept_downloads=True)
            page = context.new_page()
            page.set_default_timeout(4000)
            page.on('pageerror', lambda exc: js_errors.append(str(exc)))
            page.on('console', lambda msg: console_errors.append(msg.text) if msg.type == 'error' else None)
            page.goto(PAGE_URL)
            page.wait_for_selector('#table-wrap tbody tr')
            print('=' * 60 + '\nTransformation engine tests (file://)\n' + '=' * 60)
            for result in page.evaluate(ENGINE_SUITE):
                check(result['ok'], result['name'], result.get('error', ''))

            def ui(name, fn):
                try:
                    fn()
                    check(True, name)
                except Exception as exc:
                    check(False, name, exc)

            def import_text(name, text):
                page.goto(PAGE_URL)
                page.wait_for_selector('#table-wrap tbody tr')
                page.select_option('#csv-delimiter', 'auto')
                page.set_input_files('#file-input', {
                    'name': name, 'mimeType': 'text/csv', 'buffer': text.encode('utf-8'),
                })
                page.wait_for_function("name => document.querySelector('#file-info').textContent.includes(name)", arg=name)

            def open_config(rule_id):
                card = page.locator(".rule-card[data-rule='" + rule_id + "']")
                if '已启用' not in card.locator('button').first.inner_text():
                    card.locator('button').first.click()
                card.get_by_text('配置', exact=False).click()
                page.wait_for_selector('#modal.open')

            def table_rows():
                return page.evaluate("""() => [...document.querySelectorAll('#table-wrap tbody tr')].map(
                  row => [...row.querySelectorAll('td')].slice(1).map(cell => cell.textContent))""")

            print('=' * 60 + '\nTransformation UI/preset/audit tests\n' + '=' * 60)

            def merge_and_missing_ui():
                import_text('merge.csv', 'First,Last,Note,Full\nJohn,Doe,x,old\nJane,,y,older')
                open_config('merge')
                labels = page.locator('#modal-body label')
                labels.filter(has_text='First').locator('input[type=checkbox]').check()
                labels.filter(has_text='Last').locator('input[type=checkbox]').check()
                page.fill("[data-config='separator']", ' ')
                page.fill("[data-config='newName']", 'Full')
                page.check("[data-config='keepOriginal']")
                page.get_by_role('button', name='完成', exact=True).click()
                page.click('#btn-run')
                page.wait_for_selector('#preview-bar:not([hidden])')
                rows = table_rows()
                assert rows[0][:4] == ['John', 'Doe', 'x', 'old'], rows
                assert rows[0][4] == 'John Doe' and rows[1][4] == 'Jane', rows
                assert 'Full_2' in page.locator('#table-wrap thead').inner_text()
                assert not page.locator('#btn-apply').is_disabled()
                page.click('#btn-cancel-preview')
                page.wait_for_selector('#preview-bar', state='hidden')
                assert table_rows()[0][0] == 'John' and table_rows()[0].count('John Doe') == 0
                page.click('#btn-preset-save')
                page.fill('#modal-body .text-input', '合并列预设')
                page.locator('#modal-body .btn.primary').click()
                page.wait_for_selector('#modal', state='hidden')
                page.select_option('#csv-delimiter', 'auto')
                page.set_input_files('#file-input', {
                    'name': 'renamed.csv', 'mimeType': 'text/csv',
                    'buffer': '名,姓,备注\n张,三,x'.encode('utf-8'),
                })
                page.wait_for_function("() => document.querySelector('#file-info').textContent.includes('renamed.csv')")
                page.select_option('#preset-select', '合并列预设')
                page.wait_for_selector('#modal.open')
                selects = page.locator('[data-old-column]')
                assert selects.count() == 2, selects.count()
                page.select_option("[data-old-column='First']", '名')
                page.select_option("[data-old-column='Last']", '姓')
                page.get_by_role('button', name='应用列映射', exact=True).click()
                page.wait_for_selector('#modal', state='hidden')
                page.click('#btn-run')
                page.wait_for_selector('#preview-bar:not([hidden])')
                rows = table_rows()
                assert rows[0][3] == '张 三', rows

            ui('merge UI, collision, preview cancel and preset column mapping', merge_and_missing_ui)

            def missing_ui():
                import_text('missing.csv', 'A,B\n N/A ,N/A text\nNULL,ok')
                open_config('missing')
                page.fill("[data-config='tokens']", 'N/A\nNULL')
                labels = page.locator('#modal-body label')
                labels.filter(has_text=' A').locator('input[type=checkbox]').check()
                page.get_by_role('button', name='完成', exact=True).click()
                page.click('#btn-run')
                page.wait_for_selector('#preview-bar:not([hidden])')
                rows = table_rows()
                assert rows[0][0] == '' and rows[1][0] == '', rows
                assert rows[0][1] == 'N/A text' and rows[1][1] == 'ok', rows
                assert '修改 2 个单元格' in page.locator('#preview-summary').inner_text()

            ui('missing-marker UI replaces exact selected cells only', missing_ui)

            def conditional_and_filter_ui():
                import_text('conditional.csv', 'Status,Note,Amount\nactive,x,101\nINACTIVE,y,100\nbad,z,100abc')
                open_config('conditional')
                page.select_option("[data-config='column']", 'Status')
                page.select_option("[data-config='targetColumn']", 'Note')
                page.select_option("[data-config='operator']", 'equals')
                page.fill("[data-config='value']", 'active')
                page.fill("[data-config='replaceWith']", 'reviewed')
                page.get_by_role('button', name='完成', exact=True).click()
                page.click('#btn-run')
                page.wait_for_selector('#preview-bar:not([hidden])')
                rows = table_rows()
                assert rows[0][0] == 'active' and rows[0][1] == 'reviewed', rows
                assert rows[1][1] == 'y' and rows[2][1] == 'z', rows
                page.click('#btn-apply')
                page.wait_for_selector('#preview-bar', state='hidden')
                assert table_rows()[0][1] == 'reviewed'
                page.click('#btn-undo')
                page.wait_for_timeout(100)
                assert table_rows()[0][1] == 'x'

                open_config('filter')
                page.select_option("[data-config='column']", 'Amount')
                page.select_option("[data-config='operator']", 'gt')
                page.fill("[data-config='value']", '100')
                page.select_option("[data-config='action']", 'keep')
                page.get_by_role('button', name='完成', exact=True).click()
                page.click('#btn-run')
                page.wait_for_selector('#preview-bar:not([hidden])')
                rows = table_rows()
                assert len(rows) == 1 and rows[0][2] == '101', rows
                assert '删除 2 行' in page.locator('#preview-summary').inner_text()
                page.click('#btn-preview-diff')
                log = page.locator('#modal-body').inner_text()
                assert '匹配 1 行' in log and '删除 2 行' in log, log
                page.click('#modal-close')

            ui('conditional and filter UI support apply, undo and deletion audit', conditional_and_filter_ui)

            def invalid_filter_ui_and_report():
                import_text('safety.csv', 'Amount\n1\n2')
                open_config('filter')
                page.select_option("[data-config='column']", 'Amount')
                page.select_option("[data-config='operator']", 'gt')
                page.fill("[data-config='value']", 'not-a-number')
                page.select_option("[data-config='action']", 'keep')
                page.get_by_role('button', name='完成', exact=True).click()
                page.click('#btn-run')
                page.wait_for_selector('#preview-bar:not([hidden])')
                assert len(table_rows()) == 2
                with page.expect_download() as download:
                    page.click('#btn-report')
                report = unescape(Path(download.value.path()).read_text(encoding='utf-8-sig'))
                assert '"ruleId": "filter"' in report
                assert '行筛选 · 跳过' in report and '预览未提交' in report

            ui('invalid filter is safe and visible in the audit report', invalid_filter_ui_and_report)

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
