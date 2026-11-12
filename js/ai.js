/* ============================================
   DataCleaner Pro · AI · AI 适配层
   - 多 Provider：DeepSeek / 通义千问 / OpenAI 兼容 / Mock / WebLLM
   - 流式输出（SSE 解析） + 非流式兜底
   - 多轮对话上下文管理
   - Prompt 构造 + JSON 步骤解析 + 启发式兜底
   ============================================ */

(function () {
  'use strict';

  // ---- Provider 预设 ----
  const PROVIDERS = {
    deepseek: {
      label: 'DeepSeek V3',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      streamPath: '/chat/completions',
      keyPlaceholder: 'sk-...',
    },
    qwen: {
      label: '通义千问 Turbo',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
      model: 'qwen-turbo',
      streamPath: '/v1/chat/completions',
      keyPlaceholder: 'sk-...',
    },
    openai: {
      label: 'OpenAI 兼容',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      streamPath: '/chat/completions',
      keyPlaceholder: 'sk-...',
    },
    custom: {
      label: '自定义（OpenAI 兼容）',
      baseUrl: '',
      model: '',
      streamPath: '/chat/completions',
      keyPlaceholder: 'sk-...',
    },
    mock: {
      label: '本地模拟（无需 Key）',
      baseUrl: '',
      model: 'mock',
      streamPath: '',
      keyPlaceholder: '无需填写',
    },
    webllm: {
      label: '浏览器本地（WebLLM）',
      baseUrl: '',
      model: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
      streamPath: '',
      keyPlaceholder: '无需填写（首次需下载模型）',
    },
  };

  // ---- 系统 Prompt ----
  const SYSTEM_PROMPT = [
    '你是一个数据清洗专家，名字叫 DataBot。',
    '用户会给你一段表格数据（最多前 10 行）和一条自然语言指令。',
    '',
    '你的任务：',
    '1. 分析数据结构和用户的指令',
    '2. 输出一段简短的分析过程（中文，1-3 句话）',
    '3. 输出一个 JSON 格式的清洗步骤列表（严格 JSON，便于程序解析）',
    '',
    '【严格输出格式】（必须以 ```json 开头并以 ``` 结尾）：',
    '```json',
    '{',
    '  "analysis": "分析：检测到 xxx 列需要 xxx...",',
    '  "steps": [',
    '    { "type": "mask_column", "column": "列名", "pattern": "keep_first(3) + **** + keep_last(4)", "description": "描述" }',
    '  ]',
    '}',
    '```',
    '',
    '【支持的步骤类型】：',
    '- mask_column      脱敏列：column, pattern',
    '- normalize_date   日期标准化：column, target_format',
    '- fill_empty       填充空值：column, strategy, value',
    '- trim_whitespace  去除空白：column',
    '- remove_duplicates 去重：无需参数',
    '- split_column     拆分列：column, separator, new_columns',
    '- rename_column    重命名列：column, new_name',
    '- delete_column    删除列：column',
    '- custom_formula   自定义公式：column, formula',
    '',
    '【重要规则】：',
    '- 只输出步骤，不要在 steps 里写解释',
    '- analysis 用 1-3 句中文简洁说明',
    '- 如果用户指令不清楚或数据不支持，请返回 steps: [] 并在 analysis 中说明',
    '- 列名必须严格使用数据中实际存在的列名',
  ].join('\n');

  // ---- 启发式本地模拟 ----
  function heuristicSteps(instruction, headers, sampleRows) {
    const text = (instruction || '').trim();
    const steps = [];
    let analysis = '本地模拟：基于规则解析您的指令 → ';
    const colNames = headers || [];

    const findCol = (kws) => {
      for (const kw of kws) {
        for (const h of colNames) {
          if (h && h.indexOf(kw) !== -1) return h;
        }
      }
      return null;
    };

    // 日期格式
    const dateMatch = text.match(/(?:统一|转成|改成|标准|格式)[^\n。]*?(YYYY-MM-DD|YYYY\/MM\/DD|DD\/MM\/YYYY|MM\/DD\/YYYY|YYYY\.MM\.DD)/i);
    const dateCol = findCol(['日期', 'date', '时间', '入职', '注册', '创建', '出生']);
    if (dateMatch || /日期/.test(text) || /时间/.test(text)) {
      const fmt = dateMatch ? dateMatch[1].replace(/\\/g, '') : 'YYYY-MM-DD';
      const target = dateCol || colNames.find(h => /date|时间/.test(h)) || colNames[0];
      if (target) {
        steps.push({ type: 'normalize_date', column: target, target_format: fmt, description: '把 ' + target + ' 统一为 ' + fmt });
        analysis += '检测到日期处理 → 标准化 ' + target + '。';
      }
    }
    // 手机号脱敏
    if (/手机|电话|phone/i.test(text) && (/隐藏|脱敏|星号|mask|中间/i.test(text))) {
      const phoneCol = findCol(['手机', '电话', 'phone', 'tel', 'mobile']);
      const target = phoneCol || colNames[0];
      if (target) {
        steps.push({ type: 'mask_column', column: target, pattern: "keep_first(3) + '****' + keep_last(4)", description: '把 ' + target + ' 中间四位隐藏' });
        analysis += '检测到手机号脱敏。';
      }
    } else if (/脱敏|mask|星号|隐藏|加密/i.test(text)) {
      const col = findCol(['身份证', '手机', '电话', '邮箱', 'name', '姓名']);
      if (col) {
        steps.push({ type: 'mask_column', column: col, pattern: "keep_first(1) + '****' + keep_last(1)", description: '对 ' + col + ' 进行脱敏' });
        analysis += '检测到脱敏需求。';
      }
    }
    // 去除空白
    if (/去空|去空格|trim|空白|前后空格/i.test(text)) {
      const col = findCol(['姓名', 'name', '地址', 'address', '部门', '城市']);
      if (col) {
        steps.push({ type: 'trim_whitespace', column: col, description: '清理 ' + col + ' 前后空白' });
        analysis += '清理空白。';
      } else if (colNames.length) {
        steps.push({ type: 'trim_whitespace', column: colNames[0], description: '清理 ' + colNames[0] + ' 前后空白' });
      }
    }
    // 填充空值
    if (/填充|补全|补齐|fill|空值/i.test(text)) {
      const col = findCol(['部门', '地址', '城市', 'name', '类型', '状态']);
      if (col) {
        steps.push({ type: 'fill_empty', column: col, strategy: 'custom', value: '未知', description: '把 ' + col + ' 的空值填为"未知"' });
        analysis += '填充空值。';
      }
    }
    // 去重
    if (/去重|重复|unique|distinct/i.test(text)) {
      steps.push({ type: 'remove_duplicates', description: '删除完全重复的行' });
      analysis += '去除重复行。';
    }
    // 拆分
    if (/拆分|分割|split/i.test(text)) {
      const col = findCol(['姓名', 'name', '地址', '全名']);
      if (col) {
        steps.push({ type: 'split_column', column: col, separator: '-', new_columns: [col + '_1', col + '_2'], description: '拆分 ' + col });
        analysis += '拆分列。';
      }
    }
    // 重命名
    const renameMatch = text.match(/(?:把|将|rename|重命名)?\s*([\u4e00-\u9fa5\w]+)\s*(?:改成|重命名为|→|->|to)\s*([\u4e00-\u9fa5\w]+)/);
    if (renameMatch && colNames.includes(renameMatch[1])) {
      steps.push({ type: 'rename_column', column: renameMatch[1], new_name: renameMatch[2], description: '重命名 ' + renameMatch[1] + ' → ' + renameMatch[2] });
      analysis += '重命名列。';
    }
    // 删除列
    const delMatch = text.match(/删除.*?([\u4e00-\u9fa5\w]+)\s*列/);
    if (delMatch && colNames.includes(delMatch[1])) {
      steps.push({ type: 'delete_column', column: delMatch[1], description: '删除 ' + delMatch[1] + ' 列' });
      analysis += '删除列。';
    }
    // 公式
    const formulaMatch = text.match(/(?:计算|等于|公式|formula).*?(\w+).*?[=＝]\s*(.+)/);
    if (formulaMatch) {
      const col = findCol([formulaMatch[1]]);
      if (col) {
        steps.push({ type: 'custom_formula', column: col, formula: formulaMatch[2], description: col + ' = ' + formulaMatch[2] });
        analysis += '自定义公式。';
      }
    }

    if (steps.length === 0) {
      analysis = '本地模拟：未能从指令中识别出明确操作，请尝试更具体的描述，例如：把日期统一成 YYYY-MM-DD、把手机号中间四位隐藏、删除空行。';
    }
    return { analysis, steps };
  }

  // ---- Provider: Mock（本地模拟） ----
  async function runMock({ instruction, headers, sampleRows, onChunk, signal }) {
    const result = heuristicSteps(instruction, headers, sampleRows);
    const lines = [];
    lines.push('> 正在分析数据...');
    lines.push('');
    lines.push(result.analysis);
    lines.push('');
    lines.push('> 生成清洗步骤...');
    lines.push('');
    const jsonStr = JSON.stringify({ analysis: result.analysis, steps: result.steps }, null, 2);
    const md = '```json\n' + jsonStr + '\n```';
    let buf = '';
    for (const l of lines) buf += l + '\n';
    buf += md;
    const chars = buf.split('');
    let acc = '';
    for (let i = 0; i < chars.length; i++) {
      if (signal && signal.aborted) throw new Error('aborted');
      acc += chars[i];
      onChunk && onChunk(acc, false);
      if (i % 3 === 0) await new Promise(r => setTimeout(r, 4));
    }
    onChunk && onChunk(acc, true);
    return { fullText: acc, parsed: { analysis: result.analysis, steps: result.steps } };
  }

  // ---- Provider: OpenAI 兼容（SSE 流式） ----
  async function runOpenAICompat({ provider, apiKey, instruction, headers, sampleRows, conversation, onChunk, signal }) {
    if (!apiKey) throw new Error('请先在右上角"⚙ AI 设置"中填写 API Key');
    const cfg = PROVIDERS[provider] || PROVIDERS.deepseek;
    const baseUrl = (cfg.baseUrl || '').replace(/\/$/, '');
    const url = baseUrl + cfg.streamPath;
    const model = cfg.model;

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];
    if (conversation && conversation.length) {
      for (const m of conversation) messages.push(m);
    }
    messages.push({
      role: 'user',
      content: '列名：' + JSON.stringify(headers) + '\n数据前 10 行：' + JSON.stringify((sampleRows || []).slice(0, 10)) + '\n\n用户指令：' + instruction,
    });

    const body = {
      model,
      messages,
      stream: true,
      temperature: 0.2,
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ' · ' + (txt || resp.statusText));
    }
    if (!resp.body) throw new Error('响应无 body');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let acc = '';
    let done = false;
    while (!done) {
      const { value, done: rd } = await reader.read();
      done = rd;
      if (value) {
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line || !line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { done = true; break; }
          try {
            const obj = JSON.parse(data);
            const delta = obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content;
            if (delta) {
              acc += delta;
              onChunk && onChunk(acc, false);
            }
          } catch (e) {}
        }
      }
    }
    onChunk && onChunk(acc, true);
    const parsed = parseAIResponse(acc, headers);
    return { fullText: acc, parsed };
  }

  const WEBLLM_CDN = 'https://esm.run/@mlc-ai/web-llm';

  async function loadWebLLMLib() {
    if (window.webllm && window.webllm.CreateMLCEngine) return window.webllm;
    if (!window.__dcWebLLMLibPromise) {
      window.__dcWebLLMLibPromise = import(/* webpackIgnore: true */ WEBLLM_CDN)
        .then(mod => { window.webllm = mod; return mod; })
        .catch(err => {
          window.__dcWebLLMLibPromise = null;
          throw new Error('WebLLM 加载失败（需要联网访问 esm.run）：' + err.message);
        });
    }
    return window.__dcWebLLMLibPromise;
  }

  // ---- Provider: WebLLM（本地） ----
  async function runWebLLM({ instruction, headers, sampleRows, conversation, onChunk, signal, enginePromise }) {
    if (signal && signal.aborted) throw new DOMException('已取消', 'AbortError');
    let engine = null, rejectAbort = null;
    const abortPromise = signal ? new Promise((resolve, reject) => { rejectAbort = reject; }) : null;
    const onAbort = () => {
      if (engine && typeof engine.interruptGenerate === 'function') {
        try {
          const pending = engine.interruptGenerate();
          if (pending && pending.catch) pending.catch(() => {});
        } catch (_) { /* 引擎销毁后仍应按取消结束，而不是变成未处理异常。 */ }
      }
      if (rejectAbort) rejectAbort(new DOMException('已取消', 'AbortError'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const withAbort = promise => signal ? Promise.race([promise, abortPromise]) : promise;
    try {
      await withAbort(loadWebLLMLib());
      engine = await withAbort(enginePromise || window.__dcWebLLMEnginePromise);
      if (!engine) throw new Error('WebLLM 模型尚未初始化');
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...(conversation || []).slice(-12),
        { role: 'user', content: '列名：' + JSON.stringify(headers) + '\n数据前 10 行：' + JSON.stringify((sampleRows || []).slice(0, 10)) + '\n\n用户指令：' + instruction },
      ];
      let acc = '';
      const asyncGen = await withAbort(engine.chat.completions.create({
        messages,
        temperature: 0.2,
        stream: true,
      }));
      const iterator = asyncGen[Symbol.asyncIterator] ? asyncGen[Symbol.asyncIterator]() : asyncGen;
      while (true) {
        const { value: chunk, done } = await withAbort(iterator.next());
        if (done) break;
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
        if (delta) {
          acc += delta;
          onChunk && onChunk(acc, false);
        }
      }
      onChunk && onChunk(acc, true);
      const parsed = parseAIResponse(acc, headers);
      return { fullText: acc, parsed };
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async function initWebLLM(onProgress) {
    await loadWebLLMLib();
    const cfg = PROVIDERS.webllm;
    if (window.__dcWebLLMEnginePromise) return window.__dcWebLLMEnginePromise;
    window.__dcWebLLMEnginePromise = window.webllm.CreateMLCEngine(cfg.model, {
      initProgressCallback: (rep) => {
        onProgress && onProgress(rep);
      },
    }).catch(error => {
      // 失败不能缓存成永久的 rejected Promise；用户修正网络/模型配置后应可重试。
      window.__dcWebLLMEnginePromise = null;
      throw error;
    });
    return window.__dcWebLLMEnginePromise;
  }

  const AI_STEP_TYPES = new Set([
    'mask_column', 'normalize_date', 'fill_empty', 'trim_whitespace',
    'remove_duplicates', 'split_column', 'rename_column', 'delete_column', 'custom_formula',
  ]);
  const COLUMN_STEPS = new Set([
    'mask_column', 'normalize_date', 'fill_empty', 'trim_whitespace',
    'split_column', 'rename_column', 'delete_column', 'custom_formula',
  ]);

  function validateAISteps(input, headers) {
    const steps = [], errors = [];
    if (!Array.isArray(input)) return { steps, errors: ['steps 必须是数组'] };
    input.slice(0, 50).forEach((step, index) => {
      const label = '步骤 ' + (index + 1);
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        errors.push(label + '：必须是对象'); return;
      }
      if (!AI_STEP_TYPES.has(step.type)) {
        errors.push(label + '：不支持的类型 ' + String(step.type || '(空)')); return;
      }
      if (COLUMN_STEPS.has(step.type)) {
        if (typeof step.column !== 'string' || !step.column.trim()) {
          errors.push(label + '：缺少有效 column'); return;
        }
        if (Array.isArray(headers) && headers.indexOf(step.column) < 0) {
          errors.push(label + '：找不到列 ' + step.column); return;
        }
      }
      if (step.type === 'normalize_date' && step.target_format !== undefined
          && !['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY/MM/DD', 'YYYY.MM.DD'].includes(step.target_format)) {
        errors.push(label + '：target_format 不受支持'); return;
      }
      if (step.type === 'fill_empty' && step.strategy !== undefined
          && !['custom', 'mean', 'median'].includes(step.strategy)) {
        errors.push(label + '：strategy 不受支持'); return;
      }
      if (step.type === 'mask_column' && step.pattern !== undefined
          && (typeof step.pattern !== 'string' || !step.pattern || step.pattern.length > 200)) {
        errors.push(label + '：pattern 必须是不超过 200 字符的非空字符串'); return;
      }
      if (step.type === 'split_column') {
        if (step.separator !== undefined && (typeof step.separator !== 'string' || !step.separator || step.separator.length > 20)) {
          errors.push(label + '：separator 必须是 1–20 字符'); return;
        }
        if (step.new_columns !== undefined && (!Array.isArray(step.new_columns)
            || step.new_columns.length > 20 || step.new_columns.some(n => typeof n !== 'string' || !n.trim()))) {
          errors.push(label + '：new_columns 必须是有效列名数组'); return;
        }
      }
      if (step.type === 'rename_column'
          && ![step.new_name, step.to].some(n => typeof n === 'string' && n.trim())) {
        errors.push(label + '：缺少 new_name'); return;
      }
      if (step.type === 'custom_formula') {
        const formula = step.formula || step.expression;
        if (typeof formula !== 'string' || !formula.trim() || formula.length > 1000) {
          errors.push(label + '：缺少有效 formula'); return;
        }
        try {
          if (window.DCRules) window.DCRules.compileArithmetic(formula, headers ? headers.length : 10000);
        } catch (e) { errors.push(label + '：' + e.message); return; }
      }
      steps.push(step);
    });
    if (input.length > 50) errors.push('最多接受 50 个步骤，其余已忽略');
    return { steps, errors };
  }

  // ---- 解析 AI 响应中的 JSON 块 ----
  function parseAIResponse(text, headers) {
    if (!text) return { analysis: '', steps: [] };
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    let jsonStr = fence ? fence[1] : text;
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    }
    let parsed = null;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      try {
        parsed = JSON.parse(jsonStr.replace(/,\s*([\]}])/g, '$1'));
      } catch (e2) {
        return { analysis: text, steps: [], error: 'JSON 解析失败：' + e.message };
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { analysis: text, steps: [], errors: ['AI 响应必须是 JSON 对象'], error: 'AI 响应必须是 JSON 对象' };
    }
    const validation = validateAISteps(parsed.steps || [], headers);
    return { analysis: parsed.analysis || '', steps: validation.steps, errors: validation.errors, raw: parsed };
  }

  // ---- 简易 Markdown 渲染 ----
  // 使用 chr() 形式避免被自动格式化器影响
  const AMP = String.fromCharCode(38) + 'amp;';
  const LT = String.fromCharCode(38) + 'lt;';
  const GT = String.fromCharCode(38) + 'gt;';
  function escHtml(s) {
    return String(s)
      .replace(/&/g, AMP)
      .replace(/</g, LT)
      .replace(/>/g, GT);
  }
  function renderMarkdown(md) {
    if (!md) return '';
    let html = escHtml(md);
    // 代码块
    html = html.replace(/```(\w+)?\n?([\s\S]*?)```/g, function (m, lang, code) {
      return '<pre class="md-code"><code>' + code.replace(/\n$/, '') + '</code></pre>';
    });
    // 标题
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
    // 粗体
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // 行内代码
    html = html.replace(/`([^`\n]+)`/g, '<code class="md-inline">$1</code>');
    // 列表
    html = html.replace(/(?:^|\n)((?:- .+(?:\n|$))+)/g, function (m, block) {
      const items = block.trim().split('\n').map(l => l.replace(/^- /, '').trim());
      return '<ul>' + items.map(it => '<li>' + it + '</li>').join('') + '</ul>';
    });
    // 数字列表
    html = html.replace(/(?:^|\n)((?:\d+\. .+(?:\n|$))+)/g, function (m, block) {
      const items = block.trim().split('\n').map(l => l.replace(/^\d+\. /, '').trim());
      return '<ol>' + items.map(it => '<li>' + it + '</li>').join('') + '</ol>';
    });
    // 引用
    html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
    // 段落
    html = html.split(/\n{2,}/).map(p => {
      if (/^\s*<(h\d|ul|ol|pre|blockquote)/.test(p)) return p;
      return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('\n');
    return html;
  }

  // ---- 统一入口 ----
  async function chat({ provider, apiKey, instruction, headers, sampleRows, conversation, onChunk, signal, onProgress }) {
    if (provider === 'mock') return runMock({ instruction, headers, sampleRows, onChunk, signal });
    if (provider === 'webllm') {
      if (signal && signal.aborted) throw new DOMException('已取消', 'AbortError');
      const enginePromise = window.__dcWebLLMEnginePromise || initWebLLM(rep => {
        if ((!signal || !signal.aborted) && onProgress) onProgress(rep);
      });
      // 不等待权重下载才进入取消逻辑；底层下载可继续完成并供下一次复用。
      return runWebLLM({ instruction, headers, sampleRows, conversation, onChunk, signal, enginePromise });
    }
    return runOpenAICompat({ provider, apiKey, instruction, headers, sampleRows, conversation, onChunk, signal });
  }

  window.DCAI = {
    PROVIDERS,
    SYSTEM_PROMPT,
    chat,
    parseAIResponse,
    validateAISteps,
    renderMarkdown,
    heuristicSteps,
    initWebLLM,
  };
})();