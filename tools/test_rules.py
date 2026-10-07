"""DataCleaner Pro · AI · 引擎验证（Python 版）
直接复刻 JS 引擎的核心规则，验证流水线、启发式、JSON 解析、Markdown 渲染。
"""
import re
import json

# ===== 规则引擎（与 js/rules.js 保持一致） =====
def rule_text(headers, rows, opts):
    """文本清洗：去空白 / 去特殊字符 / 大小写"""
    trim = opts.get('trim', True)
    remove_special = opts.get('removeSpecial', False)
    case_mode = opts.get('caseMode', 'none')
    changed = set()
    for r, row in enumerate(rows):
        for c, v in enumerate(row):
            orig = v
            if v is None: v = ''
            sv = str(v)
            if trim: sv = sv.strip()
            if remove_special: sv = re.sub(r'[^\w\u4e00-\u9fff\s]', '', sv)
            if case_mode == 'upper': sv = sv.upper()
            elif case_mode == 'lower': sv = sv.lower()
            elif case_mode == 'title': sv = sv.title()
            if sv != orig:
                row[c] = sv
                changed.add((r, c))
    return {'rows': rows, 'changed': changed}


def rule_date(headers, rows, opts):
    """日期标准化"""
    targets = opts.get('targets', [])
    fmt = opts.get('format', 'YYYY-MM-DD')
    changed = set()
    date_pat = re.compile(r'(\d{4})[/\-\.](\d{1,2})[/\-\.](\d{1,2})')
    date_pat2 = re.compile(r'(\d{1,2})[/\-\.](\d{1,2})[/\-\.](\d{4})')
    target_idxs = [headers.index(t) for t in targets if t in headers]
    for r, row in enumerate(rows):
        for c in target_idxs:
            v = row[c]
            if not v: continue
            sv = str(v).strip()
            m = date_pat.search(sv)
            if m:
                y, mo, d = m.group(1), m.group(2), m.group(3)
            else:
                m2 = date_pat2.search(sv)
                if not m2: continue
                mo, d, y = m2.group(1), m2.group(2), m2.group(3)
            if fmt == 'YYYY-MM-DD':
                out = f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
            elif fmt == 'DD/MM/YYYY':
                out = f"{int(d):02d}/{int(mo):02d}/{int(y):04d}"
            elif fmt == 'MM/DD/YYYY':
                out = f"{int(mo):02d}/{int(d):02d}/{int(y):04d}"
            else:
                out = f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
            if out != v:
                row[c] = out
                changed.add((r, c))
    return {'rows': rows, 'changed': changed}


def rule_remove(headers, rows, opts):
    """去重"""
    seen = set()
    out = []
    changed = set()
    for r, row in enumerate(rows):
        k = '|'.join(str(c) for c in row)
        if k in seen:
            changed.add((r, -1))
            continue
        seen.add(k)
        out.append(row)
    return {'rows': out, 'changed': changed}


def rule_number(headers, rows, opts):
    """手机号脱敏 / 数字处理"""
    phone = opts.get('phone', False)
    changed = set()
    if not phone:
        return {'rows': rows, 'changed': changed}
    for r, row in enumerate(rows):
        for c, v in enumerate(row):
            if not v: continue
            sv = re.sub(r'\D', '', str(v))
            if len(sv) == 11 and sv.startswith('1'):
                out = sv[:3] + '****' + sv[7:]
                if out != v:
                    row[c] = out
                    changed.add((r, c))
    return {'rows': rows, 'changed': changed}


def run_pipeline(pipeline, headers, rows, on_progress=None):
    """执行整条流水线"""
    cur = rows
    total = len(pipeline)
    for i, p in enumerate(pipeline):
        if on_progress: on_progress((i+1)/total, p['ruleId'])
        result = RULES[p['ruleId']]['run'](headers, cur, p.get('opts', {}))
        cur = result['rows']
    return {'rows': cur, 'changed': result['changed']}


RULES = {
    'text': {'run': rule_text},
    'date': {'run': rule_date},
    'remove': {'run': rule_remove},
    'number': {'run': rule_number},
}

# ===== AI 启发式（与 js/ai.js 保持一致） =====
def heuristic_steps(instruction, headers, rows):
    """根据自然语言指令生成清洗步骤（无需 API Key）"""
    text = instruction.strip()
    steps = []
    headers_set = set(headers)

    # 启发式 1: 日期
    if any(k in text for k in ['日期', 'date', '时间', '标准化', '统一', '格式']):
        for h in headers:
            if any(k in h for k in ['日期', 'date', '时间']):
                steps.append({
                    'type': 'normalize_date',
                    'column': h,
                    'target_format': 'YYYY-MM-DD',
                    'description': f'把 {h} 列标准化为 YYYY-MM-DD',
                })
                break

    # 启发式 2: 手机号脱敏
    if any(k in text for k in ['手机', 'phone', '电话', '脱敏', '星号', '隐藏', '掩码']):
        for h in headers:
            if any(k in h for k in ['手机', 'phone', '电话']):
                steps.append({
                    'type': 'mask_column',
                    'column': h,
                    'pattern': 'keep_first(3) + **** + keep_last(4)',
                    'description': f'把 {h} 中间四位用 **** 隐藏',
                })
                break

    # 启发式 3: 填充空值
    if any(k in text for k in ['空值', '空', '缺失', '填充', 'fill']):
        for h in headers:
            if any(k in h for k in ['部门', 'dept', '类型', '状态']):
                steps.append({
                    'type': 'fill_empty',
                    'column': h,
                    'value': '未知',
                    'description': f'把 {h} 列空值填为「未知」',
                })
                break

    # 启发式 4: 去重
    if any(k in text for k in ['重复', 'duplicate', '去重', '删除重复']):
        steps.append({
            'type': 'remove_duplicates',
            'description': '删除完全重复的行',
        })

    # 启发式 5: 重命名 / 替换
    if any(k in text for k in ['改成', '替换为', '改名为', 'rename']):
        steps.append({
            'type': 'rename_column',
            'column': headers[0] if headers else '',
            'new_name': '新列名',
            'description': '修改列名',
        })

    # 启发式 6: 删除列
    if any(k in text for k in ['删除列', '移除列', 'delete column']):
        steps.append({
            'type': 'delete_column',
            'column': headers[-1] if headers else '',
            'description': '删除指定列',
        })

    if not steps:
        # 默认建议：trim + 日期检查
        for h in headers:
            if any(k in h for k in ['日期', 'date', '时间']):
                steps.append({
                    'type': 'normalize_date',
                    'column': h,
                    'target_format': 'YYYY-MM-DD',
                    'description': f'未识别具体指令，建议把 {h} 标准化',
                })
                break

    return {'analysis': f'启发式分析：检测到 {len(steps)} 个潜在清洗步骤', 'steps': steps}


def parse_ai_response(text, headers):
    """从 AI 文本中提取 JSON 步骤列表"""
    headers_set = set(headers)
    # 1. 尝试 fenced code block
    m = re.search(r'```(?:json)?\s*(\{[\s\S]*?\})\s*```', text)
    if not m:
        # 2. 尝试直接 JSON
        m = re.search(r'(\{[\s\S]*"steps"\s*:\s*\[[\s\S]*?\][\s\S]*?\})', text)
    if not m:
        return {'analysis': '未找到 JSON', 'steps': []}
    try:
        obj = json.loads(m.group(1))
    except json.JSONDecodeError as e:
        return {'analysis': f'JSON 解析失败: {e}', 'steps': []}

    raw_steps = obj.get('steps', [])
    valid_steps = []
    for s in raw_steps:
        if not isinstance(s, dict): continue
        t = s.get('type', '')
        col = s.get('column', '')
        # 过滤掉无效列名
        if col and col not in headers_set and t not in ('remove_duplicates',):
            continue
        # 验证步骤类型
        valid_types = {'mask_column', 'normalize_date', 'fill_empty', 'trim_whitespace',
                       'remove_duplicates', 'split_column', 'rename_column', 'delete_column', 'custom_formula'}
        if t not in valid_types: continue
        valid_steps.append(s)
    return {'analysis': obj.get('analysis', ''), 'steps': valid_steps}


def render_markdown(text):
    """轻量 Markdown 渲染"""
    # 代码块
    text = re.sub(r'```(\w*)\n([\s\S]*?)```',
                  r'<pre class="md-code">\2</pre>', text)
    # 标题
    text = re.sub(r'^### (.+)$', r'<h4>\1</h4>', text, flags=re.M)
    text = re.sub(r'^## (.+)$', r'<h3>\1</h3>', text, flags=re.M)
    text = re.sub(r'^# (.+)$', r'<h2>\1</h2>', text, flags=re.M)
    # 粗体
    text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
    # 行内代码
    text = re.sub(r'`([^`]+)`', r'<code class="md-inline">\1</code>', text)
    # 列表
    lines = text.split('\n')
    out = []
    in_ul = False
    for ln in lines:
        if ln.strip().startswith('- '):
            if not in_ul:
                out.append('<ul>')
                in_ul = True
            out.append('<li>' + ln.strip()[2:] + '</li>')
        else:
            if in_ul:
                out.append('</ul>')
                in_ul = False
            out.append(ln)
    if in_ul: out.append('</ul>')
    return '\n'.join(out)


def analyze_quality(headers, rows):
    """数据质量分析"""
    issues = []
    seen = set()
    for r, row in enumerate(rows):
        k = '|'.join(str(c) for c in row)
        if k in seen:
            issues.append({'row': r, 'type': 'duplicate', 'message': f'第 {r+1} 行与之前重复'})
        seen.add(k)

    for c, h in enumerate(headers):
        for r, row in enumerate(rows):
            v = row[c] if c < len(row) else ''
            sv = str(v).strip() if v else ''
            if not sv:
                issues.append({'row': r, 'col': h, 'type': 'empty', 'message': f'第 {r+1} 行 {h} 列为空'})

    for c, h in enumerate(headers):
        if '日期' in h or 'date' in h.lower():
            for r, row in enumerate(rows):
                v = row[c] if c < len(row) else ''
                sv = str(v).strip() if v else ''
                if not sv: continue
                if not re.search(r'\d{4}[/\-\.]\d{1,2}[/\-\.]\d{1,2}', sv) and not re.search(r'\d{1,2}[/\-\.]\d{1,2}[/\-\.]\d{4}', sv):
                    issues.append({'row': r, 'col': h, 'type': 'date_format', 'message': f'第 {r+1} 行 {h} 日期格式不识别'})

    return issues


# ===== 测试用例 =====
pass_cnt, fail_cnt = 0, 0

def assert_eq(actual, expected, msg):
    global pass_cnt, fail_cnt
    if actual == expected:
        pass_cnt += 1
        print(f'  PASS  {msg}')
    else:
        fail_cnt += 1
        print(f'  FAIL  {msg}  (got {actual!r}, want {expected!r})')

def assert_true(cond, msg):
    global pass_cnt, fail_cnt
    if cond:
        pass_cnt += 1
        print(f'  PASS  {msg}')
    else:
        fail_cnt += 1
        print(f'  FAIL  {msg}')


print('='*60)
print('Test 1: 规则引擎基本功能')
print('='*60)

headers = ['姓名', '手机号', '入职日期', '部门', '邮箱', '备注']
rows = [
    ['张三', '13812345678', '2023/1/5', '  技术部  ', 'a@b.com', '正常'],
    ['李四', '13987654321', '2022-11-20', '市场部', 'c@d.com', '  优秀  '],
    ['王五', '  15611223344  ', '2021.08.15', '技术部', '', '后端'],
    ['赵六', '13700001111', '2020/3/2', 'HR', 'e@f.com', ''],
    ['张三', '13812345678', '2023/1/5', '  技术部  ', 'a@b.com', '正常'],  # 重复
    ['周八', '', '2022-06-15', '技术部', 'g@h.com', '前端'],  # 手机号空
]
h = headers[:]
rs = [r[:] for r in rows]

# Test 1.1: trim
r1 = rule_text(h, rs, {'trim': True, 'removeSpecial': False, 'caseMode': 'none'})
assert_eq(r1['rows'][0][3], '技术部', 'trim 空白：部门列首尾空白被去除')
assert_eq(r1['rows'][2][1], '15611223344', 'trim 空白：手机号首尾空白被去除')

# Test 1.2: 日期标准化
r2 = rule_date(h, r1['rows'], {'targets': ['入职日期'], 'format': 'YYYY-MM-DD'})
assert_eq(r2['rows'][0][2], '2023-01-05', '日期标准化：2023/1/5 → 2023-01-05')
assert_eq(r2['rows'][2][2], '2021-08-15', '日期标准化：2021.08.15 → 2021-08-15')

# Test 1.3: 去重
r3 = rule_remove(h, r2['rows'], {})
assert_eq(len(r3['rows']), 5, '去重：6 行 → 5 行')

# Test 1.4: 手机号脱敏
r4 = rule_number(h, r3['rows'], {'phone': True})
assert_eq(r4['rows'][0][1], '138****5678', '手机号脱敏：13812345678 → 138****5678')

# Test 1.5: 完整流水线
pipeline = [
    {'ruleId': 'text', 'enabled': True, 'opts': {'trim': True, 'removeSpecial': False, 'caseMode': 'none'}},
    {'ruleId': 'date', 'enabled': True, 'opts': {'targets': ['入职日期'], 'format': 'YYYY-MM-DD'}},
    {'ruleId': 'remove', 'enabled': True, 'opts': {}},
    {'ruleId': 'number', 'enabled': True, 'opts': {'phone': True}},
]
result = run_pipeline(pipeline, h, [r[:] for r in rows])
assert_eq(len(result['rows']), 5, '流水线：去重后剩 5 行')
assert_eq(result['rows'][0][1], '138****5678', '流水线：手机号脱敏')
assert_eq(result['rows'][0][2], '2023-01-05', '流水线：日期标准化')
assert_eq(result['rows'][0][3], '技术部', '流水线：trim 空白')
assert_true(len(result['changed']) > 0, '流水线：标记改动位置')

print()
print('='*60)
print('Test 2: AI 启发式（无 API Key 也可工作）')
print('='*60)

hr = heuristic_steps('把日期统一成 YYYY-MM-DD', h, rows)
assert_true(len(hr['steps']) > 0, '启发式：日期指令有步骤')
assert_eq(hr['steps'][0]['type'], 'normalize_date', '启发式：识别日期类型')

hr = heuristic_steps('把手机号中间四位隐藏', h, rows)
assert_true(len(hr['steps']) > 0, '启发式：手机号脱敏指令有步骤')
assert_eq(hr['steps'][0]['type'], 'mask_column', '启发式：识别脱敏类型')

hr = heuristic_steps('把部门列的空值填为未知', h, rows)
assert_true(len(hr['steps']) > 0, '启发式：填充空值指令有步骤')

hr = heuristic_steps('删除完全重复的行', h, rows)
assert_true(len(hr['steps']) > 0, '启发式：去重指令有步骤')
assert_eq(hr['steps'][0]['type'], 'remove_duplicates', '启发式：识别去重类型')

hr = heuristic_steps('把张三改成李四', h, rows)
assert_true(len(hr['steps']) > 0, '启发式：重命名指令有步骤')

print()
print('='*60)
print('Test 3: JSON 解析')
print('='*60)

ai_text1 = '```json\n{"analysis": "测试", "steps": [{"type": "trim_whitespace", "column": "姓名", "description": "去空白"}]}\n```'
parsed = parse_ai_response(ai_text1, h)
assert_eq(len(parsed['steps']), 1, 'JSON 解析：fenced code block 解析正确')
assert_eq(parsed['steps'][0]['type'], 'trim_whitespace', 'JSON 解析：步骤类型正确')

ai_text2 = '{"analysis": "直接 JSON", "steps": [{"type": "normalize_date", "column": "入职日期", "target_format": "YYYY-MM-DD", "description": "标准化日期"}]}'
parsed = parse_ai_response(ai_text2, h)
assert_eq(len(parsed['steps']), 1, 'JSON 解析：直接 JSON 也能解析')
assert_eq(parsed['steps'][0]['target_format'], 'YYYY-MM-DD', 'JSON 解析：嵌套字段正确')

ai_text3 = '解释一下：先看一下数据```json\n{"analysis": "测试3", "steps": [{"type": "mask_column", "column": "手机号", "pattern": "keep_first(3)+****", "description": "脱敏"}]}\n```然后结束'
parsed = parse_ai_response(ai_text3, h)
assert_eq(len(parsed['steps']), 1, 'JSON 解析：混合文本中提取 JSON')
assert_eq(parsed['steps'][0]['type'], 'mask_column', 'JSON 解析：脱敏类型')

# 无效列名应被过滤
ai_text4 = '{"analysis": "测试4", "steps": [{"type": "mask_column", "column": "不存在列", "description": "x"}, {"type": "trim_whitespace", "column": "姓名", "description": "去空白"}]}'
parsed = parse_ai_response(ai_text4, h)
assert_eq(len(parsed['steps']), 1, 'JSON 解析：过滤无效列名')
assert_eq(parsed['steps'][0]['column'], '姓名', 'JSON 解析：保留有效列名')

print()
print('='*60)
print('Test 4: Markdown 渲染')
print('='*60)

md = render_markdown('# 标题\n## 副标题\n正文 **粗体** 和 `代码`\n- 列表项1\n- 列表项2')
assert_true('<h2>' in md, 'Markdown 渲染：h1 → h2')
assert_true('<h3>' in md, 'Markdown 渲染：h2 → h3')
assert_true('<strong>' in md, 'Markdown 渲染：粗体')
assert_true('md-inline' in md, 'Markdown 渲染：行内代码')
assert_true('<ul>' in md, 'Markdown 渲染：列表')

md = render_markdown('```js\nconsole.log("hi")\n```')
assert_true('md-code' in md, 'Markdown 渲染：代码块')

print()
print('='*60)
print('Test 5: AI 步骤执行（从 JSON 到真实清洗）')
print('='*60)

ai_result = heuristic_steps('把手机号中间四位用星号隐藏，日期统一成 YYYY-MM-DD', h, [r[:] for r in rows[:5]])
print(f'  启发式生成 {len(ai_result["steps"])} 个步骤：')
for s in ai_result['steps']:
    print(f'    - {s["type"]} → {s.get("column", "无列")}: {s.get("description", "")}')

# 用启发式结果走流水线
if ai_result['steps']:
    # 把 AI 步骤包装成规则操作
    h2 = h[:]
    rs2 = [r[:] for r in rows[:5]]
    # 手动模拟 AI 步骤
    for s in ai_result['steps']:
        if s['type'] == 'mask_column' and 'column' in s:
            idx = h2.index(s['column']) if s['column'] in h2 else -1
            if idx >= 0:
                for row in rs2:
                    v = row[idx]
                    if v:
                        sv = re.sub(r'\D', '', str(v))
                        if len(sv) == 11:
                            row[idx] = sv[:3] + '****' + sv[7:]
        elif s['type'] == 'normalize_date' and 'column' in s:
            r2 = rule_date(h2, rs2, {'targets': [s['column']], 'format': s.get('target_format', 'YYYY-MM-DD')})
            rs2 = r2['rows']
    assert_true(rs2[0][1] == '138****5678' or '****' in str(rs2[0][1]), 'AI 步骤执行：手机号脱敏生效')
    print(f'  验证清洗结果：{rs2[0]}')

print()
print('='*60)
print('Test 6: 质量分析')
print('='*60)

issues = analyze_quality(headers, rows)
print(f'  发现 {len(issues)} 个问题：')
for iss in issues:
    print(f'    - {iss["message"]}')
assert_true(len(issues) > 0, '质量分析：示例数据有问题可被识别')

print()
print('='*60)
print(f'汇总: {pass_cnt} 通过, {fail_cnt} 失败')
print('='*60)
import sys
sys.exit(0 if fail_cnt == 0 else 1)