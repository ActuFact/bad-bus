/* Storage for Bad Bus Dashcam.
 *  - Report metadata (bus details, incidents, GPS track, file list) → IndexedDB.
 *  - Video and photo files → the browser's private file storage (OPFS), under
 *    reports/<reportId>/<file>. Video is written every second while recording.
 *  - Export: copy a report's files into a folder the user picks (where the browser
 *    supports it), hand them to the share sheet, or build a .zip containing one folder.
 * If OPFS is missing (very old browsers), files fall back to memory for the session. */
'use strict';

const Store = (() => {
  // ------------------------------------------------------------ IndexedDB
  let dbPromise;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('badbus', 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('reports')) d.createObjectStore('reports', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function run(storeName, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(storeName, mode);
      const req = fn(t.objectStore(storeName));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const listReports = () => run('reports', 'readonly', (s) => s.getAll());
  const putReport = (r) => run('reports', 'readwrite', (s) => s.put(r));
  const removeReportMeta = (id) => run('reports', 'readwrite', (s) => s.delete(id));
  const kvGet = (k) => run('kv', 'readonly', (s) => s.get(k)).catch(() => undefined);
  const kvSet = (k, v) => run('kv', 'readwrite', (s) => s.put(v, k)).catch(() => undefined);

  // ------------------------------------------------------------ OPFS
  const opfsAvailable = !!(navigator.storage && navigator.storage.getDirectory && window.Worker);
  let opfsWorks = null;                // tested on first use
  const memFiles = new Map();          // fallback: `${reportId}/${name}` → Blob

  let worker = null, seq = 0;
  const pending = new Map();
  function rpc(msg, transfer = []) {
    if (!worker) {
      worker = new Worker('opfs-worker.js');
      worker.onmessage = (e) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.result);
      };
    }
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id }, transfer);
    });
  }

  async function reportsRoot() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('reports', { create: true });
  }
  async function reportDir(reportId, create = false) {
    return (await reportsRoot()).getDirectoryHandle(reportId, { create });
  }

  async function checkOpfs() {
    if (opfsWorks !== null) return opfsWorks;
    if (!opfsAvailable) return (opfsWorks = false);
    try {
      await rpc({ op: 'writeFile', reportId: '_probe', name: 'probe', buf: new ArrayBuffer(1) });
      await (await reportsRoot()).removeEntry('_probe', { recursive: true });
      opfsWorks = true;
    } catch (e) {
      console.warn('OPFS unavailable, using memory', e);
      opfsWorks = false;
    }
    return opfsWorks;
  }

  /** Streaming writer for a recording. write() calls are queued so chunks stay in order. */
  async function openWriter(reportId, name) {
    if (await checkOpfs()) {
      const h = await rpc({ op: 'open', reportId, name });
      let chain = Promise.resolve(), bytes = 0, failed = null;
      return {
        kind: 'opfs',
        get bytes() { return bytes; },
        get failed() { return failed; },
        write(blob) {
          chain = chain.then(async () => {
            if (failed) return;
            try {
              const buf = await blob.arrayBuffer();
              bytes = await rpc({ op: 'write', h, buf }, [buf]);
            } catch (e) { failed = e; }
          });
          return chain;
        },
        async close() {
          await chain;
          await rpc({ op: 'close', h }).catch(() => {});
          if (failed) throw failed;
        },
      };
    }
    const chunks = [];
    let bytes = 0;
    return {
      kind: 'memory',
      get bytes() { return bytes; },
      failed: null,
      write(blob) { chunks.push(blob); bytes += blob.size; return Promise.resolve(); },
      async close() { memFiles.set(`${reportId}/${name}`, new Blob(chunks, { type: chunks[0]?.type })); },
    };
  }

  async function writeFile(reportId, name, blob) {
    if (await checkOpfs()) {
      const buf = await blob.arrayBuffer();
      await rpc({ op: 'writeFile', reportId, name, buf }, [buf]);
      return 'opfs';
    }
    memFiles.set(`${reportId}/${name}`, blob);
    return 'memory';
  }

  async function getFile(reportId, name) {
    const mem = memFiles.get(`${reportId}/${name}`);
    if (mem) return mem;
    if (!opfsAvailable) return null;
    try {
      const fh = await (await reportDir(reportId)).getFileHandle(name);
      return await fh.getFile();
    } catch { return null; }
  }

  async function deleteFile(reportId, name) {
    memFiles.delete(`${reportId}/${name}`);
    if (!opfsAvailable) return;
    try { await (await reportDir(reportId)).removeEntry(name); } catch { /* already gone */ }
  }

  async function deleteReport(reportId) {
    for (const k of [...memFiles.keys()]) if (k.startsWith(reportId + '/')) memFiles.delete(k);
    if (opfsAvailable) {
      try { await (await reportsRoot()).removeEntry(reportId, { recursive: true }); } catch { /* none */ }
    }
    await removeReportMeta(reportId);
  }

  async function estimate() {
    try {
      const { quota, usage } = await navigator.storage.estimate();
      return { quota, usage, free: Math.max(0, quota - usage) };
    } catch { return null; }
  }

  async function persist() {
    try { return navigator.storage.persist ? await navigator.storage.persist() : false; } catch { return false; }
  }

  // ------------------------------------------------------------ export
  const canPickFolder = typeof window.showDirectoryPicker === 'function';

  /** Copy entries [{name, blob}] into <picked folder>/<folderName>/. Returns the path written. */
  async function exportToFolder(folderName, entries) {
    let root = await kvGet('exportDir');
    if (root) {
      try {
        let p = await root.queryPermission({ mode: 'readwrite' });
        if (p !== 'granted') p = await root.requestPermission({ mode: 'readwrite' });
        if (p !== 'granted') root = null;
      } catch { root = null; }
    }
    if (!root) {
      root = await window.showDirectoryPicker({ id: 'badbus', mode: 'readwrite', startIn: 'documents' });
      await kvSet('exportDir', root);
    }
    const dir = await root.getDirectoryHandle(folderName, { create: true });
    for (const e of entries) {
      const fh = await dir.getFileHandle(e.name, { create: true });
      const w = await fh.createWritable();
      await e.blob.stream().pipeTo(w);
    }
    return `${root.name}/${folderName}`;
  }
  async function forgetExportFolder() { await kvSet('exportDir', null); }

  // Uncompressed ZIP (videos and JPEGs don't compress anyway). Built from Blob parts,
  // so large videos are never copied into memory; only the CRC pass reads them.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  async function crc32(blob) {
    let c = 0xFFFFFFFF;
    const reader = blob.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i++) c = CRC_TABLE[(c ^ value[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  async function makeZip(folderName, entries, onProgress = () => {}) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.blob.size >= 0xFFFFFFFF) throw new Error(`${e.name} is over 4 GB — save it on its own`);
      onProgress(i, entries.length, e.name);
      const name = enc.encode(`${folderName}/${e.name}`);
      const crc = await crc32(e.blob);
      const d = new Date(e.t || Date.now());
      const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
      const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, time, true); lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, e.blob.size, true); lh.setUint32(22, e.blob.size, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(lh.buffer, name, e.blob);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, time, true);
      ch.setUint16(14, date, true); ch.setUint32(16, crc, true); ch.setUint32(20, e.blob.size, true);
      ch.setUint32(24, e.blob.size, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(ch.buffer, name);
      offset += 30 + name.length + e.blob.size;
      if (offset >= 0xFFFFFFFF) throw new Error('Report is over 4 GB — save the videos one by one');
    }
    const cdSize = central.reduce((n, p) => n + (p.byteLength ?? p.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  return {
    listReports, putReport, deleteReport, kvGet, kvSet,
    openWriter, writeFile, getFile, deleteFile, checkOpfs,
    estimate, persist, canPickFolder, exportToFolder, forgetExportFolder, makeZip,
    get usingMemory() { return opfsWorks === false; },
  };
})();
