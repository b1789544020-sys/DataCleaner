/* ============================================
   DataCleaner Pro · AI · 主应用
   - 加载示例数据 / 解析表格
   - 规则流水线（保留 8 条原规则 + AI 规则）
   - AI 智能清洗面板（自然语言 → 流式 → 确认 → 注入）
   - 多轮对话 / 自动修复建议 / 错误回滚
   ============================================ */

(function () {
  'use strict';

  const R = window.DCRules;
  const AI = window.DCAI;

  // ---- 全局状态 ----
  const state = {
    headers: [],
    rows: [],
    fileName: '',
    activeRules: [
      { ruleId: 'empty', enabled: true, opts: { mode: 'rows' } },
      { ruleId: 'text', enabled: true, opts: { trim: true, removeSpecial: false, caseMode: 'none' } },
    ],
    lastResult: null,   // 最近一次流水线结果
    history: [],        // 撤销栈
    aiConversation: [], // 多轮对话 messages
    aiLastSteps: null,  // 已应用到流水线的步骤
    aiPendingSteps: null, // AI 刚生成、等待用户确认的步骤
    page: 0,            // 数据预览当前页（每页 100 行）
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
    setData(SAMPLE_DATA.headers.slice(), SAMPLE_DATA.rows.map(r => r.slice()),
      '示例数据.csv', '已加载示例数据（10 行）');
  }

  // ---- 统一装载入口：任何来源的数据都走这里 ----
  function setData(headers, rows, name, extraToast) {
    state.headers = headers;
    state.rows = rows;
    state.fileName = name || 'data.csv';
    state.activeRules = [
      { ruleId: 'empty', enabled: true, opts: { mode: 'rows' } },
      { ruleId: 'text', enabled: true, opts: { trim: true, removeSpecial: false, caseMode: 'none' } },
    ];
    state.lastResult = null;
    state.history = [];
    state.aiConversation = [];
    state.aiLastSteps = null;
    state.aiPendingSteps = null;
    state.page = 0;
    resetAIPanel();
    renderAll();
    showToast(extraToast || ('已加载 ' + rows.length + ' 行'));
  }

  // ---- 加载 CSV/TSV 文本 ----
  // 用 DCIO 的字符流解析器：支持字段内换行、"" 转义、自动嗅探分隔符
  function loadCSVText(text, name) {
    const delim = DCIO.sniffDelimiter(text);
    const t = DCIO.parseCSV(text, delim);
    if (!t.headers.length) { showToast('文件为空或无法解析', 'err'); return; }
    const dname = { ',': '逗号', '\t': '制表符', ';': '分号', '|': '竖线' }[delim] || delim;
    setData(t.headers, t.rows, name,
      '已加载 ' + t.rows.length + ' 行 · 分隔符：' + dname);
  }

  // ---- 加载 XLSX（零依赖：DecompressionStream + DOMParser）----
  function loadXLSXFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      DCIO.parseXLSX(reader.result).then(wb => {
        if (wb.sheets.length === 1) {
          const s = wb.sheets[0];
          setData(s.headers, s.rows, file.name,
            '已加载 ' + s.rows.length + ' 行（工作表：' + s.name + '）');
        } else {
          pickSheet(wb.sheets, file.name);
        }
      }).catch(e => showToast('XLSX 解析失败：' + e.message, 'err'));
    };
    reader.onerror = () => showToast('文件读取失败', 'err');
    reader.readAsArrayBuffer(file);
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
          '已加载 ' + s.rows.length + ' 行（工作表：' + s.name + '）');
      });
      body.appendChild(b);
    });
    openModal('📑 选择工作表', body);
  }

  // ---- 按扩展名分派 ----
  function loadAnyFile(file) {
    if (/\.xlsx$/i.test(file.name)) return loadXLSXFile(file);
    if (/\.xls$/i.test(file.name)) {
      showToast('旧版 .xls 二进制格式不支持，请在 Excel 中另存为 .xlsx 或 CSV', 'err');
      return;
    }
    readTextAuto(file, (text) => loadCSVText(text, file.name));
  }

  // ---- 读取文本文件：自动识别 UTF-8 / GBK（Excel 中文默认导出）----
  function readTextAuto(file, done) {
    const reader = new FileReader();
    reader.onload = () => {
      const buf = reader.result;
      let text = decodeBuffer(buf, 'utf-8');
      // U+FFFD 替换字符过多 → 判定为非 UTF-8，回退 GBK
      const bad = (text.match(/\uFFFD/g) || []).length;
      if (bad > 0) {
        const gbk = decodeBuffer(buf, 'gbk');
        if (gbk !== null && (gbk.match(/\uFFFD/g) || []).length < bad) {
          text = gbk;
          showToast('检测到 GBK 编码，已自动转码');
        }
      }
      done(text.replace(/^\uFEFF/, ''));
    };
    reader.readAsArrayBuffer(file);
  }

  function decodeBuffer(buf, enc) {
    try {
      return new TextDecoder(enc, { fatal: false }).decode(buf);
    } catch (e) {
      return null;
    }
  }

  function parseCSVLine(line) {
    return DCIO.parseDelimited(line, ',')[0] || [];
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
      renderTable(state.headers, state.rows,
        state.lastResult ? state.lastResult.changed : null);
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
    renderRules();
  }

  function defaultOptsFor(ruleId) {
    switch (ruleId) {
      case 'empty': return { mode: 'rows' };
      case 'fill': return { strategy: 'forward', customVal: '' };
      case 'text': return { trim: true, removeSpecial: false, caseMode: 'none' };
      case 'replace': return { find: '', replaceWith: '' };
      case 'split': return { colIdx: -1, sep: ',', maxParts: 3 };
      case 'date': return { targets: [] };
      case 'number': return { strip: true, phone: false, targets: [] };
      case 'cols': return { keep: [] };
      case 'remove': return { keys: [] };
      case 'ai': return { steps: [] };
      default: return {};
    }
  }

  // ---- 运行流水线 ----
  function runPipeline() {
    if (!state.headers.length) { showToast('请先加载数据', 'err'); return; }
    if (!state.activeRules.some(a => a.enabled)) { showToast('请至少启用一个规则', 'err'); return; }
    // 同步 AI 步骤到 activeRules
    const aiRule = state.activeRules.find(a => a.ruleId === 'ai');
    if (aiRule && aiRule.enabled) {
      aiRule.opts = aiRule.opts || {};
      aiRule.opts.steps = state.aiLastSteps || [];
    }

    const active = state.activeRules.filter(a => a.enabled);
    if (!active.length) { showToast('没有启用的规则', 'err'); return; }

    // 记录历史（撤销用）
    state.history.push({
      headers: state.headers.slice(),
      rows: state.rows.map(r => r.slice()),
      activeRules: JSON.parse(JSON.stringify(state.activeRules)),
    });
    if (state.history.length > 20) state.history.shift();

    try {
      const result = R.runPipeline(active, state.headers.slice(), state.rows.map(r => r.slice()), (p, id) => {
        updateProgress(p, id);
      });
      state.lastResult = result;
      state.headers = result.headers;
      state.rows = result.rows;
      renderAll();
      const modified = result.changed ? result.changed.size : 0;
      showToast('清洗完成 · 修改 ' + modified + ' 处');
      renderAILog();
    } catch (e) {
      showToast('执行失败：' + e.message, 'err');
      // 撤销
      undo();
    }
  }

  function updateProgress(p, id) {
    const bar = $('progress-bar');
    if (bar) bar.style.width = (p * 100).toFixed(1) + '%';
    const tip = $('progress-tip');
    if (tip) tip.textContent = '执行中：' + id + ' (' + (p * 100).toFixed(0) + '%)';
  }

  function undo() {
    if (!state.history.length) { showToast('没有可撤销的操作', 'err'); return; }
    const prev = state.history.pop();
    state.headers = prev.headers;
    state.rows = prev.rows;
    state.activeRules = prev.activeRules;
    renderAll();
    showToast('已撤销');
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

  function closeModal() { $('modal').classList.remove('open'); }

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
    // 合并策略：同列同类型的步骤覆盖旧的，其余追加（多轮对话不丢历史步骤）
    const merged = (state.aiLastSteps || []).slice();
    (parsed.steps || []).forEach(ns => {
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
    renderRules();
    renderTable(state.headers, state.rows, state.lastResult ? state.lastResult.changed : null);
    showToast('AI 步骤已注入流水线 ✓ 当前共 ' + merged.length + ' 步');
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
    renderRules();
  }

  // ---- 自动修复建议 ----
  function suggestAutoFix() {
    if (!state.headers.length) { showToast('请先加载数据', 'err'); return; }
    const issues = R.analyzeQuality(state.headers, state.rows);
    if (!issues.length) {
      showToast('未发现数据问题 ✨');
      return;
    }
    const modal = $('modal');
    const body = $('modal-body');
    body.innerHTML = '';
    const box = el('div', { class: 'suggest-box' });
    box.appendChild(el('h3', null, '🔍 数据质量分析'));
    box.appendChild(el('p', { class: 'hint' }, '发现 ' + issues.length + ' 个潜在问题，建议的修复步骤：'));
    const ul = el('ul', { class: 'suggest-list' });
    issues.forEach(iss => {
      ul.appendChild(el('li', null, iss.message));
    });
    box.appendChild(ul);

    // 生成对应步骤
    const steps = [];
    issues.forEach(iss => {
      if (iss.type === 'missing') {
        steps.push({ type: 'fill_empty', column: iss.column, strategy: 'custom', value: '未知', description: '填充 ' + iss.column + ' 空值' });
      } else if (iss.type === 'date_inconsistent') {
        steps.push({ type: 'normalize_date', column: iss.column, target_format: 'YYYY-MM-DD', description: '统一 ' + iss.column + ' 格式' });
      } else if (iss.type === 'outliers') {
        // 仅提示，不自动操作
      }
    });

    if (steps.length) {
      const btn = el('button', { class: 'btn primary' }, '✓ 一键应用建议');
      btn.addEventListener('click', () => {
        applyAIStepsToPipeline({ steps, analysis: '自动检测到 ' + issues.length + ' 个问题' });
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
    const log = $('ai-log');
    if (!log) return;
    if (!state.lastResult || !state.lastResult.log) {
      log.innerHTML = '<div class="log-empty">暂无日志</div>';
      return;
    }
    log.innerHTML = '';
    state.lastResult.log.forEach(line => {
      log.appendChild(el('div', { class: 'log-line' }, line));
    });
  }

  // ---- 渲染质量分析（侧栏） ----
  function renderQuality() {
    const box = $('quality-box');
    if (!box) return;
    if (!state.headers.length) { box.innerHTML = ''; return; }
    const issues = R.analyzeQuality(state.headers, state.rows);
    box.innerHTML = '';
    if (!issues.length) {
      box.appendChild(el('div', { class: 'quality-ok' }, '✨ 数据质量良好'));
      return;
    }
    box.appendChild(el('h4', null, '🔍 数据质量'));
    const ul = el('ul', { class: 'q-list' });
    issues.forEach(iss => ul.appendChild(el('li', null, iss.message)));
    box.appendChild(ul);
    const fixBtn = el('button', { class: 'btn-mini' }, '🤖 一键修复');
    fixBtn.addEventListener('click', suggestAutoFix);
    box.appendChild(fixBtn);
  }

  // ---- 全部渲染 ----
  function renderAll() {
    const changed = state.lastResult ? state.lastResult.changed : null;
    renderTable(state.headers, state.rows, changed);
    renderRules();
    renderQuality();
    renderAILog();
    updateFileInfo();
  }

  function resetAIPanel() {
    const panel = $('ai-response');
    if (panel) { panel.innerHTML = ''; panel.classList.remove('active'); }
  }

  function updateFileInfo() {
    const info = $('file-info');
    if (info) info.textContent = state.fileName ? (state.fileName + ' · ' + state.rows.length + ' 行 × ' + state.headers.length + ' 列') : '未加载数据';
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
    return state.activeRules.map(a => ({
      ruleId: a.ruleId,
      enabled: !!a.enabled,
      opts: JSON.parse(JSON.stringify(a.opts || {})),
    }));
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
      const item = { name: name, rules: snapshotRules(), savedAt: new Date().toISOString() };
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

  function applyPreset(name) {
    if (!name) return;
    const p = loadPresets().find(x => x.name === name);
    if (!p) { showToast('预设不存在', 'err'); return; }
    // 只保留当前版本仍存在的规则 id，防止旧预设引用已删除的规则
    const valid = p.rules.filter(r => R.RULES.some(rr => rr.id === r.ruleId));
    const dropped = p.rules.length - valid.length;
    state.activeRules = valid.map(a => ({
      ruleId: a.ruleId,
      enabled: !!a.enabled,
      opts: JSON.parse(JSON.stringify(a.opts || {})),
    }));
    renderRules();
    showToast('已套用预设「' + name + '」' + (dropped ? '（忽略 ' + dropped + ' 条失效规则）' : ''));
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
  function exportCSV() {
    if (!state.headers.length) { showToast('没有数据', 'err'); return; }
    const lines = [state.headers.map(csvEscape).join(',')];
    state.rows.forEach(r => lines.push(r.map(csvEscape).join(',')));
    // 导出的引号/换行转义现在能被自己的解析器无损读回（往返闭环）
    let name = state.fileName || 'data.csv';
    name = name.replace(/\.(xlsx|xls|tsv|txt)$/i, '.csv');
    if (!/\.csv$/i.test(name)) name += '.csv';
    downloadText(lines.join('\r\n'), 'cleaned_' + name, 'text/csv');
    showToast('已导出 ' + state.rows.length + ' 行');
  }
  function csvEscape(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // ---- 导出 Excel（零依赖生成 xlsx：CompressionStream 压 ZIP + 手写 XML）----
  function exportXLSX() {
    if (!state.headers.length) { showToast('没有数据', 'err'); return; }
    const btn = $('btn-export-xlsx');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 生成中…'; }
    const restore = () => {
      if (btn) { btn.disabled = false; btn.textContent = '⬇ 导出 Excel'; }
    };
    let base = (state.fileName || 'data').replace(/\.[^.]+$/, '');
    if (!base) base = 'data';
    // 工作表名沿用文件名，buildXLSX 内部会清理非法字符并截断到 31 字符
    DCIO.buildXLSX(state.headers, state.rows, base)
      .then(blob => {
        downloadBlob(blob, 'cleaned_' + base + '.xlsx');
        showToast('已导出 Excel（' + state.rows.length + ' 行）');
        restore();
      })
      .catch(e => {
        showToast('导出 Excel 失败：' + e.message, 'err');
        restore();
      });
  }

  // ---- 打开规则配置 ----
  function openRuleConfig(ruleId) {
    const ar = state.activeRules.find(a => a.ruleId === ruleId);
    if (!ar) return;
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
    } else if (ruleId === 'remove') {
      box.appendChild(el('p', { class: 'hint' }, '不选列 = 整行完全相同才算重复；选列 = 只按这些列判重。'));
      ar.opts.keys = ar.opts.keys || [];
      state.headers.forEach(h => {
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
    }
    const closeBtn = el('button', { class: 'btn' }, '完成');
    closeBtn.addEventListener('click', () => { closeModal(); renderAll(); });
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
    $('btn-undo').addEventListener('click', undo);
    $('btn-export').addEventListener('click', exportCSV);
    $('btn-export-xlsx').addEventListener('click', exportXLSX);

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