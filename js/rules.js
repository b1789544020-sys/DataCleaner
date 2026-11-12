/* ============================================
   DataCleaner Pro · AI · 规则引擎
   13 条内置规则 + AI 智能清洗（mask/normalize/fill/trim/dedupe/split/rename/delete/formula）
   每个规则：apply(headers, rows, opts) -> { headers, rows, changed, log }
   ============================================ */

function createDCRules() {
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
        if (parseDateParts(v)) dates++;
      }
    }
    return total > 0 && dates / total > 0.6;
  }

  function isValidDateParts(y, m, d) {
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
    if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return d <= days[m - 1];
  }

  // 不用 new Date 猜测日期：它会悄悄把 2 月 30 日归一化成 3 月。
  // 无歧义时沿用旧行为，把 05/06/2024 解释为 MM/DD/YYYY。
  function parseDateParts(value) {
    if (value instanceof Date) {
      return isNaN(value.getTime()) ? null : { y: value.getFullYear(), m: value.getMonth() + 1, d: value.getDate() };
    }
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    let match = s.match(/^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(.*)$/);
    let y, m, d;
    if (match) {
      y = Number(match[1]); m = Number(match[3]); d = Number(match[4]);
    } else {
      match = s.match(/^(\d{1,2})([-/.])(\d{1,2})\2(\d{4}|\d{2})(.*)$/);
      if (!match) return null;
      const first = Number(match[1]), second = Number(match[3]);
      y = Number(match[4]);
      if (y < 100) y += 2000;
      if (first > 12) { d = first; m = second; }
      else { m = first; d = second; }
    }
    const rest = match[5];
    if (rest && rest.trim() !== '' && isNaN(Date.parse(s))) return null;
    return isValidDateParts(y, m, d) ? { y, m, d } : null;
  }

  function formatDateParts(parts, targetFormat) {
    const y = String(parts.y).padStart(4, '0');
    const m = String(parts.m).padStart(2, '0');
    const d = String(parts.d).padStart(2, '0');
    if (targetFormat === 'DD/MM/YYYY') return d + '/' + m + '/' + y;
    if (targetFormat === 'MM/DD/YYYY') return m + '/' + d + '/' + y;
    if (targetFormat === 'YYYY/MM/DD') return y + '/' + m + '/' + d;
    if (targetFormat === 'YYYY.MM.DD') return y + '.' + m + '.' + d;
    return y + '-' + m + '-' + d;
  }

  function normalizeDate(s, targetFormat) {
    const parts = parseDateParts(s);
    return parts ? formatDateParts(parts, targetFormat) : String(s == null ? '' : s).trim();
  }

  // 查找列索引（按列名或索引）
  function resolveCol(headers, col) {
    if (col === undefined || col === null || col === '') return -1;
    if (typeof col === 'number') return col >= 0 && col < headers.length ? col : -1;
    const idx = headers.indexOf(String(col));
    return idx;
  }

  const CONDITION_OPERATORS = new Set([
    'equals', 'not_equals', 'contains', 'not_contains', 'empty', 'not_empty',
    'gt', 'gte', 'lt', 'lte',
  ]);

  function strictNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    const source = toStr(value).trim();
    if (!source) return NaN;
    // 数字比较不使用宽松的 toNum：不能把 "12abc" 当作 12。
    let normalized = source;
    if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?(?:[eE][+-]?\d+)?$/.test(source)) {
      normalized = source.replace(/,/g, '');
    }
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) return NaN;
    const result = Number(normalized);
    return Number.isFinite(result) ? result : NaN;
  }

  function conditionConfigured(operator, expected) {
    if (!CONDITION_OPERATORS.has(operator)) return false;
    if (operator === 'empty' || operator === 'not_empty') return true;
    // 空字符串请显式使用 empty，避免未填条件时意外匹配或删除全表。
    if (expected === undefined || expected === null || String(expected) === '') return false;
    if (['gt', 'gte', 'lt', 'lte'].includes(operator)) return !isNaN(strictNumber(expected));
    return true;
  }

  function matchesCondition(cell, operator, expected, caseSensitive) {
    if (operator === 'empty') return isNull(cell);
    if (operator === 'not_empty') return !isNull(cell);
    if (['gt', 'gte', 'lt', 'lte'].includes(operator)) {
      const left = strictNumber(cell), right = strictNumber(expected);
      if (isNaN(left) || isNaN(right)) return false;
      if (operator === 'gt') return left > right;
      if (operator === 'gte') return left >= right;
      if (operator === 'lt') return left < right;
      return left <= right;
    }
    let left = toStr(cell), right = toStr(expected);
    if (caseSensitive !== true) {
      left = left.toLocaleLowerCase();
      right = right.toLocaleLowerCase();
    }
    if (operator === 'equals') return left === right;
    if (operator === 'not_equals') return left !== right;
    if (operator === 'contains') return left.includes(right);
    if (operator === 'not_contains') return !left.includes(right);
    return false;
  }

  function uniqueHeaderName(base, headers, reusableIndices) {
    const reusable = reusableIndices || new Set();
    const unavailable = new Set(headers.filter((_, index) => !reusable.has(index)));
    if (!unavailable.has(base)) return base;
    let suffix = 2;
    while (unavailable.has(base + '_' + suffix)) suffix++;
    return base + '_' + suffix;
  }

  function sampleRowNumbers(rows) {
    return rows.length <= 12 ? rows.join('、') : rows.slice(0, 12).join('、') + ' 等';
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

  // ---- 空值标记标准化 ----
  const ruleMissing = {
    id: 'missing', name: '空值标记', desc: '把 N/A、NULL 等完整单元格标记统一转换', defaultOn: false,
    apply(headers, rows, opts, ctx) {
      const rawTokens = Array.isArray(opts.tokens) ? opts.tokens : String(opts.tokens || '').split(/\r?\n/);
      const tokens = rawTokens.slice(0, 50).map(token => toStr(token).trim()).filter(token => token !== '');
      const includeBlank = opts.includeBlank === true;
      if (!tokens.length && !includeBlank) {
        ctx.log('空值标记 · 跳过（未配置标记，且未选择处理空白）');
        return { headers, rows, changed: new Set(), log: '' };
      }
      const targets = Array.isArray(opts.targets) && opts.targets.length
        ? [...new Set(opts.targets.map(target => resolveCol(headers, target)).filter(index => index >= 0))]
        : headers.map((_, index) => index);
      const replacement = opts.replacement === undefined || opts.replacement === null ? '' : String(opts.replacement);
      const normalizedTokens = tokens.map(token => opts.caseSensitive === true ? token : token.toLocaleLowerCase());
      const changed = new Set();
      const affectedRows = [];
      let count = 0;
      for (let i = 0; i < rows.length; i++) {
        let rowChanged = false;
        for (const j of targets) {
          const original = rows[i][j];
          const source = toStr(original).trim();
          const comparable = opts.caseSensitive === true ? source : source.toLocaleLowerCase();
          if (!((includeBlank && isNull(original)) || normalizedTokens.includes(comparable))) continue;
          if (toStr(original) === replacement) continue;
          rows[i][j] = replacement;
          changed.add(`${i}:${j}`);
          count++;
          rowChanged = true;
        }
        if (rowChanged) affectedRows.push(i + 1);
      }
      ctx.log(`空值标记 · ${targets.length} 列 · 转换 ${count} 个单元格`
        + (affectedRows.length ? ` · 数据行 ${sampleRowNumbers(affectedRows)}` : ''));
      return { headers, rows, changed, log: '' };
    },
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

  // ---- 条件整格替换 ----
  const ruleConditional = {
    id: 'conditional', name: '条件替换', desc: '满足条件时替换目标列的完整单元格', defaultOn: false,
    apply(headers, rows, opts, ctx) {
      const column = resolveCol(headers, opts.column);
      const targetColumn = resolveCol(headers, opts.targetColumn);
      const operator = opts.operator || 'equals';
      if (column < 0 || targetColumn < 0 || !conditionConfigured(operator, opts.value)) {
        ctx.log('条件替换 · 跳过（请完整配置条件列、目标列、运算符和比较值）');
        return { headers, rows, changed: new Set(), log: '' };
      }
      const replacement = opts.replaceWith === undefined || opts.replaceWith === null ? '' : String(opts.replaceWith);
      const changed = new Set();
      const affectedRows = [];
      for (let i = 0; i < rows.length; i++) {
        if (!matchesCondition(rows[i][column], operator, opts.value, opts.caseSensitive === true)) continue;
        if (toStr(rows[i][targetColumn]) === replacement) continue;
        rows[i][targetColumn] = replacement;
        changed.add(`${i}:${targetColumn}`);
        affectedRows.push(i + 1);
      }
      ctx.log(`条件替换 · 条件列 "${headers[column]}" · 目标列 "${headers[targetColumn]}" · 修改 ${affectedRows.length} 个单元格`
        + (affectedRows.length ? ` · 数据行 ${sampleRowNumbers(affectedRows)}` : ''));
      return { headers, rows, changed, log: '' };
    },
  };

  // ---- 规则 5: 拆分列 ----
  const ruleSplit = {
    id: 'split', name: '拆分列', desc: '按分隔符拆分列', defaultOn: false,
    apply(headers, rows, opts, ctx) {
      const colIdx = opts.column !== undefined
        ? resolveCol(headers, opts.column)
        : parseInt(opts.colIdx, 10);
      const sep = opts.sep || ',';
      const maxParts = Math.max(1, Math.min(20, parseInt(opts.maxParts, 10) || 3));
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

  // ---- 合并列 ----
  const ruleMerge = {
    id: 'merge', name: '合并列', desc: '按勾选顺序拼接多列，可保留原列', defaultOn: false,
    apply(headers, rows, opts, ctx) {
      const indices = Array.isArray(opts.columns)
        ? [...new Set(opts.columns.map(column => resolveCol(headers, column)).filter(index => index >= 0))]
        : [];
      if (indices.length < 2) {
        ctx.log('合并列 · 跳过（请至少选择两个有效列）');
        return { headers, rows, changed: new Set(), log: '' };
      }
      const keepOriginal = opts.keepOriginal !== false;
      const skipEmpty = opts.skipEmpty !== false;
      const separator = opts.separator === undefined || opts.separator === null ? ' ' : String(opts.separator);
      const requestedName = toStr(opts.newName).trim() || indices.map(index => headers[index]).join('_');
      const outputName = uniqueHeaderName(requestedName, headers, keepOriginal ? new Set() : new Set(indices));
      const sourceSet = new Set(indices);
      const first = indices[0];
      const newHeaders = [];
      const newRows = rows.map(row => {
        const parts = indices.map(index => row[index]);
        const merged = (skipEmpty ? parts.filter(value => !isNull(value)) : parts).map(toStr).join(separator);
        if (keepOriginal) return row.concat([merged]);
        const output = [];
        for (let j = 0; j < headers.length; j++) {
          if (j === first) output.push(merged);
          else if (!sourceSet.has(j)) output.push(row[j]);
        }
        return output;
      });
      if (keepOriginal) {
        newHeaders.push(...headers, outputName);
      } else {
        for (let j = 0; j < headers.length; j++) {
          if (j === first) newHeaders.push(outputName);
          else if (!sourceSet.has(j)) newHeaders.push(headers[j]);
        }
      }
      ctx.log(`合并列 · ${indices.map(index => headers[index]).join(' + ')} → "${outputName}" · `
        + (keepOriginal ? '保留原列' : '移除原列') + ` · ${rows.length} 行`);
      return { headers: newHeaders, rows: newRows, changed: new Set(), log: '' };
    },
  };

  // ---- 规则 6: 日期标准化 ----
  const ruleDate = {
    id: 'date', name: '日期标准化', desc: '把日期统一成 YYYY-MM-DD', defaultOn: false,
    apply(headers, rows, opts, ctx) {
      const changed = new Set();
      let count = 0, invalid = 0;
      const invalidRows = [];
      const targets = opts.targets && opts.targets.length
        ? opts.targets.map(t => resolveCol(headers, t)).filter(i => i >= 0)
        : headers.map((_, i) => i).filter(i => isDateColumn(rows, i) || /date|日期|时间|入职|注册|创建|出生/i.test(headers[i]));
      for (const j of targets) {
        for (let i = 0; i < rows.length; i++) {
          const v = rows[i][j];
          if (isNull(v)) continue;
          const parts = parseDateParts(v);
          if (!parts) {
            invalid++;
            if (invalidRows.length < 12) invalidRows.push(i + 1);
            continue;
          }
          const norm = formatDateParts(parts, opts.targetFormat || 'YYYY-MM-DD');
          if (norm !== v) { rows[i][j] = norm; changed.add(`${i}:${j}`); count++; }
        }
      }
      ctx.log(`日期标准化 · ${targets.length} 列 · 标准化 ${count} 个单元格`
        + (invalid ? ` · 保留 ${invalid} 个无效日期（数据行 ${invalidRows.join('、')}）` : ''));
      return { headers, rows, changed, invalidDates: invalid, log: '' };
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
      const keep = (opts.keep || []).map(value => {
        const byName = resolveCol(headers, value);
        if (byName >= 0) return byName;
        const index = parseInt(value, 10);
        return isNaN(index) ? -1 : index;
      }).filter(i => i >= 0 && i < headers.length);
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

  // ---- 条件筛选行 ----
  const ruleFilter = {
    id: 'filter', name: '行筛选', desc: '保留或删除满足文本、空值、数值条件的行', defaultOn: false,
    apply(headers, rows, opts, ctx) {
      const column = resolveCol(headers, opts.column);
      const operator = opts.operator || 'contains';
      const action = opts.action || 'keep';
      if (column < 0 || !conditionConfigured(operator, opts.value) || !['keep', 'remove'].includes(action)) {
        ctx.log('行筛选 · 跳过（请完整配置列、运算符、比较值和保留/删除动作）');
        return { headers, rows, changed: new Set(), log: '' };
      }
      const kept = [];
      const removedRows = new Set();
      const removedNumbers = [];
      let matched = 0;
      for (let i = 0; i < rows.length; i++) {
        const matches = matchesCondition(rows[i][column], operator, opts.value, opts.caseSensitive === true);
        if (matches) matched++;
        const remove = action === 'keep' ? !matches : matches;
        if (remove) {
          removedRows.add(i);
          removedNumbers.push(i + 1);
        } else kept.push(rows[i]);
      }
      ctx.log(`行筛选 · "${headers[column]}" ${operator} · ${action === 'keep' ? '保留匹配行' : '删除匹配行'}`
        + ` · 匹配 ${matched} 行 · 删除 ${removedRows.size} 行`
        + (removedNumbers.length ? ` · 原数据行 ${sampleRowNumbers(removedNumbers)}` : ''));
      return { headers, rows: kept, changed: new Set(), removedRows, log: '' };
    },
  };

  // 受限算术语法：数字、col:N、+ - * /、括号和一元正负号。
  // 编译为 AST 后逐行求值，不使用 eval / Function，也不提供任何对象或全局变量访问。
  function compileArithmetic(expression, columnCount) {
    const src = String(expression == null ? '' : expression);
    if (src.length > 1000) throw new Error('公式不能超过 1000 个字符');
    let pos = 0;
    function skipSpace() { while (/\s/.test(src[pos] || '')) pos++; }
    function parseExpression() {
      let left = parseTerm();
      while (true) {
        skipSpace();
        const op = src[pos];
        if (op !== '+' && op !== '-') break;
        pos++;
        left = { kind: 'binary', op, left, right: parseTerm() };
      }
      return left;
    }
    function parseTerm() {
      let left = parsePrimary();
      while (true) {
        skipSpace();
        const op = src[pos];
        if (op !== '*' && op !== '/') break;
        pos++;
        left = { kind: 'binary', op, left, right: parsePrimary() };
      }
      return left;
    }
    function parsePrimary() {
      skipSpace();
      const op = src[pos];
      if (op === '+' || op === '-') {
        pos++;
        return { kind: 'unary', op, value: parsePrimary() };
      }
      if (op === '(') {
        pos++;
        const node = parseExpression();
        skipSpace();
        if (src[pos] !== ')') throw new Error('公式缺少右括号');
        pos++;
        return node;
      }
      if (src.slice(pos, pos + 4) === 'col:') {
        pos += 4;
        const match = src.slice(pos).match(/^\d+/);
        if (!match) throw new Error('col: 后必须是列序号');
        pos += match[0].length;
        const index = Number(match[0]);
        if (index < 0 || index >= columnCount) throw new Error('公式引用了不存在的 col:' + index);
        return { kind: 'column', index };
      }
      const match = src.slice(pos).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!match) throw new Error('公式含不支持的语法（位置 ' + (pos + 1) + '）');
      pos += match[0].length;
      return { kind: 'number', value: Number(match[0]) };
    }
    if (!src.trim()) throw new Error('公式不能为空');
    const ast = parseExpression();
    skipSpace();
    if (pos !== src.length) throw new Error('公式含不支持的语法（位置 ' + (pos + 1) + '）');
    function evaluate(node, row) {
      if (node.kind === 'number') return node.value;
      if (node.kind === 'column') {
        const n = toNum(row[node.index]);
        return isNaN(n) ? 0 : n;
      }
      if (node.kind === 'unary') {
        const n = evaluate(node.value, row);
        return node.op === '-' ? -n : n;
      }
      const left = evaluate(node.left, row), right = evaluate(node.right, row);
      if (node.op === '+') return left + right;
      if (node.op === '-') return left - right;
      if (node.op === '*') return left * right;
      return left / right;
    }
    return row => evaluate(ast, row);
  }

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
      let count = 0, invalid = 0;
      const invalidRows = [];
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i][colIdx];
        if (isNull(v)) continue;
        const parts = parseDateParts(v);
        if (!parts) {
          invalid++;
          if (invalidRows.length < 12) invalidRows.push(i + 1);
          continue;
        }
        const out = formatDateParts(parts, fmt);
        if (out !== v) {
          rows[i][colIdx] = out;
          changed.add(`${i}:${colIdx}`); count++;
        }
      }
      ctx.log(`  · [date] ${headers[colIdx]} → ${fmt} · 标准化 ${count} 个`
        + (invalid ? ` · 保留 ${invalid} 个无效日期（数据行 ${invalidRows.join('、')}）` : ''));
      return { count, changed, invalidDates: invalid };
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
      const evaluate = compileArithmetic(expr, headers.length);
      const changed = new Set();
      let count = 0, skipped = 0;
      for (let i = 0; i < rows.length; i++) {
        const result = evaluate(rows[i]);
        if (Number.isFinite(result)) {
          if (rows[i][colIdx] !== result) {
            rows[i][colIdx] = result;
            changed.add(`${i}:${colIdx}`); count++;
          }
        } else skipped++;
      }
      ctx.log(`  · [formula] ${opts.column} = ${expr} · ${count} 个`
        + (skipped ? ` · 跳过 ${skipped} 个非有限结果` : ''));
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
  const RULES = [
    ruleEmpty, ruleMissing, ruleFill, ruleText, ruleReplace, ruleConditional,
    ruleSplit, ruleMerge, ruleDate, ruleNumber, ruleCols, ruleFilter, ruleDedupe, ruleAI,
  ];

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

      // 每一步都在副本上执行：调用方的原始数据永不被规则原地修改。
      const workingRows = curRows.map(r => r.slice());
      const workingHeaders = curHeaders.slice();
      const result = def.apply(workingHeaders, workingRows, ar.opts || {}, ctx);
      curHeaders = result.headers;
      curRows = result.rows;
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

  function dateFormatName(s) {
    let m = s.match(/^(\d{4})([-/.])\d{1,2}\2\d{1,2}/);
    if (m) return 'YYYY' + m[2] + 'MM' + m[2] + 'DD';
    m = s.match(/^(\d{1,2})([-/.])(\d{1,2})\2(\d{4}|\d{2})/);
    if (!m) return '';
    return (Number(m[1]) > 12 ? 'DD' : 'MM') + m[2]
      + (Number(m[1]) > 12 ? 'MM' : 'DD') + m[2] + 'YYYY';
  }

  // 同时返回可修复问题与逐列画像；报告和自动建议共用同一份分析，避免结论不一致。
  function profileData(headers, rows) {
    const issues = [], columns = [];
    headers.forEach((h, j) => {
      const unique = new Set(), missingRows = [], invalidDateRows = [];
      const invalidEmailRows = [], invalidPhoneRows = [], formats = new Set(), numeric = [];
      let nonEmpty = 0, validDates = 0, validEmails = 0, validPhones = 0, emailLike = 0;
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i][j];
        if (isNull(v)) { missingRows.push(i + 1); continue; }
        nonEmpty++;
        const s = toStr(v).trim();
        unique.add(s);
        const parts = parseDateParts(s);
        if (parts) { validDates++; formats.add(dateFormatName(s)); }
        else invalidDateRows.push(i + 1);
        const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
        if (emailOk) validEmails++;
        if (s.indexOf('@') >= 0) emailLike++;
        if (!emailOk) invalidEmailRows.push(i + 1);
        const phone = s.replace(/[\s-]/g, '').replace(/^\+86/, '');
        if (!/^1[3-9]\d{9}$/.test(phone)) invalidPhoneRows.push(i + 1);
        else validPhones++;
        const numericText = s.replace(/[¥￥$€£,\s]/g, '');
        if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(numericText)) {
          numeric.push({ value: Number(numericText), row: i + 1 });
        }
      }
      const dateHint = /date|日期|时间|入职|注册|创建|出生/i.test(h);
      const emailHint = /e-?mail|邮箱|邮件/i.test(h);
      const phoneHint = /phone|mobile|手机|电话|联系方式/i.test(h);
      const isDate = isDateColumn(rows, j) || (dateHint && validDates + invalidDateRows.length > 0);
      const isEmail = !isDate && (emailHint || (nonEmpty > 0 && (validEmails + emailLike) / nonEmpty > 0.6));
      const isPhone = !isDate && !isEmail && (phoneHint || (nonEmpty > 0 && validPhones / nonEmpty > 0.6));
      const isNumber = !isDate && !isEmail && !isPhone && nonEmpty > 0 && numeric.length / nonEmpty > 0.7;
      const type = nonEmpty === 0 ? 'empty' : isDate ? 'date' : isEmail ? 'email' : isPhone ? 'phone' : isNumber ? 'number' : 'text';
      const typeNames = { empty: '空列', date: '日期', email: '邮箱', phone: '手机号', number: '数字', text: '文本' };
      const missingRate = rows.length ? missingRows.length / rows.length : 0;
      const profile = {
        column: h, columnIndex: j, type, typeName: typeNames[type], nonEmpty,
        missingCount: missingRows.length, missingRate, uniqueCount: unique.size, invalidCount: 0,
      };
      if (missingRows.length && (missingRate > 0.1 || rows.length <= 10)) {
        issues.push({ column: h, columnIndex: j, columnType: type, type: 'missing', count: missingRows.length,
          rows: missingRows.slice(0, 50), rate: missingRate, message: `"${h}" 列有 ${(missingRate * 100).toFixed(1)}% 空值（${missingRows.length} 行）` });
      }
      if (formats.size > 1) {
        issues.push({ column: h, columnIndex: j, type: 'date_inconsistent', formats: [...formats],
          message: `"${h}" 列日期格式混用：${[...formats].join('、')}` });
      }
      const addInvalid = (kind, list, label) => {
        if (!list.length) return;
        profile.invalidCount += list.length;
        issues.push({ column: h, columnIndex: j, type: kind, count: list.length, rows: list.slice(0, 50),
          message: `"${h}" 列有 ${list.length} 个无效${label}（数据行 ${list.slice(0, 12).join('、')}），已保留原值` });
      };
      if (isDate) addInvalid('invalid_date', invalidDateRows, '日期');
      if (isEmail) addInvalid('invalid_email', invalidEmailRows, '邮箱');
      if (isPhone) addInvalid('invalid_phone', invalidPhoneRows, '手机号');
      if (isNumber && numeric.length > 5) {
        const sorted = numeric.map(n => n.value).sort((a, b) => a - b);
        const q1 = sorted[Math.floor(sorted.length * 0.25)], q3 = sorted[Math.floor(sorted.length * 0.75)];
        const iqr = q3 - q1, lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
        const outlierRows = numeric.filter(n => n.value < lo || n.value > hi).map(n => n.row);
        if (outlierRows.length / numeric.length > 0.05) {
          issues.push({ column: h, columnIndex: j, type: 'outliers', count: outlierRows.length, rows: outlierRows,
            message: `"${h}" 列有 ${outlierRows.length} 个离群值（仅提示，不自动修改）` });
        }
      }
      columns.push(profile);
    });
    const seen = new Set(), duplicateRows = [];
    rows.forEach((row, i) => {
      const key = JSON.stringify(row.map(toStr));
      if (seen.has(key)) duplicateRows.push(i + 1);
      else seen.add(key);
    });
    if (duplicateRows.length) {
      issues.unshift({ type: 'duplicates', count: duplicateRows.length, rows: duplicateRows,
        message: `发现 ${duplicateRows.length} 行完全重复（重复数据行 ${duplicateRows.slice(0, 12).join('、')}）` });
    }
    return { issues, columns, summary: { rows: rows.length, columns: headers.length, duplicateRows: duplicateRows.length, issueCount: issues.length } };
  }

  function analyzeQuality(headers, rows) {
    return profileData(headers, rows).issues;
  }

  return {
    RULES, runPipeline, computeDiff, analyzeQuality, profileData, AI_STEP_EXECUTORS,
    parseDateParts, normalizeDate, compileArithmetic,
  };
}
window.DCRules = createDCRules();