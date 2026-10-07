/* ============================================
   DataCleaner Pro · AI · 规则引擎
   8 条内置规则 + AI 智能清洗（mask/normalize/fill/trim/dedupe/split/rename/delete/formula）
   每个规则：apply(headers, rows, opts) -> { headers, rows, changed, log }
   ============================================ */

(function () {
  'use strict';

  // ---- 工具函数 ----
  function isNull(v) {
    return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  }
  function toStr(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString();
    return String(v);
  }
  function toNum(v) {
    if (v === null || v === undefined || v === '') return NaN;
    if (typeof v === 'number') return v;
    const cleaned = String(v).replace(/[^\d.\-eE]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.') return NaN;
    return parseFloat(cleaned);
  }
  function isNumericColumn(rows, colIdx) {
    let total = 0, nums = 0;
    for (let i = 0; i < rows.length && i < 100; i++) {
      const v = rows[i][colIdx];
      if (!isNull(v)) {
        total++;
        if (!isNaN(toNum(v))) nums++;
      }
    }
    return total > 0 && nums / total > 0.7;
  }
  function isDateColumn(rows, colIdx) {
    let total = 0, dates = 0;
    for (let i = 0; i < rows.length && i < 100; i++) {
      const v = rows[i][colIdx];
      if (!isNull(v)) {
        total++;
        const s = toStr(v).trim();
        if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(s) ||
            /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(s) ||
            !isNaN(Date.parse(s))) {
          dates++;
        }
      }
    }
    return total > 0 && dates / total > 0.6;
  }

  // 查找列索引（按列名或索引）
  function resolveCol(headers, col) {
    if (col === undefined || col === null || col === '') return -1;
    if (typeof col === 'number') return col >= 0 && col < headers.length ? col : -1;
    const idx = headers.indexOf(String(col));
    return idx;
  }

  // ---- 规则 1: 清除空行/空列 ----
  const ruleEmpty = {
    id: 'empty', name: '清除空行/列', desc: '删除全空行/全空列', defaultOn: true,
    apply(headers, rows, opts, ctx) {
      const mode = opts.mode || 'rows';
      const removedRows = new Set();
      const removedCols = new Set();
      let newRows = rows;

      if (mode === 'rows' || mode === 'both') {
        newRows = [];
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].every(c => isNull(c))) {
            removedRows.add(i);
            ctx.log(`  - 删除空行 #${i + 1}`);
          } else {
            newRows.push(rows[i]);
          }
        }
      }
      let newHeaders = headers;
      if (mode === 'cols' || mode === 'both') {
        const colCount = headers.length;
        const newColIdx = [];
        for (let j = 0; j < colCount; j++) {
          let isAllNull = true;
          for (let i = 0; i < newRows.length; i++) {
            if (!isNull(newRows[i][j])) { isAllNull = false; break; }
          }
          if (isAllNull) {
            removedCols.add(j);
            ctx.log(`  - 删除空列 "${headers[j]}"`);
          } else {
            newColIdx.push(j);
          }
        }
        if (removedCols.size > 0) {
          newHeaders = newColIdx.map(j => headers[j]);
          newRows = newRows.map(r => newColIdx.map(j => r[j]));
        }
      }
      ctx.log(`清除空行/列 · 删除 ${removedRows.size} 行 ${removedCols.size} 列`);
      return { headers: newHeaders, rows: newRows, removedRows, removedCols, log: '' };
    }
  };

  // ---- 规则 2: 填充缺失值 ----
  const ruleFill = {
    id: 'fill', name: '填充缺失值', desc: '使用均值/中位数/前值/自定义填充', defaultOn: false,
    apply(headers, rows, opts, ctx) {
      const strategy = opts.strategy || 'forward';
      const customVal = opts.customVal;
      const changed = new Set();
      let count = 0;

      for (let j = 0; j < headers.length; j++) {
        const nums = isNumericColumn(rows, j);
        let fillVal;
        if (strategy === 'zero') fillVal = 0;
        else if (strategy === 'mean' && nums) {
          let sum = 0, n = 0;
          for (let i = 0; i < rows.length; i++) { const v = toNum(rows[i][j]); if (!isNaN(v)) { sum += v; n++; } }
          fillVal = n > 0 ? sum / n : 0;
        } else if (strategy === 'median' && nums) {
          const arr = [];
          for (let i = 0; i < rows.length; i++) { const v = toNum(rows[i][j]); if (!isNaN(v)) arr.push(v); }
          arr.sort((a, b) => a - b);
          fillVal = arr.length ? arr[Math.floor(arr.length / 2)] : 0;
        } else if (strategy === 'custom') {
          fillVal = customVal !== undefined && customVal !== '' ? customVal : 'N/A';
          if (nums && customVal !== '' && !isNaN(toNum(customVal))) fillVal = toNum(customVal);
        }

        if (strategy === 'forward') {
          let last = '';
          for (let i = 0; i < rows.length; i++) {
            if (isNull(rows[i][j])) {
              rows[i][j] = last;
              changed.add(`${i}:${j}`); count++;
            } else {
              last = rows[i][j];
            }
          }
        } else {
          for (let i = 0; i < rows.length; i++) {
            if (isNull(rows[i][j])) {
              rows[i][j] = fillVal;
              changed.add(`${i}:${j}`); count++;
            }
          }
        }
      }
      ctx.log(`填充缺失值 · 策略=${strategy} · 填充 ${count} 个单元格`);
      return { headers, rows, changed, log: '' };
    }
  };

  // ---- 规则 3: 文本清理 ----
  const ruleText = {
    id: 'text', name: '文本清理', desc: '去空格/去特殊字符/大小写', defaultOn: true,
    apply(headers, rows, opts, ctx) {
      const trim = opts.trim !== false;
      const removeSpecial = !!opts.removeSpecial;
      const caseMode = opts.caseMode || 'none';
      const changed = new Set();
      let count = 0;
      for (let j = 0; j < headers.length; j++) {
        for (let i = 0; i < rows.length; i++) {
          let v = rows[i][j];
          if (isNull(v)) continue;
          let s = toStr(v);
          const orig = s;
          if (trim) s = s.trim().replace(/\s+/g, ' ');
          if (removeSpecial) s = s.replace(/[^\w\s一-龥\-@.,]/g, '');
          if (caseMode === 'upper') s = s.toUpperCase();
          else if (caseMode === 'lower') s = s.toLowerCase();
          else if (caseMode === 'title') s = s.replace(/\b\w/g, c => c.toUpperCase());
          if (s !== orig) {
            rows[i][j] = s;
            changed.add(`${i}:${j}`); count++;
          }
        }
      }
      ctx.log(`文本清理 · 清理 ${count} 个单元格`);
      return { headers, rows, changed, log: '' };
    }
  };

  // ---- 规则 4: 查找替换 ----
  const ruleReplace = {
    id: 'replace', name: '查找替换', desc: '文本全局替换', defaultOn: false,
    apply(headers, rows, opts, ctx) {
      const find = opts.find || '';
      const replaceWith = opts.replaceWith || '';
      if (find === '') { ctx.log('查找替换 · 跳过（查找内容为空）'); return { headers, rows, changed: new Set(), log: '' }; }
      const changed = new Set();
      let count = 0;
      for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < headers.length; j++) {
          const v = rows[i][j];
          if (isNull(v)) continue;
          const s = toStr(v);
          if (s.indexOf(find) !== -1) {
            const ns = s.split(find).join(replaceWith);
            rows[i][j] = ns;
            changed.add(`${i}:${j}`); count++;
          }
        }
      }
      ctx.log(`查找替换 · "${find}" → "${replaceWith}" · ${count} 处`);
      return { headers, rows, changed, log: '' };
    }
  };

  // ---- 规则 5: 拆分列 ----
  const ruleSplit = {
    id: 'split', name: '拆分列', desc: '按分隔符拆分列', defaultOn: false,
    apply(headers, rows, opts, ctx) {
      const colIdx = parseInt(opts.colIdx, 10);
      const sep = opts.sep || ',';
      const maxParts = parseInt(opts.maxParts, 10) || 3;
      if (isNaN(colIdx) || colIdx < 0 || colIdx >= headers.length) {
        ctx.log('拆分列 · 跳过（列未选）');
        return { headers, rows, changed: new Set(), log: '' };
      }
      const colName = headers[colIdx];
      const newColNames = [];
      for (let k = 0; k < maxParts; k++) newColNames.push(`${colName}_${k + 1}`);
      const newHeaders = headers.slice(0, colIdx).concat(newColNames).concat(headers.slice(colIdx + 1));
      const newRows = rows.map(r => {
        const v = r[colIdx];
        const parts = isNull(v) ? Array(maxParts).fill('') : toStr(v).split(sep).map(s => s.trim());
        while (parts.length < maxParts) parts.push('');
        if (parts.length > maxParts) parts.length = maxParts;
        return r.slice(0, colIdx).concat(parts).concat(r.slice(colIdx + 1));
      });
      ctx.log(`拆分列 · "${colName}" → ${newColNames.join('+')}`);
      return { headers: newHeaders, rows: newRows, changed: new Set(), log: '' };
    }
  };

  // ---- 规则 6: 日期标准化 ----
  const ruleDate = {
    id: 'date', name: '日期标准化', desc: '把日期统一成 YYYY-MM-DD', defaultOn: false,
    apply(headers, rows, opts, ctx) {
      const changed = new Set();
      let count = 0;
      const targets = opts.targets && opts.targets.length
        ? opts.targets.map(t => resolveCol(headers, t)).filter(i => i >= 0)
        : headers.map((_, i) => i).filter(i => isDateColumn(rows, i));
      for (const j of targets) {
        for (let i = 0; i < rows.length; i++) {
          const v = rows[i][j];
          if (isNull(v)) continue;
          let s = toStr(v).trim();
          if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) {
            const norm = s.replace(/^(\d{4})-(\d{1,2})-(\d{1,2}).*/, (m, y, mo, d) => y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'));
            if (norm !== v) { rows[i][j] = norm; changed.add(`${i}:${j}`); count++; }
            continue;
          }
          const d = new Date(s);
          if (!isNaN(d.getTime())) {
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            const norm = `${yyyy}-${mm}-${dd}`;
            if (norm !== s) { rows[i][j] = norm; changed.add(`${i}:${j}`); count++; }
          }
        }
      }
      ctx.log(`日期标准化 · ${targets.length} 列 · 标准化 ${count} 个单元格`);
      return { headers, rows, changed, log: '' };
    }
  };

  // ---- 规则 7: 数字清理 ----
  const ruleNumber = {
    id: 'number', name: '数字清理', desc: '去除非数字字符 / 手机号脱敏', defaultOn: false,
    apply(headers, rows, opts, ctx) {
      const strip = !!opts.strip;
      const phone = !!opts.phone;
      const changed = new Set();
      let count = 0;
      const targets = opts.targets && opts.targets.length
        ? opts.targets.map(t => resolveCol(headers, t)).filter(i => i >= 0)
        : headers.map((_, i) => i).filter(i => isNumericColumn(rows, i));
      for (const j of targets) {
        for (let i = 0; i < rows.length; i++) {
          const v = rows[i][j];
          if (isNull(v)) continue;
          let s = toStr(v).trim();
          const orig = s;
          if (strip) s = s.replace(/[^\d.\-]/g, '');
          if (phone) {
            const digits = s.replace(/\D/g, '');
            if (digits.length === 11) {
              s = digits.substring(0, 3) + '****' + digits.substring(7);
            } else if (digits.length > 11) {
              s = digits.substring(digits.length - 11, digits.length - 7) + '****' + digits.substring(digits.length - 4);
            }
          }
          if (s !== orig) { rows[i][j] = s; changed.add(`${i}:${j}`); count++; }
        }
      }
      ctx.log(`数字清理 · ${targets.length} 列 · 处理 ${count} 个单元格`);
      return { headers, rows, changed, log: '' };
    }
  };

  // ---- 规则 8: 列选择 ----
  const ruleCols = {
    id: 'cols', name: '列选择', desc: '只保留指定列', defaultOn: false,
    apply(headers, rows, opts, ctx) {
      const keep = (opts.keep || []).map(i => parseInt(i, 10)).filter(i => !isNaN(i) && i >= 0 && i < headers.length);
      if (keep.length === 0) {
        ctx.log('列选择 · 跳过（未选择列）');
        return { headers, rows, changed: new Set(), log: '' };
      }
      const newHeaders = keep.map(i => headers[i]);
      const newRows = rows.map(r => keep.map(i => r[i]));
      ctx.log(`列选择 · 保留 ${keep.length}/${headers.length} 列`);
      return { headers: newHeaders, rows: newRows, changed: new Set(), log: '' };
    }
  };

  // ---- 规则 9: 删除重复行 ----
  const ruleDedupe = {
    id: 'remove', name: '删除重复行', desc: '按全行或指定列去重', defaultOn: false,
    apply(headers, rows, opts, ctx) {
      const keys = (opts.keys || []).map(k => resolveCol(headers, k)).filter(i => i >= 0);
      const seen = new Set();
      const kept = [];
      const removedRows = new Set();
      for (let i = 0; i < rows.length; i++) {
        const basis = keys.length ? keys.map(j => toStr(rows[i][j]).trim()) : rows[i].map(v => toStr(v).trim());
        const key = JSON.stringify(basis);
        if (seen.has(key)) { removedRows.add(i); continue; }
        seen.add(key);
        kept.push(rows[i]);
      }
      ctx.log(`删除重复行 · ${keys.length ? '依据列 ' + keys.map(j => headers[j]).join('+') : '全行比对'} · 删除 ${removedRows.size} 行`);
      return { headers, rows: kept, changed: new Set(), removedRows, log: '' };
    }
  };

  // ---- AI 规则: 由 AI 生成的步骤序列动态执行 ----
  // 单步执行器（也可被 AI 规则多条步骤复用）
  const AI_STEP_EXECUTORS = {
    // 脱敏列：keep_first(N) + '****' + keep_last(M)
    mask_column(headers, rows, opts, ctx) {
      const colIdx = resolveCol(headers, opts.column);
      if (colIdx < 0) throw new Error(`找不到列 "${opts.column}"`);
      const pattern = opts.pattern || "keep_first(3) + '****' + keep_last(4)";
      const keepFirstMatch = pattern.match(/keep_first\((\d+)\)/);
      const keepLastMatch = pattern.match(/keep_last\((\d+)\)/);
      const fillMatch = pattern.match(/'([^']*)'/);
      const keepFirst = keepFirstMatch ? parseInt(keepFirstMatch[1], 10) : 3;
      const keepLast = keepLastMatch ? parseInt(keepLastMatch[1], 10) : 4;
      const fill = fillMatch ? fillMatch[1] : '****';
      const changed = new Set();
      let count = 0;
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i][colIdx];
        if (isNull(v)) continue;
        const s = toStr(v);
        const digits = s.replace(/\D/g, '');
        let masked;
        if (digits.length >= keepFirst + keepLast) {
          masked = digits.substring(0, keepFirst) + fill + digits.substring(digits.length - keepLast);
        } else {
          masked = s.substring(0, keepFirst) + fill + s.substring(Math.max(0, s.length - keepLast));
        }
        if (masked !== s) {
          rows[i][colIdx] = masked;
          changed.add(`${i}:${colIdx}`); count++;
        }
      }
      ctx.log(`  · [mask] ${headers[colIdx]} · 隐藏 ${count} 个`);
      return { count, changed };
    },
    // 标准化日期
    normalize_date(headers, rows, opts, ctx) {
      const colIdx = resolveCol(headers, opts.column);
      if (colIdx < 0) throw new Error(`找不到列 "${opts.column}"`);
      const fmt = opts.target_format || 'YYYY-MM-DD';
      const changed = new Set();
      let count = 0;
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i][colIdx];
        if (isNull(v)) continue;
        const s = toStr(v).trim();
        let out = s;
        // 解析多种格式
        const d = new Date(s);
        if (isNaN(d.getTime())) {
          // 尝试 yyyy/mm/dd 或 dd/mm/yyyy
          const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
          if (m) {
            out = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
          } else {
            const m2 = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
            if (m2) {
              const y = m2[3].length === 2 ? '20' + m2[3] : m2[3];
              out = `${y}-${m2[1].padStart(2,'0')}-${m2[2].padStart(2,'0')}`;
            } else {
              continue;
            }
          }
        } else {
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          if (fmt === 'YYYY-MM-DD') out = `${yyyy}-${mm}-${dd}`;
          else if (fmt === 'DD/MM/YYYY') out = `${dd}/${mm}/${yyyy}`;
          else if (fmt === 'MM/DD/YYYY') out = `${mm}/${dd}/${yyyy}`;
          else if (fmt === 'YYYY/MM/DD') out = `${yyyy}/${mm}/${dd}`;
          else if (fmt === 'YYYY.MM.DD') out = `${yyyy}.${mm}.${dd}`;
          else out = `${yyyy}-${mm}-${dd}`;
        }
        if (out !== s) {
          rows[i][colIdx] = out;
          changed.add(`${i}:${colIdx}`); count++;
        }
      }
      ctx.log(`  · [date] ${headers[colIdx]} → ${fmt} · 标准化 ${count} 个`);
      return { count, changed };
    },
    // 填充空值
    fill_empty(headers, rows, opts, ctx) {
      const colIdx = resolveCol(headers, opts.column);
      if (colIdx < 0) throw new Error(`找不到列 "${opts.column}"`);
      const strategy = opts.strategy || 'custom';
      const value = opts.value !== undefined ? opts.value : 'N/A';
      const changed = new Set();
      let count = 0;
      let fillVal = value;
      if (strategy === 'mean' || strategy === 'median') {
        const arr = [];
        for (let i = 0; i < rows.length; i++) {
          const v = rows[i][colIdx];
          if (!isNull(v)) { const n = toNum(v); if (!isNaN(n)) arr.push(n); }
        }
        if (arr.length) {
          if (strategy === 'mean') {
            fillVal = arr.reduce((a, b) => a + b, 0) / arr.length;
          } else {
            arr.sort((a, b) => a - b);
            fillVal = arr[Math.floor(arr.length / 2)];
          }
        }
      }
      for (let i = 0; i < rows.length; i++) {
        if (isNull(rows[i][colIdx])) {
          rows[i][colIdx] = fillVal;
          changed.add(`${i}:${colIdx}`); count++;
        }
      }
      ctx.log(`  · [fill] ${headers[colIdx]} · 策略=${strategy} · 填充 ${count} 个`);
      return { count, changed };
    },
    // 去除空白
    trim_whitespace(headers, rows, opts, ctx) {
      const colIdx = resolveCol(headers, opts.column);
      if (colIdx < 0) throw new Error(`找不到列 "${opts.column}"`);
      const changed = new Set();
      let count = 0;
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i][colIdx];
        if (isNull(v)) continue;
        const s = toStr(v);
        const ns = s.trim().replace(/\s+/g, ' ');
        if (ns !== s) { rows[i][colIdx] = ns; changed.add(`${i}:${colIdx}`); count++; }
      }
      ctx.log(`  · [trim] ${headers[colIdx]} · ${count} 个`);
      return { count, changed };
    },
    // 去重
    remove_duplicates(headers, rows, opts, ctx) {
      const seen = new Set();
      const kept = [];
      const removed = new Set();
      for (let i = 0; i < rows.length; i++) {
        const key = JSON.stringify(rows[i]);
        if (seen.has(key)) { removed.add(i); continue; }
        seen.add(key);
        kept.push(rows[i]);
      }
      rows.length = 0;
      for (const r of kept) rows.push(r);
      ctx.log(`  · [dedup] 删除 ${removed.size} 重复行`);
      return { count: removed.size };
    },
    // 拆分列
    split_column(headers, rows, opts, ctx) {
      const colIdx = resolveCol(headers, opts.column);
      if (colIdx < 0) throw new Error(`找不到列 "${opts.column}"`);
      const sep = opts.separator || opts.sep || ',';
      const newColNames = opts.new_columns || [`${headers[colIdx]}_1`, `${headers[colIdx]}_2`];
      const newHeaders = headers.slice(0, colIdx).concat(newColNames).concat(headers.slice(colIdx + 1));
      const newRows = rows.map(r => {
        const v = r[colIdx];
        const parts = isNull(v) ? Array(newColNames.length).fill('') : toStr(v).split(sep).map(s => s.trim());
        while (parts.length < newColNames.length) parts.push('');
        if (parts.length > newColNames.length) parts.length = newColNames.length;
        return r.slice(0, colIdx).concat(parts).concat(r.slice(colIdx + 1));
      });
      headers.length = 0;
      for (const h of newHeaders) headers.push(h);
      rows.length = 0;
      for (const r of newRows) rows.push(r);
      ctx.log(`  · [split] ${opts.column} → ${newColNames.join('+')}`);
      return { count: 0, newHeaders: newHeaders.length };
    },
    // 重命名列
    rename_column(headers, rows, opts, ctx) {
      const colIdx = resolveCol(headers, opts.column);
      if (colIdx < 0) throw new Error(`找不到列 "${opts.column}"`);
      const newName = opts.new_name || opts.to;
      if (!newName) throw new Error('rename 缺少 new_name');
      const old = headers[colIdx];
      headers[colIdx] = newName;
      ctx.log(`  · [rename] ${old} → ${newName}`);
      return { count: 0 };
    },
    // 删除列
    delete_column(headers, rows, opts, ctx) {
      const colIdx = resolveCol(headers, opts.column);
      if (colIdx < 0) throw new Error(`找不到列 "${opts.column}"`);
      headers.splice(colIdx, 1);
      for (let i = 0; i < rows.length; i++) rows[i].splice(colIdx, 1);
      ctx.log(`  · [delete] ${opts.column}`);
      return { count: 0 };
    },
    // 自定义公式（受限）：支持 + - * / 和常量
    custom_formula(headers, rows, opts, ctx) {
      const colIdx = resolveCol(headers, opts.column);
      if (colIdx < 0) throw new Error(`找不到列 "${opts.column}"`);
      const expr = opts.formula || opts.expression;
      if (!expr) throw new Error('custom_formula 缺少 formula');
      // 仅允许 数字 / + - * / ( ) . 空格 和变量 col:索引
      if (!/^[\d+\-*/().\s,a-zA-Z_0-9:]+$/.test(expr)) throw new Error('公式包含不安全字符');
      const changed = new Set();
      let count = 0;
      // 解析 col:N 引用
      const refs = [];
      const exp2 = expr.replace(/col:(\d+)/g, (_, idx) => {
        refs.push(parseInt(idx, 10));
        return '__c' + (refs.length - 1) + '__';
      });
      for (let i = 0; i < rows.length; i++) {
        try {
          let body = exp2;
          for (let k = 0; k < refs.length; k++) {
            const v = rows[i][refs[k]];
            const n = toNum(v);
            body = body.split('__c' + k + '__').join(isNaN(n) ? '0' : String(n));
          }
          // eslint-disable-next-line no-new-func
          const result = Function('"use strict"; return (' + body + ')')();
          if (typeof result === 'number' && !isNaN(result)) {
            rows[i][colIdx] = result;
            changed.add(`${i}:${colIdx}`); count++;
          }
        } catch (e) {
          // 单行失败不抛
        }
      }
      ctx.log(`  · [formula] ${opts.column} = ${expr} · ${count} 个`);
      return { count, changed };
    },
  };

  const ruleAI = {
    id: 'ai', name: 'AI 智能清洗', desc: '由 AI 解析自然语言指令并生成清洗步骤', defaultOn: false,
    apply(headers, rows, opts, ctx) {
      // opts.steps: [{type, column, ...}]
      const steps = opts.steps || [];
      if (steps.length === 0) {
        ctx.log('AI 清洗 · 跳过（无步骤）');
        return { headers, rows, changed: new Set(), log: '' };
      }
      const allChanged = new Set();
      const snapshot = JSON.parse(JSON.stringify(rows));
      const headersSnap = headers.slice();
      try {
        for (const step of steps) {
          const exec = AI_STEP_EXECUTORS[step.type];
          if (!exec) throw new Error(`不支持的步骤类型: ${step.type}`);
          // 注意：split/delete 会改 headers，需要重置
          const ret = exec(headers, rows, step, ctx);
          if (ret && ret.changed) {
            ret.changed.forEach(k => allChanged.add(k));
          }
        }
        ctx.log(`AI 清洗 · 共 ${steps.length} 步 · 完成`);
        return { headers, rows, changed: allChanged, log: '' };
      } catch (err) {
        // 回滚
        headers.length = 0;
        for (const h of headersSnap) headers.push(h);
        rows.length = 0;
        for (const r of snapshot) rows.push(r);
        throw err;
      }
    },
  };

  // 暴露 AI 步骤执行器（供调试和工具使用）
  const RULES = [ruleEmpty, ruleFill, ruleText, ruleReplace, ruleSplit, ruleDate, ruleNumber, ruleCols, ruleDedupe, ruleAI];

  // 兼容层：rule.run(headers, rows, opts) —— 单条规则独立调用（测试/脚本用）
  RULES.forEach(def => {
    def.run = function (headers, rows, opts) {
      const logLines = [];
      const ctx = { log(m) { logLines.push(m); } };
      const h = headers.slice();
      const r = rows.map(x => x.slice());
      const res = def.apply(h, r, opts || {}, ctx);
      return {
        headers: res.headers, rows: res.rows,
        changed: res.changed || new Set(),
        removedRows: res.removedRows || new Set(),
        log: logLines,
      };
    };
  });

  function runPipeline(activeRules, headers, rows, onProgress) {
    let curHeaders = headers;
    let curRows = rows;
    const allChanged = new Set();
    const allRemoved = new Set();
    const allRemovedCols = new Set();
    const logLines = [];
    const ctx = { log(msg) { logLines.push(msg); } };
    let totalModified = 0;

    for (let idx = 0; idx < activeRules.length; idx++) {
      const ar = activeRules[idx];
      const def = RULES.find(r => r.id === ar.ruleId);
      if (!def) continue;
      onProgress && onProgress(idx / activeRules.length, ar.ruleId);

      // 对 AI 规则：浅拷贝 curRows 让 AI 内部修改的是自己的数组（回滚友好）
      let workingRows = curRows;
      if (def.id === 'ai') {
        workingRows = curRows.map(r => r.slice());
      }
      const workingHeaders = def.id === 'ai' ? curHeaders.slice() : curHeaders;
      const result = def.apply(workingHeaders, workingRows, ar.opts || {}, ctx);
      if (def.id === 'ai') {
        curHeaders = result.headers;
        curRows = result.rows;
      } else {
        curHeaders = result.headers;
        curRows = result.rows;
      }
      if (result.changed) {
        result.changed.forEach(k => { allChanged.add(k); totalModified++; });
      }
      if (result.removedRows) result.removedRows.forEach(i => allRemoved.add(i));
      if (result.removedCols) result.removedCols.forEach(j => allRemovedCols.add(j));
    }
    onProgress && onProgress(1, 'done');

    return {
      headers: curHeaders,
      rows: curRows,
      changed: allChanged,
      removed: allRemoved,
      removedCols: allRemovedCols,
      modifiedCount: totalModified,
      log: logLines,
    };
  }

  function computeDiff(beforeHeaders, beforeRows, afterHeaders, afterRows) {
    const colMap = new Map();
    for (let i = 0; i < afterHeaders.length; i++) {
      const idx = beforeHeaders.indexOf(afterHeaders[i]);
      if (idx >= 0) colMap.set(i, idx);
    }
    const beforeKey = (r) => JSON.stringify(r);
    const beforeMap = new Map();
    beforeRows.forEach((r, i) => beforeMap.set(beforeKey(r), i));
    const afterMap = new Map();
    afterRows.forEach((r, i) => afterMap.set(beforeKey(r), i));
    const added = [], deleted = [], modified = [];
    const minLen = Math.min(beforeRows.length, afterRows.length);
    for (let i = 0; i < minLen; i++) {
      const b = beforeRows[i], a = afterRows[i];
      if (beforeKey(b) !== beforeKey(a)) {
        const changedCols = new Set();
        for (let j = 0; j < afterHeaders.length; j++) {
          if (a[j] !== b[colMap.get(j)]) changedCols.add(j);
        }
        modified.push({ before: b, after: a, changedCols });
      }
    }
    if (afterRows.length > beforeRows.length) {
      for (let i = beforeRows.length; i < afterRows.length; i++) added.push({ after: afterRows[i] });
    }
    if (beforeRows.length > afterRows.length) {
      for (let i = afterRows.length; i < beforeRows.length; i++) deleted.push({ before: beforeRows[i] });
    }
    return { added, deleted, modified };
  }

  // 数据质量分析（用于 AI 自动修复建议）
  function analyzeQuality(headers, rows) {
    const issues = [];
    if (!rows.length) return issues;
    headers.forEach((h, j) => {
      let nullCount = 0, total = 0;
      const dateFormats = new Set();
      const phoneLike = [];
      const outliers = [];
      let numericArr = [];
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i][j];
        total++;
        if (isNull(v)) { nullCount++; continue; }
        const s = toStr(v).trim();
        // 日期格式多样性
        if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(s) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(s)) {
          // 提取分隔符
          const sepMatch = s.match(/[-/.]/);
          if (sepMatch) dateFormats.add(sepMatch[0]);
        }
        // 手机号识别
        if (/^1[3-9]\d{9}$/.test(s.replace(/\D/g, '').length === 11 ? s : '')) {
          phoneLike.push(i);
        }
        // 数字异常
        const n = toNum(s);
        if (!isNaN(n) && s !== '' && /[a-zA-Z一-龥]/.test(s) === false) {
          numericArr.push(n);
        }
      }
      const nullRate = nullCount / total;
      if (nullRate > 0.1) {
        issues.push({ column: h, type: 'missing', rate: nullRate.toFixed(2), message: `"${h}" 列有 ${(nullRate*100).toFixed(1)}% 空值` });
      }
      if (dateFormats.size > 1) {
        issues.push({ column: h, type: 'date_inconsistent', formats: [...dateFormats].join(','), message: `"${h}" 列日期格式混用: ${[...dateFormats].join(',')}` });
      }
      // 数值离群
      if (numericArr.length > 5) {
        numericArr.sort((a, b) => a - b);
        const q1 = numericArr[Math.floor(numericArr.length * 0.25)];
        const q3 = numericArr[Math.floor(numericArr.length * 0.75)];
        const iqr = q3 - q1;
        const lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
        const outCount = numericArr.filter(n => n < lo || n > hi).length;
        if (outCount / numericArr.length > 0.05) {
          issues.push({ column: h, type: 'outliers', count: outCount, message: `"${h}" 列有 ${outCount} 个离群值` });
        }
      }
    });
    return issues;
  }

  window.DCRules = {
    RULES, runPipeline, computeDiff, analyzeQuality, AI_STEP_EXECUTORS,
  };
})();