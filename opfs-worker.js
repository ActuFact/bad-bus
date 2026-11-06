// Writes recordings into the browser's private file storage (OPFS) chunk by chunk.
// Sync access handles write in place and are flushed after every chunk, so if the
// app is closed or crashes mid-recording, everything up to the last second is on disk.
'use strict';

const handles = new Map();
let next = 0;

async function reportDir(reportId) {
  const root = await navigator.storage.getDirectory();
  const reports = await root.getDirectoryHandle('reports', { create: true });
  return reports.getDirectoryHandle(reportId, { create: true });
}

async function open(reportId, name) {
  const dir = await reportDir(reportId);
  const fh = await dir.getFileHandle(name, { create: true });
  const ah = await fh.createSyncAccessHandle();
  await ah.truncate(0);
  const h = ++next;
  handles.set(h, { ah, pos: 0 });
  return h;
}

async function write(h, buf) {
  const x = handles.get(h);
  if (!x) throw new Error('file not open');
  const n = await x.ah.write(new Uint8Array(buf), { at: x.pos });
  x.pos += n;
  await x.ah.flush();
  return x.pos;
}

async function close(h) {
  const x = handles.get(h);
  if (!x) return true;
  handles.delete(h);
  await x.ah.flush();
  await x.ah.close();
  return true;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    let result;
    if (m.op === 'open') result = await open(m.reportId, m.name);
    else if (m.op === 'write') result = await write(m.h, m.buf);
    else if (m.op === 'close') result = await close(m.h);
    else if (m.op === 'writeFile') {
      const h = await open(m.reportId, m.name);
      result = await write(h, m.buf);
      await close(h);
    } else throw new Error('unknown op ' + m.op);
    self.postMessage({ id: m.id, result });
  } catch (err) {
    self.postMessage({ id: m.id, error: String((err && err.message) || err) });
  }
};
