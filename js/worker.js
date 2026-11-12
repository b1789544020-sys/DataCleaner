/* 纯计算任务的后台执行桥。源码来自已加载的工厂函数，不需要 fetch、构建或重复维护规则。 */
(function () {
  'use strict';

  // 此函数会被序列化到 Worker 中，不能引用外层变量或 DOM。
  function dcWorkerRuntime() {
    // 保留原始输入和最近结果；使用时刷新顺序，重复预览不必重传原始大表。
    const cachedTables = new Map();
    function readCachedTable(id) {
      if (!cachedTables.has(id)) return null;
      const table = cachedTables.get(id);
      cachedTables.delete(id);
      cachedTables.set(id, table);
      return table;
    }
    function cacheTable(id, result, kind) {
      cachedTables.set(id, { headers: result.headers, rows: result.rows,
        pipelineResult: kind === 'pipeline' ? result : null });
      while (cachedTables.size > 2) cachedTables.delete(cachedTables.keys().next().value);
    }
    function serializePipeline(result) {
      const affectedColumns = new Set();
      (result.changed || []).forEach(key => affectedColumns.add(Number(String(key).split(':')[1])));
      return Object.assign({}, result, {
        affectedColumns: [...affectedColumns],
        changed: [...(result.changed || [])],
        removed: [...(result.removed || [])],
        removedCols: [...(result.removedCols || [])],
        removedRows: [...(result.removedRows || [])],
      });
    }
    self.onmessage = async function (event) {
      const message = event.data || {};
      const progress = (value, id) => self.postMessage({
        id: message.id, type: 'progress', progress: value, ruleId: id,
      });
      try {
        let result;
        if (message.kind === 'pipeline') {
          const cached = message.payload.sourceJobId !== undefined
            ? readCachedTable(message.payload.sourceJobId) : null;
          if (message.payload.sourceJobId !== undefined && !cached) {
            self.postMessage({ id: message.id, type: 'cacheMiss' });
            return;
          }
          const input = cached || message.payload;
          result = self.DCRules.runPipeline(message.payload.activeRules,
            input.headers, input.rows, progress);
          result = serializePipeline(result);
        } else if (message.kind === 'profile') {
          progress(0.1, 'profile');
          const hasCache = message.payload.sourceJobId !== undefined
            ? readCachedTable(message.payload.sourceJobId) : null;
          if (message.payload.sourceJobId !== undefined && !hasCache) {
            self.postMessage({ id: message.id, type: 'cacheMiss' });
            return;
          }
          const input = hasCache || message.payload;
          result = self.DCRules.profileData(input.headers, input.rows);
        } else if (message.kind === 'diff') {
          const cached = message.payload.sourceJobId !== undefined
            ? readCachedTable(message.payload.sourceJobId) : null;
          if (message.payload.sourceJobId !== undefined && (!cached || !cached.pipelineResult)) {
            self.postMessage({ id: message.id, type: 'cacheMiss' });
            return;
          }
          const source = cached ? cached.pipelineResult : message.payload.result;
          if (!source) throw new Error('差异结果已失效，请重新预览');
          const changes = Array.isArray(source.changed) ? source.changed : [...(source.changed || [])];
          const offset = Math.max(0, Number(message.payload.offset) || 0);
          const limit = Math.max(1, Math.min(500, Number(message.payload.limit) || 100));
          const entries = [];
          for (let index = offset; index < Math.min(offset + limit, changes.length); index++) {
            const parts = String(changes[index]).split(':'), row = Number(parts[0]), col = Number(parts[1]);
            if (!source.rows[row] || col < 0 || col >= source.headers.length) continue;
            entries.push({ row, col, header: source.headers[col],
              after: source.rows[row][col] == null ? '' : String(source.rows[row][col]) });
          }
          result = { entries, total: changes.length, offset };
        } else if (message.kind === 'buildCSV' || message.kind === 'buildXLSX') {
          const cached = message.payload.sourceJobId !== undefined
            ? readCachedTable(message.payload.sourceJobId) : null;
          if (message.payload.sourceJobId !== undefined && !cached) {
            self.postMessage({ id: message.id, type: 'cacheMiss' });
            return;
          }
          const input = cached || message.payload;
          progress(0.1, 'serialize');
          result = message.kind === 'buildCSV'
            ? self.DCIO.buildCSV(input.headers, input.rows)
            : await self.DCIO.buildXLSX(input.headers, input.rows, message.payload.sheetName);
        } else if (message.kind === 'parseXLSX') {
          progress(0.1, 'read-xlsx');
          let buffer = message.payload.buffer;
          if (message.payload.file) {
            try { buffer = await message.payload.file.arrayBuffer(); }
            catch (error) {
              self.postMessage({ id: message.id, type: 'fileReadFallback' });
              return;
            }
          }
          if (!buffer) throw new Error('没有可读取的 XLSX 内容');
          progress(0.25, 'parse-xlsx');
          result = await self.DCIO.parseXLSX(buffer);
        } else if (message.kind === 'parseCSV') {
          progress(0.1, 'decode');
          let decoded;
          if (message.payload.file) {
            let buffer;
            try { buffer = await message.payload.file.arrayBuffer(); }
            catch (error) {
              // WebKit 可能无法读取跨线程 File；保留 File 给主线程重读，不伪装成解析错误。
              self.postMessage({ id: message.id, type: 'fileReadFallback' });
              return;
            }
            decoded = self.DCIO.decodeText(buffer);
          } else {
            decoded = message.payload.buffer
              ? self.DCIO.decodeText(message.payload.buffer)
              : { text: String(message.payload.text || ''), encoding: 'utf-8' };
          }
          progress(0.35, 'parse');
          const requested = message.payload.delimiter;
          const delimiter = requested === 'auto' || requested === undefined || requested === null
            ? self.DCIO.sniffDelimiter(decoded.text) : requested;
          result = Object.assign(self.DCIO.parseCSV(decoded.text, delimiter), {
            delimiter, encoding: decoded.encoding,
          });
        } else {
          throw new Error('未知后台任务：' + message.kind);
        }
        if (message.kind === 'parseXLSX') {
          if (result.sheets.length === 1) cacheTable(message.id, result.sheets[0], message.kind);
          self.postMessage({ id: message.id, type: 'workbookStart', sheets: result.sheets.map(sheet => ({
            name: sheet.name, headers: sheet.headers, stats: sheet.stats, totalRows: sheet.rows.length,
          })) });
          let sheetIndex = 0, rowOffset = 0;
          const sendWorkbookChunk = () => {
            if (sheetIndex >= result.sheets.length) {
              self.postMessage({ id: message.id, type: 'workbookEnd' });
              return;
            }
            const rows = result.sheets[sheetIndex].rows;
            if (rowOffset < rows.length) {
              self.postMessage({ id: message.id, type: 'workbookRows', sheetIndex, offset: rowOffset,
                rows: rows.slice(rowOffset, rowOffset + 10000) });
              rowOffset += 10000;
            } else {
              sheetIndex++;
              rowOffset = 0;
            }
            setTimeout(sendWorkbookChunk, 0);
          };
          setTimeout(sendWorkbookChunk, 0);
        } else if (message.kind === 'pipeline' || message.kind === 'parseCSV') {
          cacheTable(message.id, result, message.kind);
          // 一次性反序列化大表会卡住主线程；分块消息之间可以处理计时器和用户输入。
          const totalRows = result.rows.length;
          const metadata = Object.assign({}, result, { rows: [] });
          const metaFields = message.kind === 'pipeline' ? ['changed', 'removed', 'removedCols', 'removedRows'] : [];
          metaFields.forEach(field => { metadata[field] = []; });
          self.postMessage({ id: message.id, type: 'resultStart', result: metadata, totalRows });
          const chunkSize = 10000, metaChunkSize = 50000;
          let fieldIndex = 0, metaOffset = 0, rowOffset = 0;
          const sendChunk = () => {
            if (fieldIndex < metaFields.length) {
              const field = metaFields[fieldIndex], values = result[field] || [];
              if (metaOffset < values.length) {
                self.postMessage({ id: message.id, type: 'resultValues', field,
                  values: values.slice(metaOffset, metaOffset + metaChunkSize) });
                metaOffset += metaChunkSize;
              } else {
                fieldIndex++;
                metaOffset = 0;
              }
            } else if (rowOffset < totalRows) {
              self.postMessage({ id: message.id, type: 'resultRows', offset: rowOffset,
                rows: result.rows.slice(rowOffset, rowOffset + chunkSize) });
              rowOffset += chunkSize;
            } else {
              self.postMessage({ id: message.id, type: 'resultEnd' });
              return;
            }
            setTimeout(sendChunk, 0);
          };
          setTimeout(sendChunk, 0);
        } else {
          self.postMessage({ id: message.id, type: 'result', result });
        }
      } catch (error) {
        self.postMessage({ id: message.id, type: 'error',
          error: { message: error && error.message ? error.message : String(error) } });
      }
    };
    return self.onmessage;
  }

  let worker = null, workerURL = null, workerReady = false, activeJob = null, nextId = 1;
  const queue = [];

  function abortError() {
    const error = new Error('任务已取消');
    error.name = 'AbortError';
    return error;
  }

  function restoreResult(kind, result) {
    if (kind !== 'pipeline') return result;
    const toSet = value => value instanceof Set ? value : new Set(value || []);
    result.changed = toSet(result.changed);
    result.removed = toSet(result.removed);
    result.removedCols = toSet(result.removedCols);
    result.removedRows = toSet(result.removedRows);
    return result;
  }

  function sourceForWorker() {
    return window.createDCRules.toString() + '\n' + window.createDCIO.toString() + '\n'
      + 'self.DCRules = createDCRules();\nself.DCIO = createDCIO();\n'
      + dcWorkerRuntime.toString() + '\nself.onmessage = dcWorkerRuntime();\nself.postMessage({ type: "ready" });';
  }

  function stopWorker() {
    if (worker) worker.terminate();
    if (workerURL) URL.revokeObjectURL(workerURL);
    worker = null;
    workerURL = null;
    workerReady = false;
  }

  function settle(job, error, result) {
    if (activeJob !== job || job.cancelled) return;
    activeJob = null;
    if (error) job.reject(error);
    else job.resolve(restoreResult(job.kind, result));
    pump();
  }

  function executeFallback(job) {
    job.mode = 'fallback';
    setTimeout(async () => {
      if (job.cancelled || activeJob !== job) return;
      try {
        let result;
        if (job.kind === 'pipeline') {
          result = self.DCRules.runPipeline(job.payload.activeRules,
            job.payload.headers, job.payload.rows, job.onProgress);
          const affectedColumns = new Set([...result.changed].map(key => Number(String(key).split(':')[1])));
          result = Object.assign({}, result, {
            changed: [...result.changed], removed: [...result.removed],
            removedCols: [...result.removedCols], removedRows: [...(result.removedRows || [])],
            affectedColumns: [...affectedColumns],
          });
        } else if (job.kind === 'profile') {
          result = self.DCRules.profileData(job.payload.headers, job.payload.rows);
        } else if (job.kind === 'diff') {
          const source = job.payload.result;
          if (!source) throw new Error('差异结果已失效，请重新预览');
          const changes = Array.isArray(source.changed) ? source.changed : [...(source.changed || [])];
          const offset = Math.max(0, Number(job.payload.offset) || 0);
          const limit = Math.max(1, Math.min(500, Number(job.payload.limit) || 100));
          const entries = [];
          for (let index = offset; index < Math.min(offset + limit, changes.length); index++) {
            const parts = String(changes[index]).split(':'), row = Number(parts[0]), col = Number(parts[1]);
            if (!source.rows[row] || col < 0 || col >= source.headers.length) continue;
            entries.push({ row, col, header: source.headers[col],
              after: source.rows[row][col] == null ? '' : String(source.rows[row][col]) });
          }
          result = { entries, total: changes.length, offset };
        } else if (job.kind === 'buildCSV' || job.kind === 'buildXLSX') {
          result = job.kind === 'buildCSV'
            ? self.DCIO.buildCSV(job.payload.headers, job.payload.rows)
            : await self.DCIO.buildXLSX(job.payload.headers, job.payload.rows, job.payload.sheetName);
        } else if (job.kind === 'parseXLSX') {
          const buffer = job.payload.buffer || await job.payload.file.arrayBuffer();
          result = await self.DCIO.parseXLSX(buffer);
        } else if (job.kind === 'parseCSV') {
          const decoded = job.payload.file
            ? self.DCIO.decodeText(await job.payload.file.arrayBuffer())
            : job.payload.buffer ? self.DCIO.decodeText(job.payload.buffer)
              : { text: String(job.payload.text || ''), encoding: 'utf-8' };
          if (job.cancelled || activeJob !== job) return;
          const requested = job.payload.delimiter;
          const delimiter = requested === 'auto' || requested === undefined || requested === null
            ? self.DCIO.sniffDelimiter(decoded.text) : requested;
          result = Object.assign(self.DCIO.parseCSV(decoded.text, delimiter), {
            delimiter, encoding: decoded.encoding,
          });
        } else throw new Error('未知后台任务：' + job.kind);
        settle(job, null, result);
      } catch (error) { settle(job, error); }
    }, 0);
  }

  function needsMainFileRead() {
    // WebKit 的跨线程 File 读取会触发控制台错误，不能靠失败探针做无噪声特性检测。
    const ua = navigator.userAgent;
    return /AppleWebKit/i.test(ua) && !/(?:HeadlessChrome|Chrome|Chromium|Edg|OPR)\//i.test(ua);
  }

  function readFileForWorker(job) {
    const file = job.payload.file, delimiter = job.payload.delimiter;
    job.fileReadFallback = true;
    job.preparing = true;
    if (job.onProgress) job.onProgress(0.05, '兼容读取文件');
    file.arrayBuffer().then(buffer => {
      if (job.cancelled || activeJob !== job) return;
      job.payload = { buffer, delimiter };
      job.transfer = [buffer];
      job.preparing = false;
      job.sent = false;
      postActiveJob();
    }, error => { job.preparing = false; settle(job, error); });
  }

  function ensureWorker() {
    if (worker) return worker;
    workerURL = URL.createObjectURL(new Blob([sourceForWorker()], { type: 'text/javascript;charset=utf-8' }));
    const instance = new Worker(workerURL);
    worker = instance;
    instance.onmessage = event => {
      if (worker !== instance) return;
      const message = event.data || {};
      if (message.type === 'ready') {
        workerReady = true;
        postActiveJob();
        return;
      }
      const job = activeJob;
      if (!job || job.id !== message.id) return;
      if (message.type === 'progress') {
        if (job.onProgress) job.onProgress(message.progress, message.ruleId);
      } else if (message.type === 'workbookStart') {
        job.streaming = { workbook: { sheets: message.sheets.map(sheet => ({
          name: sheet.name, headers: sheet.headers, stats: sheet.stats, rows: new Array(sheet.totalRows),
        })) } };
      } else if (message.type === 'workbookRows' && job.streaming && job.streaming.workbook) {
        const sheet = job.streaming.workbook.sheets[message.sheetIndex];
        if (sheet) message.rows.forEach((row, index) => { sheet.rows[message.offset + index] = row; });
      } else if (message.type === 'workbookEnd' && job.streaming && job.streaming.workbook) {
        const workbook = job.streaming.workbook;
        job.cacheable = workbook.sheets.length === 1;
        job.streaming = null;
        settle(job, null, workbook);
      } else if (message.type === 'resultStart') {
        job.streaming = { result: Object.assign(message.result, { rows: new Array(message.totalRows) }) };
        if (job.kind === 'pipeline') {
          ['changed', 'removed', 'removedCols', 'removedRows'].forEach(field => {
            job.streaming.result[field] = new Set();
          });
        }
      } else if (message.type === 'resultValues' && job.streaming) {
        const target = job.streaming.result[message.field];
        if (target instanceof Set) message.values.forEach(value => target.add(value));
        else if (Array.isArray(target)) message.values.forEach(value => target.push(value));
      } else if (message.type === 'resultRows' && job.streaming) {
        const target = job.streaming.result.rows;
        message.rows.forEach((row, index) => { target[message.offset + index] = row; });
      } else if (message.type === 'resultEnd' && job.streaming) {
        const result = job.streaming.result;
        job.streaming = null;
        if (['pipeline', 'parseCSV', 'parseXLSX'].includes(job.kind)) job.cacheable = true;
        settle(job, null, result);
      } else if (message.type === 'result') {
        settle(job, null, message.result);
      } else if (message.type === 'fileReadFallback' && ['parseCSV', 'parseXLSX'].includes(job.kind) && job.payload.file) {
        // File 没有被 transfer，主线程仍能重读；之后只把 ArrayBuffer 交回 Worker。
        readFileForWorker(job);
      } else if (message.type === 'cacheMiss' && ['profile', 'pipeline', 'diff', 'buildCSV', 'buildXLSX'].includes(job.kind) && job.payload.sourceJob) {
        job.payload.sourceJob.cacheable = false;
        job.usedCache = false;
        job.cacheFallback = true;
        job.sent = false;
        postActiveJob();
      } else if (message.type === 'error') {
        settle(job, new Error(message.error && message.error.message ? message.error.message : '后台任务失败'));
      }
    };
    instance.onerror = event => {
      if (worker !== instance) return;
      // Worker 初始化失败时安全回退；规则自身错误走 error 消息，不重复执行。
      if (event.preventDefault) event.preventDefault();
      const job = activeJob;
      stopWorker();
      if (job && job.sent) {
        settle(job, new Error(event.message || '后台任务意外中止'));
      } else if (job) {
        // 尚未 transfer 文件缓冲区，初始化失败仍可安全在主线程重试。
        job.fallbackReason = event.message || '当前浏览器无法启动后台任务';
        executeFallback(job);
      }
    };
    return instance;
  }

  function payloadForJob(job) {
    const payload = job.payload;
    const cachedKinds = ['profile', 'pipeline', 'diff', 'buildCSV', 'buildXLSX'];
    if (!cachedKinds.includes(job.kind) || !payload.sourceJob) return payload;
    const source = payload.sourceJob;
    const cached = source.cacheable && source.worker === worker;
    if (cached) job.usedCache = true;
    if (job.kind === 'diff') {
      return Object.assign({ offset: payload.offset, limit: payload.limit },
        cached ? { sourceJobId: source.id } : { result: payload.result });
    }
    const reference = cached ? { sourceJobId: source.id } : { headers: payload.headers, rows: payload.rows };
    if (job.kind === 'pipeline') return Object.assign({ activeRules: payload.activeRules }, reference);
    if (job.kind === 'buildXLSX') return Object.assign({ sheetName: payload.sheetName }, reference);
    return reference;
  }

  function postActiveJob() {
    const job = activeJob;
    if (!job || job.sent || job.preparing || job.mode !== 'worker' || !workerReady) return;
    try {
      job.sent = true;
      job.worker = worker;
      worker.postMessage({ id: job.id, kind: job.kind, payload: payloadForJob(job) }, job.transfer || []);
    } catch (_) {
      job.fallbackReason = '后台任务通信失败，已使用兼容模式';
      stopWorker();
      executeFallback(job);
    }
  }

  function pump() {
    if (activeJob || !queue.length) return;
    const job = queue.shift();
    if (job.cancelled) return pump();
    activeJob = job;
    if (typeof window.Worker !== 'function' || typeof window.Blob !== 'function') {
      executeFallback(job);
      return;
    }
    try {
      job.mode = 'worker';
      const prepareFile = ['parseCSV', 'parseXLSX'].includes(job.kind) && job.payload.file && needsMainFileRead();
      if (prepareFile) job.preparing = true;
      ensureWorker();
      if (prepareFile) readFileForWorker(job);
      else postActiveJob();
    } catch (_) {
      job.fallbackReason = '当前浏览器无法启动后台任务';
      stopWorker();
      executeFallback(job);
    }
  }

  function cancel(job) {
    if (!job || job.cancelled) return;
    job.cancelled = true;
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    job.reject(abortError());
    if (activeJob === job) {
      activeJob = null;
      if (job.mode === 'worker') stopWorker();
      pump();
    }
  }

  function run(kind, payload, onProgress, transfer) {
    let job;
    const promise = new Promise((resolve, reject) => {
      job = { id: nextId++, kind, payload, onProgress, transfer, resolve, reject,
        mode: 'queued', cancelled: false, cancel: null };
    });
    job.cancel = () => cancel(job);
    job.promise = promise;
    queue.push(job);
    pump();
    return job;
  }

  function cancelAll() {
    queue.splice(0).forEach(job => cancel(job));
    if (activeJob) cancel(activeJob);
  }

  window.DCWorker = { run, cancelAll };
  window.addEventListener('pagehide', () => { cancelAll(); stopWorker(); });

})();
