"""校验第 1 项（CSV 字段内换行/转义/分隔符嗅探）与第 4 项（xlsx 零依赖解析）。"""
import functools, http.server, os, socketserver, sys, threading, zipfile, io
from playwright.sync_api import sync_playwright

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8483
passed = failed = 0


def check(cond, msg):
    global passed, failed
    if cond:
        passed += 1; print("  PASS  " + msg)
    else:
        failed += 1; print("  FAIL  " + msg)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    handler = functools.partial(QuietHandler, directory=BASE)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def make_xlsx(path):
    """用 Python 标准库手写一个最小 xlsx：含共享字符串、日期样式、多工作表。"""
    ss = ('<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/'
          'spreadsheetml/2006/main" count="5" uniqueCount="5">'
          '<si><t>姓名</t></si><si><t>入职日期</t></si><si><t>备注</t></si>'
          '<si><t>张三</t></si><si><t>含,逗号</t></si></sst>')
    styles = ('<?xml version="1.0"?><styleSheet xmlns="http://schemas.'
              'openxmlformats.org/spreadsheetml/2006/main">'
              '<numFmts count="0"/><cellXfs count="2">'
              '<xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>')
    # 44927 = 2023-01-05；样式 1 是日期格式
    sheet1 = ('<?xml version="1.0"?><worksheet xmlns="http://schemas.'
              'openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
              '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>'
              '<c r="C1" t="s"><v>2</v></c></row>'
              '<row r="2"><c r="A2" t="s"><v>3</v></c>'
              '<c r="B2" s="1"><v>44931</v></c>'
              '<c r="C2" t="s"><v>4</v></c></row>'
              '<row r="3"><c r="A3" t="inlineStr"><is><t>李四</t></is></c>'
              '<c r="B3" s="1"><v>44932</v></c>'
              '<c r="C3"><v>123.45</v></c></row>'
              '</sheetData></worksheet>')
    sheet2 = ('<?xml version="1.0"?><worksheet xmlns="http://schemas.'
              'openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
              '<row r="1"><c r="A1" t="inlineStr"><is><t>第二表</t></is></c></row>'
              '<row r="2"><c r="A2"><v>7</v></c></row>'
              '</sheetData></worksheet>')
    wb = ('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.'
          'org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.'
          'org/officeDocument/2006/relationships"><sheets>'
          '<sheet name="员工表" sheetId="1" r:id="rId1"/>'
          '<sheet name="汇总" sheetId="2" r:id="rId2"/></sheets></workbook>')
    rels = ('<?xml version="1.0"?><Relationships xmlns="http://schemas.'
            'openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="t"/>'
            '<Relationship Id="rId2" Target="worksheets/sheet2.xml" Type="t"/>'
            '</Relationships>')
    ct = ('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.'
          'org/package/2006/content-types"/>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("xl/workbook.xml", wb)
        z.writestr("xl/_rels/workbook.xml.rels", rels)
        z.writestr("xl/sharedStrings.xml", ss)
        z.writestr("xl/styles.xml", styles)
        z.writestr("xl/worksheets/sheet1.xml", sheet1)
        z.writestr("xl/worksheets/sheet2.xml", sheet2)



CSV_TESTS = r"""
() => {
  const IO = window.DCIO;
  const out = [];
  const t = (c, m) => out.push({ ok: !!c, msg: m });

  // 1. 字段内含换行（旧实现会把这条记录劈成两行 → 数据损坏）
  let r = IO.parseCSV('name,addr\n张三,"北京市\n朝阳区"\n李四,上海\n');
  t(r.rows.length === 2, '字段内换行：行数正确（2 行，不被劈开）');
  t(r.rows[0][1] === '北京市\n朝阳区', '字段内换行：内容完整保留');
  t(r.rows[1][0] === '李四', '字段内换行：后续行不错位');

  // 2. 转义引号（用 fromCharCode 构造，避免连续三引号影响外层 Python 字符串）
  const Q = String.fromCharCode(34);
  r = IO.parseCSV('a,b\n1,' + Q + '他说' + Q + Q + '你好' + Q + Q + Q + '\n');
  t(r.rows[0][1] === '他说' + Q + '你好' + Q, '转义引号：两个双引号 → 一个');

  // 3. 引号内的分隔符
  r = IO.parseCSV('a,b\n"x,y",z\n');
  t(r.rows[0][0] === 'x,y' && r.rows[0][1] === 'z', '引号内逗号不当作分隔符');

  // 4. 分隔符嗅探
  t(IO.sniffDelimiter('a\tb\tc\n1\t2\t3') === '\t', '嗅探：TSV → 制表符');
  t(IO.sniffDelimiter('a;b;c\n1;2;3') === ';', '嗅探：分号');
  t(IO.sniffDelimiter('a,b,c\n1,2,3') === ',', '嗅探：逗号');
  t(IO.sniffDelimiter('a,b\n"x\ty",z\n"p\tq",w') === ',', '嗅探：忽略引号内的分隔符');

  // 5. CRLF + 表头补空名
  r = IO.parseCSV('a,,c\r\n1,2,3\r\n');
  t(r.headers[1] === '列2', '空表头自动命名为 列N');
  t(r.rows[0].length === 3, 'CRLF 换行解析正确');

  // 6. 列数不齐 → 补齐成矩形
  r = IO.parseCSV('a,b,c\n1,2\n');
  t(r.rows[0].length === 3 && r.rows[0][2] === '', '短行补齐为空串');

  // 7. 导出→导入闭环（旧版会散架的场景）
  const cells = ['多行\n文本', '含' + Q + '引号' + Q, '含,逗号', '普通'];
  const esc = v => /[",\n]/.test(v) ? Q + v.replace(/"/g, Q + Q) + Q : v;
  const csv = 'c1,c2,c3,c4\n' + cells.map(esc).join(',') + '\n';
  r = IO.parseCSV(csv);
  t(r.rows.length === 1, '往返闭环：行数为 1');
  t(JSON.stringify(r.rows[0]) === JSON.stringify(cells), '往返闭环：4 个字段全部无损');

  return out;
}
"""


def main():
    httpd = serve()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            page = b.new_page(accept_downloads=True)
            errs = []
            page.on("pageerror", lambda e: errs.append(str(e)))
            page.goto(f"http://127.0.0.1:{PORT}/index.html")
            page.wait_for_selector("table.data-table", timeout=15000)

            print("=" * 60)
            print("第 1 项：CSV 解析器（字符流状态机）")
            print("=" * 60)
            for r in page.evaluate(CSV_TESTS):
                check(r["ok"], r["msg"])

            print()
            print("=" * 60)
            print("第 4 项：XLSX 零依赖解析")
            print("=" * 60)
            xlsx = os.path.join(BASE, "tools", "_t.xlsx")
            make_xlsx(xlsx)
            page.set_input_files("#file-input", xlsx)
            page.wait_for_timeout(900)
            check(page.locator("#modal.open").count() == 1, "多工作表时弹出选择框")
            check("员工表" in page.locator("#modal-body").inner_text(), "列出工作表名称")
            page.locator("#modal-body .btn").first.click()
            page.wait_for_timeout(600)
            head = page.locator("table.data-table thead").inner_text()
            body = page.locator("table.data-table tbody").inner_text()
            check("入职日期" in head, "xlsx 共享字符串表头解析正确")
            check("张三" in body, "xlsx 共享字符串单元格正确")
            check("李四" in body, "xlsx inlineStr 单元格正确")
            check("2023-01" in body, "xlsx 日期序列号转成日期文本")
            check("含,逗号" in body, "xlsx 含逗号的值不被误切")
            check("123.45" in body, "xlsx 数字单元格保留")
            os.remove(xlsx)

            print()
            print("=" * 60)
            print("第 2 项：规则预设持久化")
            print("=" * 60)
            page.goto(f"http://127.0.0.1:{PORT}/index.html")
            page.wait_for_selector("table.data-table", timeout=15000)
            # 改动规则配置：停用 empty 规则，作为可辨识的指纹
            page.evaluate("() => localStorage.removeItem('dc_presets')")
            page.reload()
            page.wait_for_selector("table.data-table", timeout=15000)
            page.locator('.rule-card[data-rule="empty"] .btn-mini').first.click()
            state_off = page.evaluate(
                "() => document.querySelector('.rule-card[data-rule=\"empty\"] .btn-mini').textContent")
            check("停用" in state_off, "可切换规则开关（当前：%s）" % state_off)

            page.click("#btn-preset-save")
            page.wait_for_timeout(300)
            check(page.locator("#modal.open").count() == 1, "点击保存弹出命名框")
            page.fill("#modal-body .text-input", "我的测试预设")
            page.locator("#modal-body .btn.primary").click()
            page.wait_for_timeout(300)
            opts = page.locator("#preset-select option").all_inner_texts()
            check(any("我的测试预设" in o for o in opts), "预设出现在下拉框：%s" % opts)

            # 关键：刷新后仍在（localStorage 持久化）
            page.reload()
            page.wait_for_selector("table.data-table", timeout=15000)
            opts = page.locator("#preset-select option").all_inner_texts()
            check(any("我的测试预设" in o for o in opts), "刷新后预设仍然存在（持久化生效）")
            # 刷新后规则回到默认（empty 启用），套用预设应还原为停用
            before = page.evaluate(
                "() => document.querySelector('.rule-card[data-rule=\"empty\"] .btn-mini').textContent")
            check("启用" in before, "刷新后规则回到默认状态（%s）" % before)
            page.select_option("#preset-select", "我的测试预设")
            page.wait_for_timeout(400)
            after = page.evaluate(
                "() => document.querySelector('.rule-card[data-rule=\"empty\"] .btn-mini').textContent")
            check("停用" in after, "套用预设后规则配置被还原（%s）" % after)

            # 导出 JSON
            with page.expect_download() as dl:
                page.click("#btn-preset-export")
            path = dl.value.path()
            txt = open(path, encoding="utf-8-sig").read()
            check('"我的测试预设"' in txt, "导出 JSON 含预设名")
            check('"rules"' in txt, "导出 JSON 含 rules 字段")

            # 导入：清空后从刚导出的文件恢复
            imp = os.path.join(BASE, "tools", "_p.json")
            open(imp, "w", encoding="utf-8").write(txt)
            page.evaluate("() => localStorage.removeItem('dc_presets')")
            page.reload()
            page.wait_for_selector("table.data-table", timeout=15000)
            page.set_input_files("#preset-file", imp)
            page.wait_for_timeout(500)
            opts = page.locator("#preset-select option").all_inner_texts()
            check(any("我的测试预设" in o for o in opts), "从 JSON 导入预设成功")
            os.remove(imp)
            # 删除
            page.select_option("#preset-select", "我的测试预设")
            page.wait_for_timeout(200)
            page.click("#btn-preset-del")
            page.wait_for_timeout(300)
            opts = page.locator("#preset-select option").all_inner_texts()
            check(not any("我的测试预设" in o for o in opts), "删除预设成功")

            print()
            print("=" * 60)
            print("第 3 项：分页（可查看 100 行之后的数据）")
            print("=" * 60)
            big = os.path.join(BASE, "tools", "_big.csv")
            with open(big, "w", encoding="utf-8", newline="") as f:
                f.write("id,name\n")
                for i in range(1, 251):
                    f.write("%d,行%d\n" % (i, i))
            page.set_input_files("#file-input", big)
            page.wait_for_timeout(700)
            check(page.locator(".pager").count() == 1, "超过 100 行显示分页栏")
            info = page.locator(".pager-info").inner_text()
            check("1–100" in info and "250" in info, "分页信息正确：%s" % info)
            body = page.locator("table.data-table tbody").inner_text()
            check("行100" in body and "行101" not in body, "第 1 页显示 1–100 行")

            # 翻到第 2 页 → 应能看到旧版永远看不到的第 101 行
            page.locator('.pager .btn-mini:has-text("下页")').click()
            page.wait_for_timeout(300)
            body = page.locator("table.data-table tbody").inner_text()
            check("行101" in body, "下页：能看到第 101 行（旧版做不到）")
            rownum = page.locator("table.data-table tbody .row-num").first.inner_text()
            check(rownum == "101", "行号为全局行号 101（实际 %s）" % rownum)

            # 末页
            page.locator('.pager .btn-mini:has-text("末页")').click()
            page.wait_for_timeout(300)
            body = page.locator("table.data-table tbody").inner_text()
            check("行250" in body, "末页：能看到最后一行 250")
            info = page.locator(".pager-info").inner_text()
            check("3/3" in info, "页码显示 3/3：%s" % info)

            # 跳页输入
            page.fill(".pager-jump", "2")
            page.press(".pager-jump", "Enter")
            page.wait_for_timeout(300)
            info = page.locator(".pager-info").inner_text()
            check("101–200" in info, "跳页到第 2 页：%s" % info)

            # 执行清洗后高亮仍在正确的分页位置
            page.click("#btn-run")
            page.wait_for_timeout(800)
            check(page.locator(".pager").count() == 1, "清洗后分页栏依然存在")
            os.remove(big)

            print()
            print("=" * 60)
            print("第 5 项：XLSX 导出（零依赖生成，闭环）")
            print("=" * 60)
            page.goto(f"http://127.0.0.1:{PORT}/index.html")
            page.wait_for_selector("table.data-table", timeout=15000)

            # 造一份含各种边界值的 CSV 导入，再导出为 xlsx
            tricky = os.path.join(BASE, "tools", "_tk.csv")
            with open(tricky, "w", encoding="utf-8", newline="") as f:
                f.write("名称,手机号,编号,金额,备注\n")
                f.write('张三,13812345678,007,123.45,"多行\n文本"\n')
                f.write('李<四>&特殊,13900002222,42,-8.5,"含""引号"""\n')
            page.set_input_files("#file-input", tricky)
            page.wait_for_timeout(600)
            os.remove(tricky)

            with page.expect_download() as dl:
                page.click("#btn-export-xlsx")
            out = os.path.join(BASE, "tools", "_out.xlsx")
            dl.value.save_as(out)
            check(os.path.getsize(out) > 500, "导出文件非空（%d 字节）" % os.path.getsize(out))

            # 用 Python 标准库独立验证：是合法 ZIP 且 CRC 全部正确
            with zipfile.ZipFile(out) as z:
                bad = z.testzip()
                check(bad is None, "ZIP 结构与 CRC32 校验通过（standard zipfile）")
                names = z.namelist()
                for need in ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
                             "xl/_rels/workbook.xml.rels", "xl/styles.xml",
                             "xl/worksheets/sheet1.xml"]:
                    check(need in names, "包含必需部件 %s" % need)
                sx = z.read("xl/worksheets/sheet1.xml").decode("utf-8")
                wbx = z.read("xl/workbook.xml").decode("utf-8")

            check("&lt;" in sx and "&amp;" in sx, "XML 特殊字符已转义（< 与 &）")
            check("<v>123.45</v>" in sx, "纯小数写为数字单元格")
            check("13812345678" in sx and 'inlineStr' in sx, "长数字串保留为文本（不转科学计数法）")
            check(">007<" in sx, "前导零编号保留为文本（不被吃掉 0）")
            check("_tk" in wbx, "工作表名沿用文件名")

            # 闭环：把自己导出的 xlsx 再导入回来
            page.goto(f"http://127.0.0.1:{PORT}/index.html")
            page.wait_for_selector("table.data-table", timeout=15000)
            page.set_input_files("#file-input", out)
            page.wait_for_timeout(900)
            head = page.locator("table.data-table thead").inner_text()
            body = page.locator("table.data-table tbody").inner_text()
            check("手机号" in head and "备注" in head, "闭环：表头读回正确")
            check("张三" in body, "闭环：普通文本读回正确")
            check("13812345678" in body, "闭环：手机号完整读回")
            check("007" in body, "闭环：前导零完整读回")
            check("123.45" in body, "闭环：小数读回正确")
            check("李<四>&特殊" in body, "闭环：特殊字符读回正确（转义往返无损）")
            info = page.locator("#file-info").inner_text()
            check("2 行" in info, "闭环：行数一致（2 行）· %s" % info)
            os.remove(out)

            print()
            print(f"控制台/页面错误: {len(errs)}")
            for e in errs:
                print("  JS ERROR: " + e)
            b.close()
    finally:
        httpd.shutdown(); httpd.server_close()

    print("=" * 60)
    print(f"RESULT: {passed} passed, {failed} failed")
    print("=" * 60)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
