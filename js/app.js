/* ============================================
   DataCleaner Pro · AI · 主应用
   - 加载示例数据 / 解析表格
   - 规则流水线（13 条内置规则 + AI 规则）
   - AI 智能清洗面板（自然语言 → 流式 → 确认 → 注入）
   - 多轮对话 / 自动修复建议 / 错误回滚
   ============================================ */

(function () {
  'use strict';

  const R = window.DCRules;
  const AI = window.DCAI;

  // ---- 全局状态 ----
  const state = {
    // source* 是本次导入的不可变输入；headers/rows 是已提交结果；previewResult 尚未提交。
    sourceHeaders: [],
    sourceRows: [],
    headers: [],
    rows: [],
    fileName: '',
    importStats: null,
    activeRules: [
      { ruleId: 'empty', enabled: true, opts: { mode: 'rows' } },
      { ruleId: 'text', enabled: true, opts: { trim: true, removeSpecial: false, caseMode: 'none' } },
    ],
    lastResult: null,   // 最近一次已提交的流水线结果
    previewResult: null, // 从 source* 重算的待确认结果
    history: [],        // 已提交结果的撤销栈
    aiConversation: [], // 多轮对话 messages
    aiLastSteps: null,  // 已应用到流水线的步骤
    aiPendingSteps: null, // AI 刚生成、等待用户确认的步骤
    page: 0,            // 数据预览当前页（每页 100 行）
    operation: null,     // 可取消的导入/清洗任务；旧任务不能提交结果
    qualityJob: null,    // 与当前数据对应的后台质量画像
    qualityCache: null,  // 相同 headers/rows 引用复用画像，避免重复全表扫描
    qualitySource: null, // Worker 最近结果可直接供画像使用，避免大表再次跨线程复制
    sourceWorkerJob: null, // 原始导入在 Worker 中的可复用引用
  };

  // ---- 工具 ----
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'style') e.style.cssText = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    for (const c of children) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return e;
  }
  function showToast(msg, type) {
    const t = el('div', { class: 'toast ' + (type || '') }, msg);
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3500);
  }

  function cancelQualityJob() {
    if (state.qualityJob) state.qualityJob.job.cancel();
    state.qualityJob = null;
  }

  function updateTaskUI() {
    const busy = !!state.operation;
    $('btn-cancel-task').hidden = !busy;
    $('btn-run').disabled = busy;
    $('btn-run').textContent = busy
      ? (state.operation.kind === 'import' ? '⏳ 正在导入'
        : state.operation.kind === 'export' ? '⏳ 正在导出' : '⏳ 正在清洗') : '▶ 预览清洗';
    $('btn-apply').disabled = busy || !state.previewResult;
    ['btn-undo', 'btn-export', 'btn-export-xlsx', 'btn-report', 'btn-suggest'].forEach(id => {
      $(id).disabled = busy;
    });
    document.querySelectorAll('#rules-list button').forEach(button => { button.disabled = busy; });
  }

  function cancelOperation(notify) {
    const operation = state.operation;
    if (!operation) return false;
    state.operation = null;
    if (operation.job) operation.job.cancel();
    cancelQualityJob();
    updateTaskUI();
    updateProgress(0, '已取消');
    if (notify) {
      renderQuality();
      showToast('已取消后台任务，原数据未修改');
    }
    return true;
  }

  function startOperation(kind) {
    cancelOperation(false);
    cancelQualityJob();
    const operation = { kind, job: null };
    state.operation = operation;
    updateTaskUI();
    updateProgress(0, kind === 'import' ? '等待读取文件'
      : kind === 'export' ? '等待后台导出' : '等待后台清洗');
    return operation;
  }

  function finishOperation(operation) {
    if (state.operation !== operation) return;
    state.operation = null;
    updateTaskUI();
    updateProgress(0, '就绪');
    // 导入失败时仍显示旧表；若旧画像曾被新任务取消，为当前视图重新启动分析。
    const view = getViewData(), cached = state.qualityCache, pending = state.qualityJob;
    const hasCache = cached && cached.headers === view.headers && cached.rows === view.rows;
    const hasPending = pending && pending.headers === view.headers && pending.rows === view.rows;
    if (!hasCache && !hasPending) renderQuality();
  }

  // ---- 示例数据 ----
  const SAMPLE_DATA = {
    headers: ['姓名', '手机号', '入职日期', '部门', '邮箱', '备注'],
    rows: [
      ['张三', '13812345678', '2023/1/5', '  技术部  ', 'zhangsan@company.com', '正常'],
      ['李四', '13987654321', '2022-11-20', '市场部', 'lisi@company.com', '  优秀  '],
      ['王五', '  15611223344  ', '2021.08.15', '技术部', '', '后端'],
      ['赵六', '13700001111', '2020/3/2', 'HR', 'zhaoliu@company.com', ''],
      ['张三', '13812345678', '2023/1/5', '  技术部  ', 'zhangsan@company.com', '正常'],
      ['孙七', '13922223333', '2019-12-31', '财务部', 'sunqi@company.com', 'CFA'],
      ['周八', '', '2022-06-15', '技术部', 'zhouba@company.com', '前端'],
      ['吴九', '13344445555', '2024/2/29', '市场部', 'wujiu@company.com', '海外'],
      ['郑十', '13566667777', '2023/7/1', '', 'zhengshi@company.com', ''],
      ['钱十一', '13688889999', '2021-10-10', '运营部', 'qian11@company.com', 'P5'],
    ],
  };

  // ---- 加载示例 ----
  function loadSample() {
    cancelOperation(false);
    setData(SAMPLE_DATA.headers.slice(), SAMPLE_DATA.rows.map(r => r.slice()),
      '示例数据.csv', '已加载示例数据（10 行）');
  }

  // ---- 统一装载入口：任何来源的数据都走这里 ----
  function setData(headers, rows, name, extraToast, stats, sourceJob) {
    cancelQualityJob();
    state.qualityCache = null;
    state.sourceHeaders = headers.slice();
    // 解析结果是应用独占的新数组，接管为不可变输入可少复制一整张大表。
    state.sourceRows = rows;
    state.headers = headers.slice();
    // 初始已提交表与不可变源表共享；之后的应用/撤销只整体替换，不做原地修改。
    state.rows = rows;
    state.fileName = name || 'data.csv';
    state.importStats = stats || null;
    state.activeRules = [
      { ruleId: 'empty', enabled: true, opts: { mode: 'rows' } },
      { ruleId: 'text', enabled: true, opts: { trim: true, removeSpecial: false, caseMode: 'none' } },
    ];
    state.lastResult = null;
    state.previewResult = null;
    state.history = [];
    state.aiConversation = [];
    state.aiLastSteps = null;
    state.aiPendingSteps = null;
    state.page = 0;
    state.qualitySource = sourceJob
      ? { headers: state.headers, rows: state.rows, job: sourceJob } : null;
    state.sourceWorkerJob = sourceJob || null;
    resetAIPanel();
    renderAll();
    showToast(extraToast || ('已加载 ' + rows.length + ' 行'));
  }

  // ---- 加载 CSV/TSV 文本 ----
  // 用 DCIO 的字符流解析器：支持字段内换行、"" 转义、自动嗅探分隔符
  function importWarning(stats) {
    if (!stats || !stats.irregularRows || !stats.irregularRows.length) return '';
    const samples = stats.irregularRows.slice(0, 8).map(r => '#' + r.row + '(' + r.actual + '列)').join('、');
    return '；⚠ ' + stats.irregularRows.length + ' 行列数异常 ' + samples
      + (stats.extendedColumns ? '；已新增 ' + stats.extendedColumns + ' 列保留额外字段' : '；短行已补空值');
  }

  async function loadCSVFile(file, name, requestedDelimiter, operation) {
    updateProgress(0.05, '正在后台读取、解码并解析 CSV');
    operation.job = DCWorker.run('parseCSV', { file, delimiter: requestedDelimiter }, progress => {
      if (state.operation === operation) updateProgress(progress, '正在后台解析 CSV');
    });
    const table = await operation.job.promise;
    if (state.operation !== operation) return;
    if (!table.headers.length) { showToast('文件为空或无法解析', 'err'); return; }
    if (operation.job.fileReadFallback) showToast('当前浏览器使用兼容文件读取，CSV 仍在后台解析');
    if (table.encoding === 'gbk') showToast('检测到 GBK 编码，已自动转码');
    const dname = { '': '单列', ',': '逗号', '\t': '制表符', ';': '分号', '|': '竖线' }[table.delimiter];
    setData(table.headers, table.rows, name,
      '已加载 ' + table.rows.length + ' 行 · 分隔符：' + dname + importWarning(table.stats), table.stats,
      operation.job);
  }

  // ---- 加载 XLSX（ZIP/XML 解压解析均在后台执行）----
  async function loadXLSXFile(file, fileName, operation) {
    updateProgress(0.05, '正在后台读取并解析 Excel');
    operation.job = DCWorker.run('parseXLSX', { file }, progress => {
      if (state.operation === operation) updateProgress(progress, '正在后台解析 Excel');
    });
    const wb = await operation.job.promise;
    if (state.operation !== operation) return;
    if (operation.job.fileReadFallback) showToast('当前浏览器使用兼容文件读取，Excel 仍在后台解析');
    if (wb.sheets.length === 1) {
      const s = wb.sheets[0];
      setData(s.headers, s.rows, fileName,
        '已加载 ' + s.rows.length + ' 行（工作表：' + s.name + '）' + importWarning(s.stats), s.stats,
        operation.job);
    } else {
      pickSheet(wb.sheets, fileName);
    }
  }

  // 多工作表时让用户选
  function pickSheet(sheets, fileName) {
    const body = el('div');
    body.appendChild(el('p', { class: 'hint' }, '该工作簿包含 ' + sheets.length + ' 个工作表，请选择要导入的一个：'));
    sheets.forEach(s => {
      const b = el('button', { class: 'btn' },
        s.name + '（' + s.rows.length + ' 行 × ' + s.headers.length + ' 列）');
      b.style.cssText = 'display:block;width:100%;margin:6px 0;text-align:left;';
      b.addEventListener('click', () => {
        closeModal();
        setData(s.headers, s.rows, fileName,
          '已加载 ' + s.rows.length + ' 行（工作表：' + s.name + '）' + importWarning(s.stats), s.stats);
      });
      body.appendChild(b);
    });
    openModal('📑 选择工作表', body);
  }

  // ---- 按扩展名分派 ----
  async function loadAnyFile(file) {
    if (/\.xls$/i.test(file.name)) {
      showToast('旧版 .xls 二进制格式不支持，请在 Excel 中另存为 .xlsx 或 CSV', 'err');
      return;
    }
    const operation = startOperation('import');
    try {
      if (/\.xlsx$/i.test(file.name)) {
        await loadXLSXFile(file, file.name, operation);
      } else {
        const selected = $('csv-delimiter').value;
        const delim = selected === 'auto' ? 'auto' : selected === 'tab' ? '\t' : selected === 'single' ? '' : selected;
        await loadCSVFile(file, file.name, delim, operation);
      }
    } catch (e) {
      if (state.operation === operation && e.name !== 'AbortError') {
        showToast((/\.xlsx$/i.test(file.name) ? 'XLSX 解析失败：' : '文件读取或解析失败：') + e.message, 'err');
      }
    } finally {
      finishOperation(operation);
    }
  }

  function parseCSVLine(line) {
    return DCIO.parseDelimited(line, ',')[0] || [];
  }

  function getViewData() {
    return state.previewResult || { headers: state.headers, rows: state.rows };
  }

  function getViewResult() {
    return state.previewResult || state.lastResult;
  }

  function invalidatePreview() {
    state.previewResult = null;
    state.lastResult = null;
  }

  function previewSummary(result) {
    const changed = result.changed ? result.changed.size : 0;
    const affected = new Set(result.affectedColumns || []);
    if (!result.affectedColumns && result.changed) {
      result.changed.forEach(key => affected.add(Number(key.split(':')[1])));
    }
    const added = Math.max(0, result.rows.length - state.sourceRows.length);
    const deleted = Math.max(0, state.sourceRows.length - result.rows.length);
    const names = [...affected].filter(j => j >= 0 && j < result.headers.length).map(j => result.headers[j]);
    return '预览：修改 ' + changed + ' 个单元格 · 新增 ' + added + ' 行 · 删除 ' + deleted + ' 行'
      + (names.length ? ' · 影响列：' + names.slice(0, 8).join('、') : ' · 含结构性变更');
  }

  function renderPreviewBar() {
    const bar = $('preview-bar');
    if (!bar) return;
    bar.hidden = !state.previewResult;
    if (state.previewResult) $('preview-summary').textContent = previewSummary(state.previewResult) + '（尚未提交）';
    $('btn-apply').disabled = !!state.operation || !state.previewResult;
  }

  // ---- 渲染数据表 ----
  // ---- 渲染表格（分页：解决「只看得到前 100 行」）----
  const PAGE_SIZE = 100;

  function renderTable(headers, rows, changed) {
    const wrap = $('table-wrap');
    wrap.innerHTML = '';
    if (!headers || !headers.length) {
      wrap.appendChild(el('div', { class: 'empty-tip' }, '暂无数据。请点击「加载示例」或上传 CSV / Excel 文件。'));
      return;
    }
    const total = rows.length;
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    // 数据变少时把页码夹回合法范围
    if (state.page >= pageCount) state.page = pageCount - 1;
    if (state.page < 0) state.page = 0;
    const start = state.page * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, total);

    const tbl = el('table', { class: 'data-table' });
    const thead = el('thead');
    const trh = el('tr');
    trh.appendChild(el('th', null, '#'));
    headers.forEach((h) => trh.appendChild(el('th', null, h || '(未命名)')));
    thead.appendChild(trh);
    tbl.appendChild(thead);

    const tbody = el('tbody');
    for (let i = start; i < end; i++) {
      const r = rows[i];
      const tr = el('tr');
      tr.appendChild(el('td', { class: 'row-num' }, String(i + 1)));  // 显示全局行号
      for (let j = 0; j < headers.length; j++) {
        const v = r[j];
        const td = el('td', null, v === null || v === undefined ? '' : String(v));
        // changed 的 key 用的是全局行索引，分页后仍能正确高亮
        if (changed && changed.has(i + ':' + j)) td.classList.add('changed');
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);

    if (total > PAGE_SIZE) wrap.appendChild(buildPager(total, pageCount, start, end));
  }

  function buildPager(total, pageCount, start, end) {
    const bar = el('div', { class: 'pager' });
    const go = (p) => {
      state.page = Math.min(Math.max(0, p), pageCount - 1);
      const view = getViewData(), result = getViewResult();
      renderTable(view.headers, view.rows, result ? result.changed : null);
    };
    const mk = (label, target, disabled, title) => {
      const b = el('button', { class: 'btn-mini', title: title || label }, label);
      if (disabled) b.disabled = true;
      else b.addEventListener('click', () => go(target));
      return b;
    };
    bar.appendChild(mk('« 首页', 0, state.page === 0));
    bar.appendChild(mk('‹ 上页', state.page - 1, state.page === 0));
    bar.appendChild(el('span', { class: 'pager-info' },
      '第 ' + (start + 1) + '–' + end + ' 行 / 共 ' + total + ' 行'
      + '（第 ' + (state.page + 1) + '/' + pageCount + ' 页）'));
    bar.appendChild(mk('下页 ›', state.page + 1, state.page >= pageCount - 1));
    bar.appendChild(mk('末页 »', pageCount - 1, state.page >= pageCount - 1));

    // 跳页输入框：大表时逐页点太慢
    const jump = el('input', {
      type: 'number', class: 'pager-jump', min: '1', max: String(pageCount),
      placeholder: '页码', title: '输入页码后回车跳转',
    });
    jump.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const n = parseInt(jump.value, 10);
      if (isFinite(n) && n >= 1 && n <= pageCount) go(n - 1);
      else showToast('请输入 1–' + pageCount + ' 之间的页码', 'err');
    });
    bar.appendChild(jump);
    return bar;
  }

  // ---- 渲染规则流水线 ----
  function renderRules() {
    const list = $('rules-list');
    list.innerHTML = '';
    R.RULES.forEach(rule => {
      const card = el('div', { class: 'rule-card', 'data-rule': rule.id });
      const ar = state.activeRules.find(a => a.ruleId === rule.id);
      const enabled = ar ? ar.enabled : false;
      const head = el('div', { class: 'rule-head' },
        el('span', { class: 'rule-name' }, (enabled ? '● ' : '○ ') + rule.name),
        el('span', { class: 'rule-desc' }, rule.desc),
      );
      const actions = el('div', { class: 'rule-actions' });
      const tog = el('button', { class: 'btn-mini ' + (enabled ? 'on' : '') }, enabled ? '已启用' : '已停用');
      tog.addEventListener('click', () => {
        toggleRule(rule.id);
      });
      actions.appendChild(tog);
      if (rule.id !== 'ai' && enabled) {
        const cfg = el('button', { class: 'btn-mini' }, '⚙ 配置');
        cfg.addEventListener('click', () => openRuleConfig(rule.id));
        actions.appendChild(cfg);
      }
      if (rule.id === 'ai' && enabled) {
        const view = el('button', { class: 'btn-mini' }, '👁 查看步骤');
        view.addEventListener('click', () => {
          if (state.aiLastSteps && state.aiLastSteps.length) {
            showAISteps(state.aiLastSteps, state.aiLastAnalysis);
          } else {
            showToast('还没有 AI 步骤，请先用上方输入指令生成', 'err');
          }
        });
        actions.appendChild(view);
      }
      head.appendChild(actions);
      card.appendChild(head);

      if (rule.id === 'ai' && enabled && state.aiLastSteps && state.aiLastSteps.length) {
        const stWrap = el('div', { class: 'ai-steps-inline' });
        stWrap.appendChild(el('div', { class: 'ai-step-hint' }, 'AI 步骤：'));
        state.aiLastSteps.forEach((s, idx) => {
          stWrap.appendChild(el('div', { class: 'ai-step-item' }, (idx + 1) + '. [' + s.type + '] ' + (s.description || (s.column || ''))));
        });
        card.appendChild(stWrap);
      }

      list.appendChild(card);
    });
  }

  function toggleRule(ruleId) {
    cancelOperation(false);
    if (ruleId === 'ai') {
      toggleAIRule();
      return;
    }
    const def = R.RULES.find(r => r.id === ruleId);
    if (!def) return;
    let ar = state.activeRules.find(a => a.ruleId === ruleId);
    if (!ar) {
      ar = { ruleId, enabled: true, opts: defaultOptsFor(ruleId) };
      state.activeRules.push(ar);
    } else {
      ar.enabled = !ar.enabled;
    }
    invalidatePreview();
    renderAll();
  }

  function defaultOptsFor(ruleId) {
    switch (ruleId) {
      case 'empty': return { mode: 'rows' };
      case 'missing': return { tokens: ['N/A', 'NA', 'NULL', '-'], replacement: '', targets: [], includeBlank: false, caseSensitive: false };
      case 'fill': return { strategy: 'forward', customVal: '' };
      case 'text': return { trim: true, removeSpecial: false, caseMode: 'none' };
      case 'replace': return { find: '', replaceWith: '' };
      case 'conditional': return { column: '', targetColumn: '', operator: 'equals', value: '', replaceWith: '', caseSensitive: false };
      case 'split': return { colIdx: -1, sep: ',', maxParts: 3 };
      case 'merge': return { columns: [], separator: ' ', newName: '合并列', keepOriginal: true, skipEmpty: true };
      case 'date': return { targets: [] };
      case 'number': return { strip: true, phone: false, targets: [] };
      case 'cols': return { keep: [] };
      case 'filter': return { column: '', operator: 'contains', value: '', action: 'keep', caseSensitive: false };
      case 'remove': return { keys: [] };
      case 'ai': return { steps: [] };
      default: return {};
    }
  }

  // ---- 从不可变输入生成预览；只有“应用清洗”才提交结果 ----
  async function runPipeline() {
    if (!state.sourceHeaders.length) { showToast('请先加载数据', 'err'); return; }
    if (!state.activeRules.some(a => a.enabled)) { showToast('请至少启用一个规则', 'err'); return; }
    const operation = startOperation('pipeline');
    const aiRule = state.activeRules.find(a => a.ruleId === 'ai');
    if (aiRule && aiRule.enabled) {
      aiRule.opts = aiRule.opts || {};
      aiRule.opts.steps = state.aiLastSteps || [];
    }
    const active = state.activeRules.filter(a => a.enabled);
    try {
      operation.job = DCWorker.run('pipeline', {
        activeRules: active, headers: state.sourceHeaders, rows: state.sourceRows,
        sourceJob: state.sourceWorkerJob,
      }, (progress, id) => {
        if (state.operation === operation) updateProgress(progress, id);
      });
      const result = await operation.job.promise;
      if (state.operation !== operation) return;
      state.previewResult = result;
      state.lastResult = null;
      state.page = 0;
      state.qualitySource = { headers: result.headers, rows: result.rows, job: operation.job };
      renderAll();
      const modified = result.changed ? result.changed.size : 0;
      showToast('清洗预览完成 · 修改 ' + modified + ' 处 · 请确认后应用'
        + (operation.job.fallbackReason ? ' · 已使用兼容模式' : ''));
    } catch (e) {
      if (state.operation === operation && e.name !== 'AbortError') {
        showToast('执行失败：' + e.message + '（原数据未修改）', 'err');
      }
    } finally {
      finishOperation(operation);
    }
  }

  function pushHistory() {
    state.history.push({
      // 表数据不可原地修改，历史快照可共享引用；规则配置仍需独立深拷贝。
      headers: state.headers,
      rows: state.rows,
      activeRules: JSON.parse(JSON.stringify(state.activeRules)),
      aiLastSteps: state.aiLastSteps ? JSON.parse(JSON.stringify(state.aiLastSteps)) : null,
    });
    if (state.history.length > 20) state.history.shift();
  }

  function applyPreview() {
    if (!state.previewResult) { showToast('没有待应用的预览', 'err'); return; }
    pushHistory();
    const result = state.previewResult;
    state.headers = result.headers;
    state.rows = result.rows;
    state.lastResult = result;
    state.previewResult = null;
    renderAll();
    showToast('已应用清洗结果 · 可从原始数据继续调整规则并重新预览');
  }

  function cancelPreview(notify) {
    if (!state.previewResult) return false;
    state.previewResult = null;
    state.lastResult = null;
    renderAll();
    if (notify !== false) showToast('已取消预览，已提交数据未改变');
    return true;
  }

  function updateProgress(p, id) {
    const bar = $('progress-bar');
    if (bar) bar.style.width = (p * 100).toFixed(1) + '%';
    const tip = $('progress-tip');
    if (tip) tip.textContent = id === '就绪' || id === '已取消'
      ? id : '执行中：' + id + ' (' + (p * 100).toFixed(0) + '%)';
  }

  function undo() {
    if (cancelPreview(false)) { showToast('已撤销预览'); return; }
    if (!state.history.length) { showToast('没有可撤销的操作', 'err'); return; }
    const prev = state.history.pop();
    state.headers = prev.headers;
    state.rows = prev.rows;
    state.activeRules = prev.activeRules;
    state.aiLastSteps = prev.aiLastSteps || null;
    state.lastResult = null;
    state.previewResult = null;
    renderAll();
    showToast('已撤销上一次已应用的清洗');
  }

  function showPreviewDiff() {
    const result = state.previewResult;
    if (!result) { showToast('没有待查看的预览', 'err'); return; }
    const body = el('div');
    body.appendChild(el('p', { class: 'report-summary' }, previewSummary(result)));
    body.appendChild(el('p', { class: 'hint' },
      '修改单元格按每页 100 条异步加载，可翻页查看全部。删除行或增删列后，位置可能变化，请结合日志核对。'));
    const total = result.changed ? result.changed.size : 0;
    const sourceHeaders = state.sourceHeaders, sourceRows = state.sourceRows;
    const sameRowCount = sourceRows.length === result.rows.length;
    const recent = state.qualitySource;
    const sourceJob = recent && recent.headers === result.headers && recent.rows === result.rows ? recent.job : null;
    if (!total) {
      body.appendChild(el('p', null, '本预览没有可逐格展示的值修改，请查看下方结构日志。'));
    } else {
      const status = el('p', { class: 'hint preview-diff-status' }, '正在加载差异…');
      const tableHost = el('div', { class: 'preview-diff-rows' });
      const info = el('span', { class: 'pager-info preview-diff-page-info' });
      const first = el('button', { class: 'btn-mini' }, '首页');
      const previous = el('button', { class: 'btn-mini' }, '上页');
      const next = el('button', { class: 'btn-mini' }, '下页');
      const last = el('button', { class: 'btn-mini' }, '末页');
      const jump = el('input', { class: 'pager-jump preview-diff-jump', type: 'number', min: '1', 'aria-label': '差异页码' });
      const pager = el('div', { class: 'pager preview-diff-pager' }, first, previous, info, next, last, jump);
      body.appendChild(status);
      body.appendChild(tableHost);
      body.appendChild(pager);
      let page = 0, totalPages = Math.max(1, Math.ceil(total / 100)), version = 0, loading = false;
      const updateButtons = () => {
        first.disabled = previous.disabled = loading || page <= 0;
        next.disabled = last.disabled = loading || page >= totalPages - 1;
        jump.max = String(totalPages);
        jump.value = String(page + 1);
      };
      const loadPage = async requested => {
        page = Math.max(0, Math.min(totalPages - 1, Math.floor(Number(requested) || 0)));
        const currentVersion = ++version;
        loading = true;
        status.textContent = '正在后台读取第 ' + (page + 1) + ' 页差异…';
        updateButtons();
        try {
          const job = DCWorker.run('diff', { result, sourceJob, offset: page * 100, limit: 100 });
          const data = await job.promise;
          if (currentVersion !== version || !$('modal-body').contains(body) || !$('modal').classList.contains('open')) return;
          totalPages = Math.max(1, Math.ceil(data.total / 100));
          const table = el('table', { class: 'preview-diff-table' });
          const head = el('tr');
          ['结果数据行', '列', '修改前', '修改后'].forEach(text => head.appendChild(el('th', null, text)));
          table.appendChild(head);
          data.entries.forEach(entry => {
            const sourceCol = sourceHeaders.indexOf(entry.header);
            const before = sameRowCount && sourceRows[entry.row] && sourceCol >= 0
              ? sourceRows[entry.row][sourceCol] : '（结构变化，无法按位置对应）';
            const tr = el('tr');
            tr.appendChild(el('td', null, entry.row + 1));
            tr.appendChild(el('td', null, entry.header));
            tr.appendChild(el('td', { class: 'preview-diff-before' }, before == null ? '' : String(before)));
            tr.appendChild(el('td', { class: 'preview-diff-after' }, entry.after));
            table.appendChild(tr);
          });
          tableHost.innerHTML = '';
          tableHost.appendChild(table);
          const start = page * 100 + 1, end = Math.min((page + 1) * 100, data.total);
          info.textContent = '第 ' + (page + 1) + '/' + totalPages + ' 页 · ' + start + '–' + end + ' / ' + data.total + ' 处';
          status.textContent = '本页 ' + data.entries.length + ' 条；仅渲染当前页，全部修改均可通过分页查看。';
        } catch (error) {
          if (currentVersion === version) status.textContent = '差异加载失败：' + error.message;
        } finally {
          if (currentVersion === version) { loading = false; updateButtons(); }
        }
      };
      first.addEventListener('click', () => loadPage(0));
      previous.addEventListener('click', () => loadPage(page - 1));
      next.addEventListener('click', () => loadPage(page + 1));
      last.addEventListener('click', () => loadPage(totalPages - 1));
      jump.addEventListener('keydown', event => {
        if (event.key === 'Enter') loadPage(Math.max(1, Number(jump.value) || 1) - 1);
      });
      updateButtons();
      setTimeout(() => loadPage(0), 0);
    }
    body.appendChild(el('h3', null, '执行日志'));
    const logs = el('div', { class: 'ai-log' });
    (result.log || []).forEach(line => logs.appendChild(el('div', { class: 'log-line' }, line)));
    body.appendChild(logs);
    openModal('清洗前后差异（未提交）', body);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function exportAuditReport() {
    const view = getViewData();
    if (!view.headers.length) { showToast('请先加载数据', 'err'); return; }
    let profile;
    try { profile = await ensureQualityProfile(view); }
    catch (error) {
      if (error.name !== 'AbortError') showToast('审计报告生成失败：' + error.message, 'err');
      return;
    }
    const current = getViewData();
    if (current.headers !== view.headers || current.rows !== view.rows) {
      showToast('数据已变化，请重新生成审计报告', 'err');
      return;
    }
    const result = getViewResult();
    const rules = JSON.parse(JSON.stringify(state.activeRules));
    const aiRule = rules.find(rule => rule.ruleId === 'ai');
    if (aiRule) aiRule.opts = Object.assign({}, aiRule.opts, { steps: state.aiLastSteps || [] });
    const status = state.previewResult ? '预览未提交' : state.lastResult ? '已应用清洗' : '原始/已提交数据';
    const columnRows = profile.columns.map(col => '<tr><td>' + escapeHtml(col.column) + '</td><td>'
      + escapeHtml(col.typeName) + '</td><td>' + col.missingCount + ' (' + (col.missingRate * 100).toFixed(1)
      + '%)</td><td>' + col.uniqueCount + '</td><td>' + col.invalidCount + '</td></tr>').join('');
    const issueItems = profile.issues.map(issue => '<li>' + escapeHtml(issue.message) + '</li>').join('')
      || '<li>未发现内置检查项的问题</li>';
    const logItems = (result && result.log ? result.log : []).map(line => '<li>' + escapeHtml(line) + '</li>').join('')
      || '<li>暂无执行日志</li>';
    const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>DataCleaner 审计报告</title>'
      + '<style>body{font:14px/1.6 sans-serif;max-width:1100px;margin:32px auto;padding:0 20px;color:#172033}'
      + 'table{border-collapse:collapse;width:100%}th,td{border:1px solid #cbd5e1;padding:7px;text-align:left}'
      + 'pre{white-space:pre-wrap;background:#f1f5f9;padding:12px;border-radius:8px}.meta{color:#64748b}</style></head><body>'
      + '<h1>DataCleaner Pro 本地清洗审计报告</h1><p class="meta">生成时间：' + escapeHtml(new Date().toISOString())
      + '<br>文件：' + escapeHtml(state.fileName) + '<br>状态：' + status + '<br>原始数据：'
      + state.sourceRows.length + ' 行 × ' + state.sourceHeaders.length + ' 列；当前视图：' + view.rows.length + ' 行 × '
      + view.headers.length + ' 列。报告不包含完整数据内容。</p><h2>清洗步骤（预设格式 v2）</h2><pre>'
      + escapeHtml(JSON.stringify({ version: 2, rules }, null, 2)) + '</pre><h2>质量摘要</h2><p>重复行：'
      + profile.summary.duplicateRows + '；问题类别：' + profile.issues.length + '</p><ul>' + issueItems
      + '</ul><h2>逐列画像</h2><table><tr><th>列</th><th>类型</th><th>缺失</th><th>唯一值</th><th>格式异常</th></tr>'
      + columnRows + '</table><h2>操作日志</h2><ul>' + logItems + '</ul></body></html>';
    const base = (state.fileName || 'data.csv').replace(/\.[^.]+$/, '');
    downloadText(html, 'cleaned_report_' + base + '.html', 'text/html;charset=utf-8');
    showToast('已导出清洗步骤、质量报告与操作日志');
  }

  // ---- AI 设置 ----
  function openAISettings() {
    const modal = $('modal');
    const body = $('modal-body');
    body.innerHTML = '';
    const cfg = JSON.parse(localStorage.getItem('dc_ai_config') || '{}');
    const curProvider = cfg.provider || 'mock';
    const curKey = cfg.apiKey || '';
    const curBase = cfg.baseUrl || '';
    const curModel = cfg.model || '';

    const wrap = el('div', { class: 'ai-settings' });
    wrap.appendChild(el('h3', null, '⚙ AI 设置'));
    wrap.appendChild(el('p', { class: 'hint' }, '选择 AI 提供方。DeepSeek V3 中文效果最好，注册送 500 万 tokens。'));

    const provSel = el('select', { class: 'input' });
    Object.keys(AI.PROVIDERS).forEach(k => {
      const opt = el('option', { value: k }, AI.PROVIDERS[k].label);
      if (k === curProvider) opt.selected = true;
      provSel.appendChild(opt);
    });
    wrap.appendChild(el('label', null, 'AI 提供方：'));
    wrap.appendChild(provSel);

    const baseInp = el('input', { class: 'input', placeholder: '（仅自定义时填写）例如 https://api.deepseek.com/v1' });
    baseInp.value = curBase;
    wrap.appendChild(el('label', null, 'API Base URL（自定义时）：'));
    wrap.appendChild(baseInp);

    const modelInp = el('input', { class: 'input', placeholder: '（自定义时填写）例如 deepseek-chat' });
    modelInp.value = curModel;
    wrap.appendChild(el('label', null, '模型名（自定义时）：'));
    wrap.appendChild(modelInp);

    const keyInp = el('input', { class: 'input', type: 'password', placeholder: AI.PROVIDERS[curProvider].keyPlaceholder });
    keyInp.value = curKey;
    wrap.appendChild(el('label', null, 'API Key：'));
    wrap.appendChild(keyInp);

    const hint = el('p', { class: 'hint small' }, '提示：选择"本地模拟"无需 Key，可直接体验。');
    wrap.appendChild(hint);

    const btnRow = el('div', { class: 'btn-row' });
    const saveBtn = el('button', { class: 'btn primary' }, '保存');
    saveBtn.addEventListener('click', () => {
      const newCfg = {
        provider: provSel.value,
        apiKey: keyInp.value.trim(),
        baseUrl: baseInp.value.trim(),
        model: modelInp.value.trim(),
      };
      localStorage.setItem('dc_ai_config', JSON.stringify(newCfg));
      // 同步到 custom provider
      if (newCfg.provider === 'custom' && newCfg.baseUrl) {
        AI.PROVIDERS.custom.baseUrl = newCfg.baseUrl;
        AI.PROVIDERS.custom.model = newCfg.model || 'gpt-3.5-turbo';
      }
      showToast('已保存');
      closeModal();
    });
    btnRow.appendChild(saveBtn);
    const cancelBtn = el('button', { class: 'btn' }, '取消');
    cancelBtn.addEventListener('click', closeModal);
    btnRow.appendChild(cancelBtn);
    wrap.appendChild(btnRow);

    provSel.addEventListener('change', () => {
      keyInp.placeholder = AI.PROVIDERS[provSel.value].keyPlaceholder;
    });

    body.appendChild(wrap);
    modal.classList.add('open');
  }

  function closeModal() {
    $('modal').classList.remove('open');
    // 多工作表按钮闭包会引用整份工作簿；关闭即释放，而不是留在隐藏弹窗中。
    $('modal-body').innerHTML = '';
    renderAll();
  }

  // 统一打开弹窗（标题 + 内容节点）
  function openModal(title, node) {
    const body = $('modal-body');
    body.innerHTML = '';
    if (title) body.appendChild(el('h3', null, title));
    if (node) body.appendChild(node);
    $('modal').classList.add('open');
  }

  // ---- AI 智能清洗：自然语言 → 流式 → 确认 ----
  let currentAbort = null;

  async function sendAI() {
    const inp = $('ai-input');
    const text = inp.value.trim();
    if (!text) { showToast('请输入清洗指令', 'err'); return; }
    if (!state.headers.length) { showToast('请先加载数据', 'err'); return; }

    const cfg = JSON.parse(localStorage.getItem('dc_ai_config') || '{}');
    const provider = cfg.provider || 'mock';
    const apiKey = cfg.apiKey || '';

    // 推入对话历史
    state.aiConversation.push({ role: 'user', content: text });

    const panel = $('ai-response');
    panel.classList.add('active');
    const msgEl = el('div', { class: 'ai-msg user' }, '你：' + text);
    const replyEl = el('div', { class: 'ai-msg bot' });
    replyEl.appendChild(el('div', { class: 'typing' }, '▌ 思考中...'));
    panel.appendChild(msgEl);
    panel.appendChild(replyEl);
    panel.scrollTop = panel.scrollHeight;

    const btnSend = $('ai-send');
    const btnStop = $('ai-stop');
    btnSend.style.display = 'none';
    btnStop.style.display = 'inline-block';

    if (currentAbort) currentAbort.abort();
    currentAbort = new AbortController();

    let fullText = '';
    let parsedResult = null;
    try {
      const result = await AI.chat({
        provider,
        apiKey,
        instruction: text,
        headers: state.headers,
        sampleRows: state.rows,
        conversation: state.aiConversation.slice(0, -1),  // 已包含上面的 user，最后一条会再被加入
        signal: currentAbort.signal,
        onChunk: (acc, done) => {
          fullText = acc;
          replyEl.innerHTML = AI.renderMarkdown(acc);
        },
        onProgress: (rep) => {
          const txt = rep && rep.text ? rep.text : '下载中';
          replyEl.innerHTML = '<div class="loading">📦 加载本地模型：' + txt + '</div>';
        },
      });
      parsedResult = result.parsed;

      // 修复渲染（确保最后状态）
      replyEl.innerHTML = AI.renderMarkdown(result.fullText);
      state.aiConversation.push({ role: 'assistant', content: result.fullText });

      // 显示生成的步骤 + 一键应用按钮
      // 注意：只暂存待确认步骤，不直接改 aiLastSteps（否则多轮合并会丢历史）
      if (parsedResult && parsedResult.steps && parsedResult.steps.length) {
        state.aiPendingSteps = parsedResult.steps;
        showAIStepsInPanel(parsedResult, replyEl);
      } else {
        const tip = el('div', { class: 'ai-no-steps' }, '⚠ 未能生成可执行的步骤，请调整指令。');
        replyEl.appendChild(tip);
        if (parsedResult && parsedResult.errors) parsedResult.errors.forEach(error => {
          replyEl.appendChild(el('div', { class: 'ai-err' }, '已拒绝：' + error));
        });
      }
    } catch (e) {
      replyEl.innerHTML = '';
      replyEl.appendChild(el('div', { class: 'ai-err' }, '❌ ' + e.message));
    } finally {
      btnSend.style.display = 'inline-block';
      btnStop.style.display = 'none';
    }
  }

  function stopAI() {
    if (currentAbort) { currentAbort.abort(); currentAbort = null; }
    showToast('已停止');
  }

  function showAIStepsInPanel(parsed, container) {
    const box = el('div', { class: 'ai-step-box' });
    if (parsed.errors && parsed.errors.length) {
      parsed.errors.forEach(error => box.appendChild(el('div', { class: 'ai-err' }, '已忽略无效步骤：' + error)));
    }
    box.appendChild(el('div', { class: 'ai-step-title' }, '📋 生成的清洗步骤（' + parsed.steps.length + ' 步）：'));
    const ul = el('ol', { class: 'ai-step-list' });
    parsed.steps.forEach((s, i) => {
      ul.appendChild(el('li', null, '[' + s.type + '] ' + (s.description || describeStep(s))));
    });
    box.appendChild(ul);
    const btnRow = el('div', { class: 'ai-step-btns' });
    const applyBtn = el('button', { class: 'btn primary' }, '✓ 一键应用到流水线');
    applyBtn.addEventListener('click', () => applyAIStepsToPipeline(parsed));
    const reBtn = el('button', { class: 'btn' }, '↻ 重新生成');
    reBtn.addEventListener('click', () => $('ai-send').click());
    btnRow.appendChild(applyBtn);
    btnRow.appendChild(reBtn);
    box.appendChild(btnRow);
    container.appendChild(box);
  }

  function describeStep(s) {
    const parts = [];
    if (s.column) parts.push('列：' + s.column);
    if (s.target_format) parts.push('格式：' + s.target_format);
    if (s.pattern) parts.push('模式：' + s.pattern);
    if (s.value !== undefined) parts.push('填充值：' + s.value);
    if (s.new_name) parts.push('新名：' + s.new_name);
    if (s.separator) parts.push('分隔符：' + s.separator);
    if (s.formula) parts.push('公式：' + s.formula);
    return parts.join(' · ');
  }

  function applyAIStepsToPipeline(parsed) {
    cancelOperation(false);
    const checked = AI.validateAISteps(parsed.steps || [], state.sourceHeaders);
    if (checked.errors.length) showToast('已忽略 ' + checked.errors.length + ' 个无效步骤：' + checked.errors[0], 'err');
    if (!checked.steps.length && !(parsed.steps || []).length) { showToast('没有可应用的 AI 步骤', 'err'); return; }
    if (!checked.steps.length) return;
    // 合并策略：同列同类型的步骤覆盖旧的，其余追加（多轮对话不丢历史步骤）
    const merged = (state.aiLastSteps || []).slice();
    checked.steps.forEach(ns => {
      const i = merged.findIndex(os => os.type === ns.type && String(os.column || '') === String(ns.column || ''));
      if (i >= 0) merged[i] = ns;
      else merged.push(ns);
    });

    // 启用 AI 规则
    let aiRule = state.activeRules.find(a => a.ruleId === 'ai');
    if (!aiRule) {
      aiRule = { ruleId: 'ai', enabled: true, opts: { steps: merged } };
      state.activeRules.push(aiRule);
    } else {
      aiRule.enabled = true;
      aiRule.opts = { steps: merged };
    }
    state.aiLastSteps = merged;
    state.aiLastAnalysis = parsed.analysis;
    invalidatePreview();
    renderAll();
    showToast('AI 步骤已加入流水线 ✓ 当前共 ' + merged.length + ' 步，请执行预览');
  }

  function showAISteps(steps, analysis) {
    const modal = $('modal');
    const body = $('modal-body');
    body.innerHTML = '';
    const box = el('div', { class: 'ai-step-box' });
    if (analysis) box.appendChild(el('div', { class: 'ai-analysis' }, '分析：' + analysis));
    box.appendChild(el('h3', null, '📋 AI 步骤（共 ' + steps.length + ' 步）'));
    const ol = el('ol', { class: 'ai-step-list' });
    steps.forEach(s => ol.appendChild(el('li', null, '[' + s.type + '] ' + (s.description || describeStep(s)))));
    box.appendChild(ol);
    const closeBtn = el('button', { class: 'btn' }, '关闭');
    closeBtn.addEventListener('click', closeModal);
    box.appendChild(closeBtn);
    body.appendChild(box);
    modal.classList.add('open');
  }

  function toggleAIRule() {
    let ar = state.activeRules.find(a => a.ruleId === 'ai');
    if (!ar) {
      ar = { ruleId: 'ai', enabled: true, opts: { steps: state.aiLastSteps || [] } };
      state.activeRules.push(ar);
    } else {
      ar.enabled = !ar.enabled;
    }
    invalidatePreview();
    renderAll();
  }

  // ---- 自动修复建议 ----
  function buildQualityProfileTable(profile) {
    const table = el('table', { class: 'quality-profile-table' });
    const head = el('tr');
    ['列', '推断类型', '缺失', '唯一值', '格式异常'].forEach(h => head.appendChild(el('th', null, h)));
    table.appendChild(head);
    profile.columns.forEach(col => {
      const tr = el('tr');
      [col.column, col.typeName, col.missingCount + '（' + (col.missingRate * 100).toFixed(1) + '%）',
        col.uniqueCount, col.invalidCount].forEach(value => tr.appendChild(el('td', null, value)));
      table.appendChild(tr);
    });
    return table;
  }

  async function suggestAutoFix() {
    const view = getViewData();
    if (!view.headers.length) { showToast('请先加载数据', 'err'); return; }
    let profile;
    try { profile = await ensureQualityProfile(view); }
    catch (error) {
      if (error.name !== 'AbortError') showToast('质量分析失败：' + error.message, 'err');
      return;
    }
    const current = getViewData();
    if (current.headers !== view.headers || current.rows !== view.rows) {
      showToast('数据已变化，请重新分析', 'err');
      return;
    }
    const issues = profile.issues;
    const modal = $('modal'), body = $('modal-body');
    body.innerHTML = '';
    const box = el('div', { class: 'suggest-box' });
    box.appendChild(el('h3', null, '🔍 数据质量分析'));
    box.appendChild(el('p', { class: 'report-summary' },
      view.rows.length + ' 行 × ' + view.headers.length + ' 列 · ' + profile.summary.duplicateRows + ' 行重复 · '
      + issues.length + ' 类问题。行号为不含表头的数据行号。'));
    if (issues.length) {
      const ul = el('ul', { class: 'suggest-list' });
      issues.forEach(iss => ul.appendChild(el('li', null, iss.message)));
      box.appendChild(ul);
    } else box.appendChild(el('p', { class: 'quality-ok' }, '✨ 未发现内置检查项的问题'));
    box.appendChild(el('h3', null, '逐列画像'));
    box.appendChild(buildQualityProfileTable(profile));

    const steps = [];
    issues.forEach(iss => {
      if (iss.type === 'duplicates') {
        steps.push({ type: 'remove_duplicates', description: '删除完全重复的行' });
      } else if (iss.type === 'missing' && iss.columnType === 'number') {
        steps.push({ type: 'fill_empty', column: iss.column, strategy: 'mean', description: '用列均值填充 ' + iss.column + '（可修改）' });
      } else if (iss.type === 'missing' && ['text', 'empty'].includes(iss.columnType)) {
        steps.push({ type: 'fill_empty', column: iss.column, strategy: 'custom', value: '未知', description: '填充文本列 ' + iss.column });
      } else if (iss.type === 'date_inconsistent') {
        steps.push({ type: 'normalize_date', column: iss.column, target_format: 'YYYY-MM-DD', description: '统一 ' + iss.column + ' 格式（无效日期保留）' });
      }
    });
    box.appendChild(el('p', { class: 'hint' },
      '日期、邮箱、手机号格式错误和数值离群只报告，不自动改值；建议步骤仍需加入流水线并预览确认。'));
    if (steps.length) {
      box.appendChild(el('h3', null, '待确认的建议步骤'));
      const stepList = el('ol', { class: 'ai-step-list' });
      steps.forEach(step => stepList.appendChild(el('li', null, '[' + step.type + '] ' + step.description)));
      box.appendChild(stepList);
      const btn = el('button', { class: 'btn primary' }, '✓ 将安全建议加入流水线');
      btn.addEventListener('click', () => {
        applyAIStepsToPipeline({ steps, analysis: '根据质量报告生成 ' + steps.length + ' 个建议步骤' });
        closeModal();
      });
      box.appendChild(btn);
    }
    const closeBtn = el('button', { class: 'btn' }, '关闭');
    closeBtn.addEventListener('click', closeModal);
    box.appendChild(closeBtn);
    body.appendChild(box);
    modal.classList.add('open');
  }

  // ---- 渲染 AI 日志 ----
  function renderAILog() {
    const log = $('ai-log'), result = getViewResult();
    if (!log) return;
    if (!result || !result.log) {
      log.innerHTML = '<div class="log-empty">暂无日志</div>';
      return;
    }
    log.innerHTML = '';
    result.log.forEach(line => {
      log.appendChild(el('div', { class: 'log-line' }, line));
    });
  }

  // ---- 渲染质量分析（侧栏） ----
  function ensureQualityProfile(view) {
    const cached = state.qualityCache;
    if (cached && cached.headers === view.headers && cached.rows === view.rows) {
      return Promise.resolve(cached.profile);
    }
    if (state.qualityJob && state.qualityJob.headers === view.headers && state.qualityJob.rows === view.rows) {
      return state.qualityJob.job.promise;
    }
    cancelQualityJob();
    const source = state.qualitySource;
    const sourceJob = source && source.headers === view.headers && source.rows === view.rows ? source.job : null;
    const job = DCWorker.run('profile', { headers: view.headers, rows: view.rows, sourceJob });
    const entry = { headers: view.headers, rows: view.rows, job };
    state.qualityJob = entry;
    job.promise.then(profile => {
      if (state.qualityJob !== entry) return;
      state.qualityJob = null;
      state.qualityCache = { headers: view.headers, rows: view.rows, profile };
    }).catch(() => {
      if (state.qualityJob === entry) state.qualityJob = null;
    });
    return job.promise;
  }

  function drawQualityProfile(profile) {
    const box = $('quality-box'), issues = profile.issues;
    box.innerHTML = '';
    box.appendChild(el('h4', null, '🔍 数据质量'));
    box.appendChild(el('div', { class: 'report-summary' },
      profile.summary.duplicateRows + ' 行重复 · ' + profile.columns.reduce((n, c) => n + c.missingCount, 0) + ' 个空值 · ' + issues.length + ' 类提示'));
    if (issues.length) {
      const ul = el('ul', { class: 'q-list' });
      issues.slice(0, 6).forEach(iss => ul.appendChild(el('li', null, iss.message)));
      box.appendChild(ul);
      if (issues.length > 6) box.appendChild(el('div', { class: 'hint' }, '其余 ' + (issues.length - 6) + ' 项请查看完整分析'));
    } else box.appendChild(el('div', { class: 'quality-ok' }, '✨ 未发现内置检查项的问题'));
    const fixBtn = el('button', { class: 'btn-mini' }, '🔍 完整报告与安全建议');
    fixBtn.addEventListener('click', suggestAutoFix);
    box.appendChild(fixBtn);
  }

  function renderQuality() {
    const box = $('quality-box'), view = getViewData();
    if (!box) return;
    if (!view.headers.length) { box.innerHTML = ''; return; }
    const cached = state.qualityCache;
    if (cached && cached.headers === view.headers && cached.rows === view.rows) {
      drawQualityProfile(cached.profile);
      return;
    }
    box.innerHTML = '<div class="hint">⏳ 正在后台分析数据质量…</div>';
    ensureQualityProfile(view).then(profile => {
      const current = getViewData();
      if (current.headers === view.headers && current.rows === view.rows) drawQualityProfile(profile);
    }).catch(error => {
      const current = getViewData();
      if (error.name === 'AbortError' || current.headers !== view.headers || current.rows !== view.rows) return;
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'hint' }, '质量分析失败：' + error.message));
      const retry = el('button', { class: 'btn-mini' }, '重试');
      retry.addEventListener('click', renderQuality);
      box.appendChild(retry);
    });
  }

  // ---- 全部渲染 ----
  function renderAll() {
    const view = getViewData(), result = getViewResult();
    renderTable(view.headers, view.rows, result ? result.changed : null);
    renderRules();
    renderQuality();
    renderAILog();
    renderPreviewBar();
    updateFileInfo();
  }

  function resetAIPanel() {
    const panel = $('ai-response');
    if (panel) { panel.innerHTML = ''; panel.classList.remove('active'); }
  }

  function updateFileInfo() {
    const info = $('file-info');
    const view = getViewData();
    if (info) info.textContent = state.fileName
      ? (state.fileName + ' · ' + view.rows.length + ' 行 × ' + view.headers.length + ' 列' + (state.previewResult ? ' · 预览未提交' : ''))
      : '未加载数据';
  }

  // ============================================
  //  规则预设持久化（localStorage: dc_presets）
  //  与 dc_ai_config 相同的存储风格；支持 JSON 导出/导入以便分享
  // ============================================
  const PRESET_KEY = 'dc_presets';

  function loadPresets() {
    try {
      const raw = JSON.parse(localStorage.getItem(PRESET_KEY) || '{}');
      const list = Array.isArray(raw) ? raw : raw.presets;
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function savePresets(list) {
    try {
      localStorage.setItem(PRESET_KEY, DCIO.serializePresets(list));
      return true;
    } catch (e) {
      showToast('保存失败：浏览器存储空间不足或被禁用', 'err');
      return false;
    }
  }

  function renderPresetSelect(selectedName) {
    const sel = $('preset-select');
    if (!sel) return;
    const list = loadPresets();
    sel.innerHTML = '';
    sel.appendChild(el('option', { value: '' }, list.length ? '— 选择预设 —' : '— 暂无预设 —'));
    list.forEach(p => {
      sel.appendChild(el('option', { value: p.name }, p.name + '（' + p.rules.length + ' 条）'));
    });
    if (selectedName) sel.value = selectedName;
  }

  // 深拷贝当前规则配置，避免预设与运行时状态互相污染
  function snapshotRules() {
    return state.activeRules.map(a => {
      const opts = JSON.parse(JSON.stringify(a.opts || {}));
      if (a.ruleId === 'ai') opts.steps = JSON.parse(JSON.stringify(state.aiLastSteps || opts.steps || []));
      if (a.ruleId === 'split' && opts.column === undefined) {
        const index = Number(opts.colIdx);
        if (index >= 0 && index < state.sourceHeaders.length) opts.column = state.sourceHeaders[index];
      }
      return { ruleId: a.ruleId, enabled: !!a.enabled, opts };
    });
  }

  function savePresetPrompt() {
    const body = el('div');
    body.appendChild(el('p', { class: 'hint' },
      '将当前 ' + state.activeRules.length + ' 条规则配置保存为预设，下次可一键套用。'));
    const input = el('input', { type: 'text', class: 'text-input', placeholder: '预设名称，如「员工表清洗」' });
    input.value = state.fileName ? state.fileName.replace(/\.[^.]+$/, '') + ' 预设' : '我的预设';
    body.appendChild(input);
    const row = el('div', { class: 'modal-actions' });
    const ok = el('button', { class: 'btn primary' }, '保存');
    ok.addEventListener('click', () => {
      const name = input.value.trim();
      if (!name) { showToast('请输入预设名称', 'err'); return; }
      const list = loadPresets();
      const idx = list.findIndex(p => p.name === name);
      const item = { name: name, version: 2, headers: state.sourceHeaders.slice(), rules: snapshotRules(), savedAt: new Date().toISOString() };
      if (idx >= 0) list[idx] = item; else list.push(item);
      if (savePresets(list)) {
        renderPresetSelect(name);
        closeModal();
        showToast(idx >= 0 ? '已覆盖预设「' + name + '」' : '已保存预设「' + name + '」');
      }
    });
    row.appendChild(ok);
    const cancel = el('button', { class: 'btn' }, '取消');
    cancel.addEventListener('click', closeModal);
    row.appendChild(cancel);
    body.appendChild(row);
    openModal('💾 保存规则预设', body);
    input.focus();
    input.select();
  }

  function presetColumnRefs(rule) {
    const opts = rule.opts || {};
    if (['date', 'number', 'missing'].includes(rule.ruleId)) return (opts.targets || []).filter(x => typeof x === 'string');
    if (rule.ruleId === 'remove') return (opts.keys || []).filter(x => typeof x === 'string');
    if (rule.ruleId === 'cols') return (opts.keep || []).filter(x => typeof x === 'string');
    if (rule.ruleId === 'merge') return (opts.columns || []).filter(x => typeof x === 'string');
    if (rule.ruleId === 'conditional') {
      return [opts.column, opts.targetColumn].filter(x => typeof x === 'string' && x !== '');
    }
    if (['split', 'filter'].includes(rule.ruleId)) return typeof opts.column === 'string' && opts.column ? [opts.column] : [];
    if (rule.ruleId === 'ai') return (opts.steps || []).filter(s => s && typeof s.column === 'string').map(s => s.column);
    return [];
  }

  function commitPreset(name, rules, droppedRules, disabledRules, droppedSteps, rejectedSteps) {
    cancelOperation(false);
    state.activeRules = rules;
    const aiRule = rules.find(rule => rule.ruleId === 'ai');
    state.aiLastSteps = aiRule ? JSON.parse(JSON.stringify(aiRule.opts.steps || [])) : null;
    state.aiLastAnalysis = '来自预设「' + name + '」';
    state.aiPendingSteps = null;
    invalidatePreview();
    renderAll();
    const notes = [];
    if (droppedRules) notes.push('忽略 ' + droppedRules + ' 条失效规则');
    if (disabledRules) notes.push('停用 ' + disabledRules + ' 条未映射规则');
    if (droppedSteps) notes.push('删除 ' + droppedSteps + ' 个未映射 AI 步骤');
    if (rejectedSteps) notes.push('拒绝 ' + rejectedSteps + ' 个无效 AI 步骤');
    showToast('已套用预设「' + name + '」' + (notes.length ? '（' + notes.join('，') + '）' : ''));
  }

  function applyPresetMapping(name, rules, mapping, droppedRules) {
    let disabledRules = 0, droppedSteps = 0, rejectedSteps = 0;
    const mapName = old => Object.prototype.hasOwnProperty.call(mapping, old) ? mapping[old] : old;
    rules.forEach(rule => {
      const opts = rule.opts || {};
      if (rule.ruleId !== 'ai' && presetColumnRefs(rule).some(old => mapName(old) === null)) {
        if (rule.enabled) disabledRules++;
        rule.enabled = false;
        return;
      }
      ['targets', 'keys', 'keep', 'columns'].forEach(key => {
        if (Array.isArray(opts[key])) opts[key] = opts[key].map(mapName).filter(x => x !== null);
      });
      if (['split', 'filter', 'conditional'].includes(rule.ruleId) && typeof opts.column === 'string') {
        opts.column = mapName(opts.column);
      }
      if (rule.ruleId === 'conditional' && typeof opts.targetColumn === 'string') {
        opts.targetColumn = mapName(opts.targetColumn);
      }
      if (rule.ruleId === 'split') opts.colIdx = state.sourceHeaders.indexOf(opts.column);
      if (rule.ruleId === 'ai') {
        const original = opts.steps || [];
        const mapped = [];
        original.forEach(step => {
          if (step && typeof step.column === 'string') {
            const column = mapName(step.column);
            if (column === null) { droppedSteps++; return; }
            step.column = column;
          }
          mapped.push(step);
        });
        const checked = AI.validateAISteps(mapped, state.sourceHeaders.length ? state.sourceHeaders : null);
        rejectedSteps += checked.errors.length;
        opts.steps = checked.steps;
      }
    });
    commitPreset(name, rules, droppedRules, disabledRules, droppedSteps, rejectedSteps);
  }

  function openPresetMapping(name, rules, missing, droppedRules) {
    const body = el('div');
    body.appendChild(el('p', { class: 'hint' },
      '预设列名与当前表结构不完全匹配。请选择映射；选择“停用/删除相关步骤”不会猜测或改动其他列。'));
    const selects = new Map();
    missing.forEach(oldName => {
      const select = el('select', { class: 'input', 'data-old-column': oldName });
      select.appendChild(el('option', { value: '' }, '停用 / 删除相关步骤'));
      state.sourceHeaders.forEach(header => select.appendChild(el('option', { value: header }, header)));
      const suggestion = state.sourceHeaders.find(header => header.trim().toLowerCase() === oldName.trim().toLowerCase());
      if (suggestion) select.value = suggestion;
      selects.set(oldName, select);
      body.appendChild(el('div', { class: 'mapping-row' }, el('span', null, oldName), select));
    });
    const actions = el('div', { class: 'modal-actions' });
    const ok = el('button', { class: 'btn primary' }, '应用列映射');
    ok.addEventListener('click', () => {
      const mapping = {};
      selects.forEach((select, oldName) => { mapping[oldName] = select.value || null; });
      closeModal();
      applyPresetMapping(name, rules, mapping, droppedRules);
    });
    const cancel = el('button', { class: 'btn' }, '取消');
    cancel.addEventListener('click', () => { closeModal(); $('preset-select').value = ''; });
    actions.appendChild(ok); actions.appendChild(cancel); body.appendChild(actions);
    openModal('预设列名映射 · ' + name, body);
  }

  function applyPreset(name) {
    if (!name) return;
    const p = loadPresets().find(x => x.name === name);
    if (!p) { showToast('预设不存在', 'err'); return; }
    const valid = p.rules.filter(r => r && R.RULES.some(rr => rr.id === r.ruleId));
    const dropped = p.rules.length - valid.length;
    const rules = valid.map(a => ({
      ruleId: a.ruleId,
      enabled: !!a.enabled,
      opts: JSON.parse(JSON.stringify(a.opts || {})),
    }));
    rules.forEach(rule => {
      if (rule.ruleId === 'ai') rule.opts.steps = JSON.parse(JSON.stringify(rule.opts.steps || []));
      if (rule.ruleId === 'split' && typeof rule.opts.column !== 'string') {
        const index = Number(rule.opts.colIdx);
        if (Array.isArray(p.headers) && p.headers[index] !== undefined) rule.opts.column = p.headers[index];
        else if (index >= 0 && index < state.sourceHeaders.length) rule.opts.column = state.sourceHeaders[index];
      }
    });
    if (!state.sourceHeaders.length) { commitPreset(name, rules, dropped, 0, 0, 0); return; }
    const missing = [];
    rules.forEach(rule => presetColumnRefs(rule).forEach(column => {
      if (state.sourceHeaders.indexOf(column) < 0 && missing.indexOf(column) < 0) missing.push(column);
    }));
    if (missing.length) openPresetMapping(name, rules, missing, dropped);
    else applyPresetMapping(name, rules, {}, dropped);
  }

  function deletePreset() {
    const sel = $('preset-select');
    const name = sel ? sel.value : '';
    if (!name) { showToast('请先在下拉框选择要删除的预设', 'err'); return; }
    const list = loadPresets().filter(p => p.name !== name);
    if (savePresets(list)) {
      renderPresetSelect('');
      showToast('已删除预设「' + name + '」');
    }
  }

  function exportPresets() {
    const list = loadPresets();
    if (!list.length) { showToast('还没有任何预设可导出', 'err'); return; }
    downloadText(DCIO.serializePresets(list), 'dc-presets.json', 'application/json');
    showToast('已导出 ' + list.length + ' 个预设');
  }

  function importPresetsFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const incoming = DCIO.deserializePresets(String(reader.result));
        if (!incoming.length) { showToast('文件里没有有效预设', 'err'); return; }
        const list = loadPresets();
        let added = 0, replaced = 0;
        incoming.forEach(p => {
          const idx = list.findIndex(x => x.name === p.name);
          if (idx >= 0) { list[idx] = p; replaced++; } else { list.push(p); added++; }
        });
        if (savePresets(list)) {
          renderPresetSelect('');
          showToast('导入完成：新增 ' + added + ' 个，覆盖 ' + replaced + ' 个');
        }
      } catch (e) {
        showToast('导入失败：' + e.message, 'err');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  // 通用下载（导出 CSV / 预设 JSON 共用）
  function downloadText(text, fileName, mime) {
    downloadBlob(new Blob(['\uFEFF' + text], { type: (mime || 'text/plain') + ';charset=utf-8;' }), fileName);
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: fileName });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- 导出 ----
  function currentExportSourceJob() {
    const recent = state.qualitySource;
    if (recent && recent.headers === state.headers && recent.rows === state.rows) return recent.job;
    return state.rows === state.sourceRows ? state.sourceWorkerJob : null;
  }

  async function exportTable(format) {
    if (state.previewResult) { showToast('请先应用或取消清洗预览，再导出数据', 'err'); return; }
    if (!state.headers.length) { showToast('没有数据', 'err'); return; }
    const operation = startOperation('export');
    const headers = state.headers, rows = state.rows;
    const sourceJob = currentExportSourceJob();
    const excel = format === 'xlsx';
    let base = (state.fileName || 'data').replace(/\.[^.]+$/, '');
    if (!base) base = 'data';
    try {
      const kind = excel ? 'buildXLSX' : 'buildCSV';
      operation.job = DCWorker.run(kind, { headers, rows, sourceJob, sheetName: base }, progress => {
        if (state.operation === operation) updateProgress(progress, excel ? '正在后台生成 Excel' : '正在后台生成 CSV');
      });
      const blob = await operation.job.promise;
      if (state.operation !== operation) return;
      const fileName = excel ? 'cleaned_' + base + '.xlsx' : 'cleaned_' + base + '.csv';
      downloadBlob(blob, fileName);
      showToast('已导出 ' + (excel ? 'Excel' : 'CSV') + '（' + rows.length + ' 行）'
        + (operation.job.fallbackReason ? ' · 兼容模式' : ''));
    } catch (error) {
      if (state.operation === operation && error.name !== 'AbortError') {
        showToast('导出 ' + (excel ? 'Excel' : 'CSV') + ' 失败：' + error.message, 'err');
      }
    } finally {
      finishOperation(operation);
    }
  }

  function exportCSV() { exportTable('csv'); }
  function exportXLSX() { exportTable('xlsx'); }

  function appendColumnChecks(box, ar, key, emptyHint) {
    ar.opts[key] = Array.isArray(ar.opts[key]) ? ar.opts[key] : [];
    if (emptyHint) box.appendChild(el('p', { class: 'hint' }, emptyHint));
    state.sourceHeaders.forEach(header => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = ar.opts[key].indexOf(header) >= 0;
      cb.addEventListener('change', () => {
        if (cb.checked && ar.opts[key].indexOf(header) < 0) ar.opts[key].push(header);
        if (!cb.checked) ar.opts[key] = ar.opts[key].filter(name => name !== header);
      });
      box.appendChild(el('label', null, cb, ' ' + header));
    });
  }

  function appendColumnSelect(box, ar, key, label, placeholder) {
    const select = el('select', { class: 'input', 'data-config': key });
    select.appendChild(el('option', { value: '' }, placeholder || '请选择列'));
    state.sourceHeaders.forEach(header => select.appendChild(el('option', { value: header }, header)));
    select.value = typeof ar.opts[key] === 'string' ? ar.opts[key] : '';
    select.addEventListener('change', () => { ar.opts[key] = select.value; });
    box.appendChild(el('label', null, label, select));
    return select;
  }

  function appendConditionControls(box, ar, includeColumn) {
    if (includeColumn) appendColumnSelect(box, ar, 'column', '条件列：', '请选择条件列');
    const operator = el('select', { class: 'input', 'data-config': 'operator' });
    [
      ['equals', '等于'], ['not_equals', '不等于'], ['contains', '包含'], ['not_contains', '不包含'],
      ['empty', '为空'], ['not_empty', '不为空'], ['gt', '大于'], ['gte', '大于或等于'],
      ['lt', '小于'], ['lte', '小于或等于'],
    ].forEach(([value, label]) => {
      const option = el('option', { value }, label);
      if ((ar.opts.operator || 'equals') === value) option.selected = true;
      operator.appendChild(option);
    });
    operator.addEventListener('change', () => { ar.opts.operator = operator.value; });
    box.appendChild(el('label', null, '条件：', operator));
    const value = el('input', { class: 'input', type: 'text', 'data-config': 'value', placeholder: '为空/不为空时无需填写' });
    value.value = ar.opts.value === undefined || ar.opts.value === null ? '' : String(ar.opts.value);
    value.addEventListener('input', () => { ar.opts.value = value.value; });
    box.appendChild(el('label', null, '比较值：', value));
    const caseSensitive = el('input', { type: 'checkbox', 'data-config': 'caseSensitive' });
    caseSensitive.checked = ar.opts.caseSensitive === true;
    caseSensitive.addEventListener('change', () => { ar.opts.caseSensitive = caseSensitive.checked; });
    box.appendChild(el('label', null, caseSensitive, ' 文本匹配区分大小写（默认不区分）'));
  }

  function appendCheckbox(box, ar, key, label) {
    const input = el('input', { type: 'checkbox', 'data-config': key });
    input.checked = ar.opts[key] === true;
    input.addEventListener('change', () => { ar.opts[key] = input.checked; });
    box.appendChild(el('label', null, input, ' ' + label));
  }

  // ---- 打开规则配置 ----
  function openRuleConfig(ruleId) {
    cancelOperation(false);
    const ar = state.activeRules.find(a => a.ruleId === ruleId);
    if (!ar) return;
    invalidatePreview();
    const modal = $('modal');
    const body = $('modal-body');
    body.innerHTML = '';
    const box = el('div', { class: 'cfg-box' });
    box.appendChild(el('h3', null, '⚙ 配置：' + ruleId));
    if (ruleId === 'text') {
      const trim = el('input', { type: 'checkbox' });
      trim.checked = !!ar.opts.trim;
      trim.addEventListener('change', () => { ar.opts.trim = trim.checked; });
      box.appendChild(el('label', null, trim, ' 去除首尾空白'));
      const sp = el('input', { type: 'checkbox' });
      sp.checked = !!ar.opts.removeSpecial;
      sp.addEventListener('change', () => { ar.opts.removeSpecial = sp.checked; });
      box.appendChild(el('label', null, sp, ' 去除特殊字符'));
      const sel = el('select', { class: 'input' });
      ['none', 'upper', 'lower', 'title'].forEach(c => {
        const o = el('option', { value: c }, c);
        if (c === ar.opts.caseMode) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', () => { ar.opts.caseMode = sel.value; });
      box.appendChild(el('label', null, '大小写：', sel));
    } else if (ruleId === 'empty') {
      const sel = el('select', { class: 'input' });
      ['rows', 'cols', 'both'].forEach(c => {
        const o = el('option', { value: c }, c);
        if (c === ar.opts.mode) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', () => { ar.opts.mode = sel.value; });
      box.appendChild(el('label', null, '模式：', sel));
    } else if (ruleId === 'missing') {
      box.appendChild(el('p', { class: 'hint' },
        '每行一个标记，只匹配去除首尾空白后的完整单元格。默认把标记转为空值，也可统一替换成其他文本。'));
      const tokens = el('textarea', { class: 'input', rows: '5', 'data-config': 'tokens', placeholder: 'N/A\nNULL\n-' });
      tokens.value = (Array.isArray(ar.opts.tokens) ? ar.opts.tokens : []).join('\n');
      tokens.addEventListener('input', () => {
        ar.opts.tokens = tokens.value.split(/\r?\n/).map(token => token.trim()).filter(Boolean).slice(0, 50);
      });
      box.appendChild(el('label', null, '空值标记（每行一个，最多 50 个）：', tokens));
      const replacement = el('input', { class: 'input', type: 'text', 'data-config': 'replacement', placeholder: '留空 = 转换为真正的空值' });
      replacement.value = ar.opts.replacement === undefined || ar.opts.replacement === null ? '' : String(ar.opts.replacement);
      replacement.addEventListener('input', () => { ar.opts.replacement = replacement.value; });
      box.appendChild(el('label', null, '统一替换为：', replacement));
      appendCheckbox(box, ar, 'includeBlank', '同时处理原本就是空白的单元格');
      appendCheckbox(box, ar, 'caseSensitive', '标记匹配区分大小写（默认不区分）');
      appendColumnChecks(box, ar, 'targets', '不选列 = 处理全部列；选列 = 只处理指定列。');
    } else if (ruleId === 'fill') {
      const sel = el('select', { class: 'input' });
      ['forward', 'zero', 'mean', 'median', 'custom'].forEach(c => {
        const o = el('option', { value: c }, c);
        if (c === ar.opts.strategy) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', () => { ar.opts.strategy = sel.value; });
      box.appendChild(el('label', null, '策略：', sel));
      const inp = el('input', { class: 'input', placeholder: '自定义值' });
      inp.value = ar.opts.customVal || '';
      inp.addEventListener('input', () => { ar.opts.customVal = inp.value; });
      box.appendChild(el('label', null, '自定义值：', inp));
    } else if (ruleId === 'replace') {
      const f = el('input', { class: 'input', placeholder: '查找' });
      f.value = ar.opts.find || '';
      f.addEventListener('input', () => { ar.opts.find = f.value; });
      box.appendChild(el('label', null, '查找：', f));
      const r = el('input', { class: 'input', placeholder: '替换为' });
      r.value = ar.opts.replaceWith || '';
      r.addEventListener('input', () => { ar.opts.replaceWith = r.value; });
      box.appendChild(el('label', null, '替换为：', r));
    } else if (ruleId === 'conditional') {
      box.appendChild(el('p', { class: 'hint' },
        '条件列只用于判断，目标列才会被整格替换。数值比较不会把 12abc 当作数字；空字符串比较请使用“为空”。'));
      appendConditionControls(box, ar, true);
      appendColumnSelect(box, ar, 'targetColumn', '要替换的目标列：', '请选择目标列');
      const replacement = el('input', { class: 'input', type: 'text', 'data-config': 'replaceWith', placeholder: '留空 = 清空命中的目标单元格' });
      replacement.value = ar.opts.replaceWith === undefined || ar.opts.replaceWith === null ? '' : String(ar.opts.replaceWith);
      replacement.addEventListener('input', () => { ar.opts.replaceWith = replacement.value; });
      box.appendChild(el('label', null, '替换为（完整单元格）：', replacement));
    } else if (ruleId === 'split') {
      const select = el('select', { class: 'input' });
      select.appendChild(el('option', { value: '' }, '请选择要拆分的列'));
      state.sourceHeaders.forEach(header => select.appendChild(el('option', { value: header }, header)));
      const current = typeof ar.opts.column === 'string' ? ar.opts.column : state.sourceHeaders[Number(ar.opts.colIdx)];
      if (current) select.value = current;
      select.addEventListener('change', () => {
        ar.opts.column = select.value;
        ar.opts.colIdx = state.sourceHeaders.indexOf(select.value);
      });
      box.appendChild(el('label', null, '目标列：', select));
      const sep = el('input', { class: 'input', value: ar.opts.sep || ',' });
      sep.addEventListener('input', () => { ar.opts.sep = sep.value; });
      box.appendChild(el('label', null, '分隔符：', sep));
      const max = el('input', { class: 'input', type: 'number', min: '1', max: '20', value: String(ar.opts.maxParts || 3) });
      max.addEventListener('input', () => { ar.opts.maxParts = Math.max(1, Math.min(20, Number(max.value) || 3)); });
      box.appendChild(el('label', null, '最多拆成：', max));
    } else if (ruleId === 'merge') {
      box.appendChild(el('p', { class: 'hint' },
        '按勾选顺序合并至少两列。保留原列时新列追加到末尾；移除原列时新列放在首个勾选列的位置。重名会自动加序号。'));
      appendColumnChecks(box, ar, 'columns', '请选择要合并的列（至少两列）：');
      const separator = el('input', { class: 'input', type: 'text', 'data-config': 'separator', placeholder: '例如空格、逗号或 -' });
      separator.value = ar.opts.separator === undefined || ar.opts.separator === null ? ' ' : String(ar.opts.separator);
      separator.addEventListener('input', () => { ar.opts.separator = separator.value; });
      box.appendChild(el('label', null, '连接符：', separator));
      const newName = el('input', { class: 'input', type: 'text', 'data-config': 'newName', placeholder: '合并列' });
      newName.value = ar.opts.newName || '';
      newName.addEventListener('input', () => { ar.opts.newName = newName.value; });
      box.appendChild(el('label', null, '新列名：', newName));
      appendCheckbox(box, ar, 'keepOriginal', '保留原始列');
      appendCheckbox(box, ar, 'skipEmpty', '跳过空值（不为其保留连接符）');
    } else if (ruleId === 'date') {
      const format = el('select', { class: 'input' });
      ['YYYY-MM-DD', 'YYYY/MM/DD', 'YYYY.MM.DD', 'DD/MM/YYYY', 'MM/DD/YYYY'].forEach(value => {
        const option = el('option', { value }, value);
        if ((ar.opts.targetFormat || 'YYYY-MM-DD') === value) option.selected = true;
        format.appendChild(option);
      });
      format.addEventListener('change', () => { ar.opts.targetFormat = format.value; });
      box.appendChild(el('label', null, '输出格式：', format));
      appendColumnChecks(box, ar, 'targets', '不选列 = 自动识别日期列；非法日期保留原值并写入日志。');
    } else if (ruleId === 'cols') {
      appendColumnChecks(box, ar, 'keep', '选择要保留的列；未选择时保持原列不变。');
    } else if (ruleId === 'filter') {
      box.appendChild(el('p', { class: 'hint' },
        '筛选只生成预览，确认后才会提交。未选列或未填比较值时跳过；如需匹配空字符串，请选择“为空”。'));
      appendConditionControls(box, ar, true);
      const action = el('select', { class: 'input', 'data-config': 'action' });
      [['keep', '保留匹配行，删除其他行'], ['remove', '删除匹配行，保留其他行']].forEach(([value, label]) => {
        const option = el('option', { value }, label);
        if ((ar.opts.action || 'keep') === value) option.selected = true;
        action.appendChild(option);
      });
      action.addEventListener('change', () => { ar.opts.action = action.value; });
      box.appendChild(el('label', null, '筛选动作：', action));
    } else if (ruleId === 'remove') {
      box.appendChild(el('p', { class: 'hint' }, '不选列 = 整行完全相同才算重复；选列 = 只按这些列判重。'));
      ar.opts.keys = ar.opts.keys || [];
      state.sourceHeaders.forEach(h => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = ar.opts.keys.indexOf(h) >= 0;
        cb.addEventListener('change', () => {
          if (cb.checked) { if (ar.opts.keys.indexOf(h) < 0) ar.opts.keys.push(h); }
          else ar.opts.keys = ar.opts.keys.filter(k => k !== h);
        });
        box.appendChild(el('label', null, cb, ' ' + h));
      });
    } else if (ruleId === 'number') {
      const strip = el('input', { type: 'checkbox' });
      strip.checked = !!ar.opts.strip;
      strip.addEventListener('change', () => { ar.opts.strip = strip.checked; });
      box.appendChild(el('label', null, strip, ' 去除非数字字符'));
      const phone = el('input', { type: 'checkbox' });
      phone.checked = !!ar.opts.phone;
      phone.addEventListener('change', () => { ar.opts.phone = phone.checked; });
      box.appendChild(el('label', null, phone, ' 手机号脱敏'));
      appendColumnChecks(box, ar, 'targets', '不选列 = 自动识别数字列。手机号列建议选择后仅启用脱敏。');
    }
    const closeBtn = el('button', { class: 'btn' }, '完成');
    closeBtn.addEventListener('click', closeModal);
    box.appendChild(closeBtn);
    body.appendChild(box);
    modal.classList.add('open');
  }

  // ---- 事件绑定 ----
  function bindEvents() {
    $('btn-sample').addEventListener('click', loadSample);
    $('btn-csv').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      loadAnyFile(f);
      e.target.value = '';  // 允许重复选择同一文件
    });

    // 拖拽文件到表格区域即可导入
    const drop = $('table-wrap');
    if (drop) {
      ['dragenter', 'dragover'].forEach(evt => drop.addEventListener(evt, (e) => {
        e.preventDefault();
        drop.classList.add('drag-over');
      }));
      ['dragleave', 'drop'].forEach(evt => drop.addEventListener(evt, (e) => {
        e.preventDefault();
        drop.classList.remove('drag-over');
      }));
      drop.addEventListener('drop', (e) => {
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!f) return;
        if (!/\.(csv|tsv|txt|xlsx)$/i.test(f.name)) {
          showToast('只支持 CSV / TSV / TXT / XLSX 文件', 'err'); return;
        }
        loadAnyFile(f);
      });
    }
    $('btn-run').addEventListener('click', runPipeline);
    $('btn-cancel-task').addEventListener('click', () => cancelOperation(true));
    $('btn-apply').addEventListener('click', applyPreview);
    $('btn-cancel-preview').addEventListener('click', () => cancelPreview(true));
    $('btn-preview-diff').addEventListener('click', showPreviewDiff);
    $('btn-undo').addEventListener('click', undo);
    $('btn-export').addEventListener('click', exportCSV);
    $('btn-export-xlsx').addEventListener('click', exportXLSX);
    $('btn-report').addEventListener('click', exportAuditReport);

    // 规则预设
    $('preset-select').addEventListener('change', (e) => applyPreset(e.target.value));
    $('btn-preset-save').addEventListener('click', savePresetPrompt);
    $('btn-preset-del').addEventListener('click', deletePreset);
    $('btn-preset-export').addEventListener('click', exportPresets);
    $('btn-preset-import').addEventListener('click', () => $('preset-file').click());
    $('preset-file').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) importPresetsFile(f);
      e.target.value = '';
    });
    $('btn-ai-settings').addEventListener('click', openAISettings);
    $('btn-suggest').addEventListener('click', suggestAutoFix);
    $('modal-close').addEventListener('click', closeModal);
    $('ai-send').addEventListener('click', sendAI);
    $('ai-stop').addEventListener('click', stopAI);
    $('ai-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendAI();
      }
    });

    // 快捷指令按钮
    document.querySelectorAll('[data-quick]').forEach(btn => {
      btn.addEventListener('click', () => {
        $('ai-input').value = btn.getAttribute('data-quick');
        sendAI();
      });
    });
  }

  // ---- 初始化 ----
  function syncCustomProvider() {
    const cfg = JSON.parse(localStorage.getItem('dc_ai_config') || '{}');
    if (cfg.baseUrl) AI.PROVIDERS.custom.baseUrl = cfg.baseUrl;
    if (cfg.model) AI.PROVIDERS.custom.model = cfg.model;
    else if (cfg.baseUrl) AI.PROVIDERS.custom.model = 'gpt-3.5-turbo';
  }

  function init() {
    syncCustomProvider();
    bindEvents();
    renderPresetSelect('');   // 恢复上次保存的预设列表
    loadSample();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();