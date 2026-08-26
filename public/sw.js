// flybase download bridge: serves blobs from page messages as real
// attachment responses so the browser's native downloader handles the
// filename (Safari ignores <a download> for async blob URLs).
const pending = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'download' && data.token) {
    const headers = {
      'Content-Type': data.mime || 'application/octet-stream',
      'Content-Length': String(data.size),
    };
    const fallback = (data.filename || 'download').replace(/["\r\n]/g, '');
    const encoded = encodeURIComponent(data.filename || 'download');
    headers['Content-Disposition'] =
      `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
    pending.set(
      data.token,
      new Response(data.blob, { headers })
    );
    setTimeout(() => pending.delete(data.token), 120000);
    if (event.source && event.source.postMessage) {
      event.source.postMessage({ type: 'download-ready', token: data.token });
    }
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/^\/__download\/([A-Za-z0-9-]+)$/);
  if (!match) return;
  const token = match[1];
  const response = pending.get(token) || null;
  pending.delete(token);
  event.respondWith(
    response
      ? Promise.resolve(response)
      : Promise.resolve(new Response('download link expired', { status: 404 }))
  );
});
