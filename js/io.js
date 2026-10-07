/* ============================================
   DataCleaner Pro · AI · IO 模块
   职责：把「文件」变成 { headers, rows }
   - 分隔符嗅探（, \t ; |）
   - CSV/TSV 字符流解析（正确支持字段内换行、转义引号）
   - XLSX 解析（零依赖：DecompressionStream + DOMParser）
   - 预设序列化
   零依赖，可离线（file:// 亦可运行）
   ============================================ */

(function () {
  'use strict';

  // ---- 分隔符嗅探：只统计引号外的候选字符 ----
  const CANDIDATES = [',', '\t', ';', '|'];

  function sniffDelimiter(text) {
    const sample = text.slice(0, 64 * 1024);
    const counts = {};
    CANDIDATES.forEach(c => { counts[c] = 0; });
    let inQ = false;
    for (let i = 0; i < sample.length; i++) {
      const c = sample[i];
      if (c === '"') {
        if (inQ && sample[i + 1] === '"') { i++; continue; }
        inQ = !inQ;
        continue;
      }
      if (inQ) continue;
      if (counts.hasOwnProperty(c)) counts[c]++;
    }
    let best = ',', bestN = -1;
    CANDIDATES.forEach(c => {
      if (counts[c] > bestN) { bestN = counts[c]; best = c; }
    });
    return bestN > 0 ? best : ',';
  }

  // ---- 核心：字符流扫描 ----
  // 与旧实现的关键区别：不再先按 \n 切行，因此带换行的引号字段不会被劈开。
  function parseDelimited(text, delim) {
    text = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    if (!delim) delim = sniffDelimiter(text);

    const rows = [];
    let row = [];
    let cur = '';
    let inQ = false;
    let sawAny = false; // 当前行是否出现过任何字符（用于区分空行与末尾）
    const n = text.length;

    for (let i = 0; i < n; i++) {
      const c = text[i];

      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; }  // "" → 字面量引号
          else inQ = false;                              // 引号段结束
          continue;
        }
        // 引号内的换行属于字段内容，统一成 \n 保留
        if (c === '\r') {
          if (text[i + 1] === '\n') i++;
          cur += '\n';
          continue;
        }
        cur += c;
        continue;
      }

      if (c === '"') { inQ = true; sawAny = true; continue; }

      if (c === delim) { row.push(cur); cur = ''; sawAny = true; continue; }

      if (c === '\r' || c === '\n') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur);
        // 丢弃完全空白的行（旧行为保留）
        if (sawAny || row.some(v => v !== '')) rows.push(row);
        row = []; cur = ''; sawAny = false;
        continue;
      }

      cur += c;
      sawAny = true;
    }

    // 收尾：最后一行可能没有换行符
    if (cur !== '' || row.length || sawAny) {
      row.push(cur);
      if (row.some(v => v !== '')) rows.push(row);
    }
    return rows;
  }

  // ---- 表格化：首行为表头，补齐/截断使每行列数一致 ----
  function tableFromRows(rows) {
    if (!rows.length) return { headers: [], rows: [] };
    const headers = rows[0].map((h, i) => {
      const s = String(h == null ? '' : h).trim();
      return s === '' ? '列' + (i + 1) : s;
    });
    const body = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const out = new Array(headers.length);
      for (let j = 0; j < headers.length; j++) out[j] = r[j] == null ? '' : r[j];
      body.push(out);
    }
    return { headers: headers, rows: body };
  }

  function parseCSV(text, delim) {
    return tableFromRows(parseDelimited(text, delim));
  }

  // ================================================================
  //  ZIP 读取器（只实现读 xlsx 所需的最小子集）
  //  xlsx = ZIP 容器 + XML。用浏览器原生 DecompressionStream 解 deflate，
  //  因此无需 SheetJS 等第三方库，保住零依赖 / 离线特性。
  // ================================================================

  function u16(dv, p) { return dv.getUint16(p, true); }
  function u32(dv, p) { return dv.getUint32(p, true); }

  // 从中央目录读取条目表（比扫描本地头更可靠）
  function zipEntries(buf) {
    const dv = new DataView(buf);
    const bytes = new Uint8Array(buf);
    // 从尾部回找 EOCD 签名 0x06054b50
    let eocd = -1;
    const min = Math.max(0, bytes.length - 66560); // 兼容最大 64KB 注释
    for (let i = bytes.length - 22; i >= min; i--) {
      if (u32(dv, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP/XLSX 文件（缺少 EOCD）');

    let count = u16(dv, eocd + 10);
    let cdOff = u32(dv, eocd + 16);

    // ZIP64：字段被写成 0xFFFF/0xFFFFFFFF 时到 ZIP64 EOCD 取真实值
    if (count === 0xFFFF || cdOff === 0xFFFFFFFF) {
      for (let i = eocd - 20; i >= min; i--) {
        if (u32(dv, i) === 0x07064b50) {           // ZIP64 EOCD locator
          const z64 = Number(dv.getBigUint64(i + 8, true));
          if (u32(dv, z64) === 0x06064b50) {
            count = Number(dv.getBigUint64(z64 + 32, true));
            cdOff = Number(dv.getBigUint64(z64 + 48, true));
          }
          break;
        }
      }
    }

    const entries = {};
    let p = cdOff;
    for (let k = 0; k < count; k++) {
      if (u32(dv, p) !== 0x02014b50) break;        // central file header
      const method = u16(dv, p + 10);
      const csize = u32(dv, p + 20);
      const nameLen = u16(dv, p + 28);
      const extraLen = u16(dv, p + 30);
      const cmtLen = u16(dv, p + 32);
      const lho = u32(dv, p + 42);                 // 本地头偏移
      const name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { method: method, csize: csize, lho: lho };
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return { dv: dv, bytes: bytes, entries: entries };
  }

  async function inflateRaw(chunk) {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(chunk);
    writer.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }

  // 读取单个条目的文本内容
  async function zipReadText(zip, name) {
    const e = zip.entries[name];
    if (!e) return null;
    const dv = zip.dv;
    if (u32(dv, e.lho) !== 0x04034b50) throw new Error('ZIP 本地头损坏: ' + name);
    const nameLen = u16(dv, e.lho + 26);
    const extraLen = u16(dv, e.lho + 28);
    const start = e.lho + 30 + nameLen + extraLen;
    // 本地头的长度字段可能为 0（流式写入），以中央目录为准
    let csize = e.csize;
    if (!csize) csize = u32(dv, e.lho + 18);
    const raw = zip.bytes.subarray(start, start + csize);

    let out;
    if (e.method === 0) out = raw;                 // stored
    else if (e.method === 8) out = await inflateRaw(raw);
    else throw new Error('不支持的压缩方式 method=' + e.method);
    return new TextDecoder('utf-8').decode(out);
  }

  // ================================================================
  //  XLSX 解析
  // ================================================================

  // 列字母 → 0 基下标： A→0, Z→25, AA→26
  function colToIndex(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  // Excel 日期序列号 → YYYY-MM-DD
  // 1900 历法含闰年 Bug：序列号 60 = 不存在的 1900-02-29，故 <60 需补偿。
  function excelSerialToDate(sn) {
    const days = Math.floor(sn);
    const ms = Math.round((sn - days) * 86400) * 1000;
    const epoch = Date.UTC(1899, 11, 30);
    const d = new Date(epoch + (days < 60 ? days + 1 : days) * 86400000 + ms);
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    if (ms > 0) {
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mi = String(d.getUTCMinutes()).padStart(2, '0');
      const ss = String(d.getUTCSeconds()).padStart(2, '0');
      return `${y}-${mo}-${dd} ${hh}:${mi}:${ss}`;
    }
    return `${y}-${mo}-${dd}`;
  }

  function parseX(xml) {
    return new DOMParser().parseFromString(xml, 'application/xml');
  }

  // 共享字符串表：<si> 内可能有多个 <t>（富文本分段），需拼接
  function parseSharedStrings(xml) {
    if (!xml) return [];
    const doc = parseX(xml);
    return Array.from(doc.getElementsByTagName('si')).map(si => {
      const ts = si.getElementsByTagName('t');
      let s = '';
      for (let i = 0; i < ts.length; i++) s += ts[i].textContent;
      return s;
    });
  }

  // 找出哪些样式序号对应日期格式
  function parseDateStyles(xml) {
    const dateStyles = new Set();
    if (!xml) return dateStyles;
    const doc = parseX(xml);
    const builtin = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57, 58]);
    const customDate = new Set();
    Array.from(doc.getElementsByTagName('numFmt')).forEach(nf => {
      const id = parseInt(nf.getAttribute('numFmtId'), 10);
      const code = (nf.getAttribute('formatCode') || '').toLowerCase();
      if (/[ymdh]/.test(code) && !/[#?]/.test(code)) customDate.add(id);
    });
    const xfs = doc.getElementsByTagName('cellXfs')[0];
    if (!xfs) return dateStyles;
    Array.from(xfs.getElementsByTagName('xf')).forEach((xf, i) => {
      const id = parseInt(xf.getAttribute('numFmtId') || '0', 10);
      if (builtin.has(id) || customDate.has(id)) dateStyles.add(i);
    });
    return dateStyles;
  }

  function sheetToRows(xml, shared, dateStyles) {
    const doc = parseX(xml);
    const rowEls = doc.getElementsByTagName('row');
    const out = [];
    let maxCols = 0;

    for (let ri = 0; ri < rowEls.length; ri++) {
      const cells = rowEls[ri].getElementsByTagName('c');
      const row = [];
      for (let ci = 0; ci < cells.length; ci++) {
        const c = cells[ci];
        const ref = c.getAttribute('r') || '';
        const idx = ref ? colToIndex(ref) : row.length;
        const t = c.getAttribute('t');
        let val = '';

        if (t === 'inlineStr') {
          const is = c.getElementsByTagName('is')[0];
          val = is ? is.textContent : '';
        } else {
          const vEl = c.getElementsByTagName('v')[0];
          const raw = vEl ? vEl.textContent : '';
          if (t === 's') {
            val = shared[parseInt(raw, 10)] || '';
          } else if (t === 'e' || t === 'str') {
            val = raw;
          } else if (t === 'b') {
            val = raw === '1' ? 'TRUE' : 'FALSE';
          } else {
            const s = parseInt(c.getAttribute('s') || '-1', 10);
            if (raw !== '' && dateStyles.has(s) && isFinite(+raw) && +raw > 0) {
              val = excelSerialToDate(+raw);
            } else {
              val = raw;
            }
          }
        }
        if (idx >= 0) row[idx] = val;
      }
      for (let k = 0; k < row.length; k++) if (row[k] == null) row[k] = '';
      if (row.length > maxCols) maxCols = row.length;
      out.push(row);
    }
    out.forEach(r => { while (r.length < maxCols) r.push(''); });
    return out.filter(r => r.some(v => String(v).trim() !== ''));
  }

  // 解析 xlsx：返回 { sheets: [{name, headers, rows}] }
  async function parseXLSX(buf) {
    const zip = zipEntries(buf);
    const wbXml = await zipReadText(zip, 'xl/workbook.xml');
    if (!wbXml) throw new Error('缺少 xl/workbook.xml（旧版 .xls 二进制格式不支持，请另存为 .xlsx）');

    const shared = parseSharedStrings(await zipReadText(zip, 'xl/sharedStrings.xml'));
    const dateStyles = parseDateStyles(await zipReadText(zip, 'xl/styles.xml'));

    const wb = parseX(wbXml);
    const sheetTags = Array.from(wb.getElementsByTagName('sheet'));

    // rId → 实际路径（走 rels，不能假设就是 sheetN.xml 的顺序）
    const relXml = await zipReadText(zip, 'xl/_rels/workbook.xml.rels');
    const relMap = {};
    if (relXml) {
      Array.from(parseX(relXml).getElementsByTagName('Relationship')).forEach(r => {
        relMap[r.getAttribute('Id')] = r.getAttribute('Target');
      });
    }

    const sheets = [];
    for (let i = 0; i < sheetTags.length; i++) {
      const st = sheetTags[i];
      const name = st.getAttribute('name') || ('Sheet' + (i + 1));
      const rid = st.getAttribute('r:id');
      let target = rid && relMap[rid] ? relMap[rid] : null;
      if (target && target.charAt(0) === '/') target = target.slice(1);
      const path = target
        ? (target.indexOf('xl/') === 0 ? target : 'xl/' + target)
        : 'xl/worksheets/sheet' + (i + 1) + '.xml';
      let xml = await zipReadText(zip, path);
      if (!xml) xml = await zipReadText(zip, 'xl/worksheets/sheet' + (i + 1) + '.xml');
      if (!xml) continue;
      const tbl = tableFromRows(sheetToRows(xml, shared, dateStyles));
      sheets.push({ name: name, headers: tbl.headers, rows: tbl.rows });
    }
    if (!sheets.length) throw new Error('未在工作簿中找到任何工作表');
    return { sheets: sheets };
  }

  // ================================================================
  //  ZIP 写入器（用于导出 xlsx）
  //  与上面的读取器对称：CompressionStream('deflate-raw') 做压缩，
  //  自己算 CRC32、拼本地头 + 中央目录 + EOCD。仍然零依赖。
  // ================================================================

  // CRC32 查表（ZIP 规范要求，每个条目都要带）
  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    CRC_TABLE = t;
    return t;
  }

  function crc32(bytes) {
    const t = crcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  async function deflateRaw(bytes) {
    const cs = new CompressionStream('deflate-raw');
    const w = cs.writable.getWriter();
    w.write(bytes);
    w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }

  // 打包成 ZIP：files = [{ name, text }]，返回 Blob
  async function zipCreate(files) {
    const enc = new TextEncoder();
    const parts = [];        // 数据区各段
    const central = [];      // 中央目录各条
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const raw = enc.encode(f.text);
      const crc = crc32(raw);
      let body = await deflateRaw(raw);
      let method = 8;
      // 极短内容压缩后可能反而变大，此时退回 stored
      if (body.length >= raw.length) { body = raw; method = 0; }

      const lh = new Uint8Array(30 + nameBytes.length);
      const ldv = new DataView(lh.buffer);
      ldv.setUint32(0, 0x04034b50, true);   // 本地文件头签名
      ldv.setUint16(4, 20, true);           // version needed
      ldv.setUint16(6, 0, true);            // flags
      ldv.setUint16(8, method, true);
      ldv.setUint16(10, 0, true);           // mod time
      ldv.setUint16(12, 0x21, true);        // mod date (1980-01-01)
      ldv.setUint32(14, crc, true);
      ldv.setUint32(18, body.length, true); // 压缩后大小
      ldv.setUint32(22, raw.length, true);  // 原始大小
      ldv.setUint16(26, nameBytes.length, true);
      ldv.setUint16(28, 0, true);           // extra len
      lh.set(nameBytes, 30);

      parts.push(lh, body);

      const ch = new Uint8Array(46 + nameBytes.length);
      const cdv = new DataView(ch.buffer);
      cdv.setUint32(0, 0x02014b50, true);   // 中央目录头签名
      cdv.setUint16(4, 20, true);           // version made by
      cdv.setUint16(6, 20, true);           // version needed
      cdv.setUint16(8, 0, true);
      cdv.setUint16(10, method, true);
      cdv.setUint16(12, 0, true);
      cdv.setUint16(14, 0x21, true);
      cdv.setUint32(16, crc, true);
      cdv.setUint32(20, body.length, true);
      cdv.setUint32(24, raw.length, true);
      cdv.setUint16(28, nameBytes.length, true);
      cdv.setUint16(30, 0, true);           // extra
      cdv.setUint16(32, 0, true);           // comment
      cdv.setUint16(34, 0, true);           // disk number
      cdv.setUint16(36, 0, true);           // internal attrs
      cdv.setUint32(38, 0, true);           // external attrs
      cdv.setUint32(42, offset, true);      // 本地头偏移
      ch.set(nameBytes, 46);
      central.push(ch);

      offset += lh.length + body.length;
    }

    let cdSize = 0;
    central.forEach(c => { cdSize += c.length; });

    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(4, 0, true);
    edv.setUint16(6, 0, true);
    edv.setUint16(8, files.length, true);
    edv.setUint16(10, files.length, true);
    edv.setUint32(12, cdSize, true);
    edv.setUint32(16, offset, true);        // 中央目录起始偏移
    edv.setUint16(20, 0, true);

    return new Blob(parts.concat(central, [eocd]), { type: 'application/zip' });
  }

  // ================================================================
  //  XLSX 生成
  // ================================================================

  // 0 基下标 → 列字母：0→A, 25→Z, 26→AA
  function indexToCol(n) {
    let s = '';
    n = n + 1;
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function xmlEscape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // XML 1.0 不允许的控制字符，去掉以免生成的文件打不开
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  // 判断是否应作为数字写入。注意：前导 0（如 "007"）和长数字串（手机号、
  // 身份证）必须留作文本，否则 Excel 会吃掉 0 或转成科学计数法。
  function isPlainNumber(s) {
    if (typeof s !== 'string' || s === '') return false;
    if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s)) return false;
    if (s.replace(/[-.]/g, '').length > 15) return false;
    return isFinite(Number(s));
  }

  function sheetXml(headers, rows) {
    const parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      '<sheetData>'];

    // 表头：一律用 inlineStr，省掉共享字符串表
    parts.push('<row r="1">');
    headers.forEach((h, j) => {
      parts.push('<c r="' + indexToCol(j) + '1" t="inlineStr" s="1"><is><t xml:space="preserve">'
        + xmlEscape(h) + '</t></is></c>');
    });
    parts.push('</row>');

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rn = i + 2;
      parts.push('<row r="' + rn + '">');
      for (let j = 0; j < headers.length; j++) {
        const v = r[j];
        if (v === null || v === undefined || v === '') continue;  // 空单元格直接省略
        const ref = indexToCol(j) + rn;
        const s = String(v);
        if (isPlainNumber(s)) {
          parts.push('<c r="' + ref + '"><v>' + s + '</v></c>');
        } else {
          parts.push('<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">'
            + xmlEscape(s) + '</t></is></c>');
        }
      }
      parts.push('</row>');
    }
    parts.push('</sheetData></worksheet>');
    return parts.join('');
  }

  // 构建 xlsx Blob。sheetName 会被清理成 Excel 允许的形式。
  function buildXLSX(headers, rows, sheetName) {
    let name = String(sheetName || 'Sheet1').replace(/[\[\]\*\/\\\?:]/g, '_').slice(0, 31);
    if (!name) name = 'Sheet1';

    const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>';

    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>';

    const wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="' + xmlEscape(name) + '" sheetId="1" r:id="rId1"/></sheets>'
      + '</workbook>';

    const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>';

    // 两个样式：0=普通，1=表头加粗
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
      + '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
      + '<borders count="1"><border/></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
      + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
      + '</styleSheet>';

    return zipCreate([
      { name: '[Content_Types].xml', text: ct },
      { name: '_rels/.rels', text: rootRels },
      { name: 'xl/workbook.xml', text: wb },
      { name: 'xl/_rels/workbook.xml.rels', text: wbRels },
      { name: 'xl/styles.xml', text: styles },
      { name: 'xl/worksheets/sheet1.xml', text: sheetXml(headers, rows) },
    ]);
  }

  // ---- 预设序列化（第 2 项用）----
  function serializePresets(presets) {
    return JSON.stringify({ v: 1, presets: presets }, null, 2);
  }

  function deserializePresets(text) {
    const o = JSON.parse(text);
    const list = Array.isArray(o) ? o : (o && o.presets);
    if (!Array.isArray(list)) throw new Error('格式不正确：缺少 presets 数组');
    return list.filter(p => p && typeof p.name === 'string' && Array.isArray(p.rules));
  }

  window.DCIO = {
    sniffDelimiter: sniffDelimiter,
    parseDelimited: parseDelimited,
    parseCSV: parseCSV,
    tableFromRows: tableFromRows,
    parseXLSX: parseXLSX,
    buildXLSX: buildXLSX,
    zipCreate: zipCreate,
    crc32: crc32,
    excelSerialToDate: excelSerialToDate,
    colToIndex: colToIndex,
    indexToCol: indexToCol,
    serializePresets: serializePresets,
    deserializePresets: deserializePresets,
  };
})();

