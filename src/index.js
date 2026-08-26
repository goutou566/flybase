import {
  createS3,
  listObjects,
  putObject,
  getObject,
  deleteObject,
  createShareUrl,
  createMultipartUpload,
  presignUploadPart,
  presignPutObject,
  presignCreateMultipart,
  presignCompleteMultipart,
  presignAbortMultipart,
  presignDeleteObject,
  completeMultipartUpload,
  abortMultipartUpload,
  mimeFromKey,
  toEnvKey,
} from './s3.js';
import {
  beginRegistration,
  finishRegistration,
  beginLogin,
  finishLogin,
  verifySession,
  logout,
  deletePasskey,
  passkeyStatus,
} from './passkey.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, url, env);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, url, env) {
  const s3 = createS3(env);
  const bucket = env.FILEBASE_BUCKET;
  const path = url.pathname;

  if (path === '/api/objects' && request.method === 'GET') {
    try {
      const objects = await listObjects(s3, bucket, url.searchParams.get('prefix') || '');
      return json({ objects });
    } catch (err) {
      return serverError(err);
    }
  }

  const passkeyResponse = await handlePasskeyRoutes(request, url, env);
  if (passkeyResponse) {
    return passkeyResponse;
  }

  // [临时开放写权限] 原逻辑: 写方法需 verifySession。临时禁用登录验证，保留原代码以便恢复
  if (request.method === 'PUT' || request.method === 'DELETE' || request.method === 'POST') {
    // if (!(await verifySession(request, env))) {
    //   return unauthorized();
    // }
  }

  const multipartMatch = path.match(/^\/api\/multipart\/(.+)$/);
  if (multipartMatch) {
    return handleMultipart(request, url, env, s3, bucket, toEnvKey(multipartMatch[1]));
  }

  const match = path.match(/^\/api\/objects\/(.+)$/);
  if (!match) {
    return notFound();
  }

  const rawKey = match[1];

  if (rawKey.endsWith('/share')) {
    const key = toEnvKey(rawKey.slice(0, -'/share'.length));
    const expires = parseInt(url.searchParams.get('expires') || '3600', 10);
    try {
      const shareUrl = await createShareUrl(s3, bucket, key, expires);
      return json({ key, shareUrl, expiresIn: expires });
    } catch (err) {
      return serverError(err);
    }
  }

  if (rawKey.endsWith('/presign-delete')) {
    const key = toEnvKey(rawKey.slice(0, -'/presign-delete'.length));
    try {
      const url2 = await presignDeleteObject(s3, bucket, key);
      return json({ key, presignedUrl: url2 });
    } catch (err) {
      return serverError(err);
    }
  }

  if (rawKey.endsWith('/presign-put')) {
    const key = toEnvKey(rawKey.slice(0, -'/presign-put'.length));
    try {
      const url2 = await presignPutObject(s3, bucket, key);
      return json({ key, presignedUrl: url2 });
    } catch (err) {
      return serverError(err);
    }
  }

  const key = toEnvKey(rawKey);

  switch (request.method) {
    case 'PUT': {
      const contentType =
        request.headers.get('content-type') || 'application/octet-stream';
      try {
        await putObject(s3, bucket, key, request.body, contentType);
        return json({ ok: true, key });
      } catch (err) {
        return serverError(err);
      }
    }
    case 'GET': {
      try {
        const forceDownload = url.searchParams.has('dl');
        const obj = await getObject(s3, bucket, key);
        const headers = new Headers();
        const type = obj.ContentType || mimeFromKey(key) || 'application/octet-stream';
        headers.set('Content-Type', type);
        const name = key.split('/').pop() || 'file';
        const inlinePreview = !forceDownload && /^(image\/|application\/pdf|text\/)/.test(type);
        headers.set(
          'Content-Disposition',
          `${inlinePreview ? 'inline' : 'attachment'}; filename="${name.replace(/"/g, '')}"`
        );
        if (obj.ContentLength) {
          headers.set('Content-Length', String(obj.ContentLength));
        }
        return new Response(obj.Body, { headers });
      } catch (err) {
        return serverError(err);
      }
    }
    case 'DELETE': {
      try {
        await deleteObject(s3, bucket, key);
        return json({ ok: true, key });
      } catch (err) {
        return serverError(err);
      }
    }
    default:
      return new Response('Method not allowed', { status: 405 });
  }
}

async function handleMultipart(request, url, env, s3, bucket, key) {
  const action = url.searchParams.get('action');

  try {
    if (request.method === 'POST' && action === 'init') {
      const contentType = request.headers.get('content-type') || 'application/octet-stream';
      const uploadId = await createMultipartUpload(s3, bucket, key, contentType);
      return json({ key, uploadId });
    }

    if (request.method === 'GET' && action === 'presign') {
      const partNumber = parseInt(url.searchParams.get('partNumber'), 10);
      if (!partNumber || partNumber < 1 || partNumber > 10000) {
        return json({ error: 'partNumber must be 1-10000' }, 400);
      }
      const uploadId = url.searchParams.get('uploadId');
      if (!uploadId) {
        return json({ error: 'uploadId required' }, 400);
      }
      const presignedUrl = await presignUploadPart(s3, bucket, key, uploadId, partNumber);
      return json({ key, uploadId, partNumber, presignedUrl });
    }

    if (request.method === 'GET' && action === 'presign-batch') {
      const uploadId = url.searchParams.get('uploadId');
      const start = parseInt(url.searchParams.get('start'), 10);
      let count = parseInt(url.searchParams.get('count'), 10);
      if (!uploadId || !start || start < 1 || start > 10000) {
        return json({ error: 'uploadId and valid start are required' }, 400);
      }
      if (!count || count < 1) count = 8;
      if (count > 64) count = 64;
      if (start + count - 1 > 10000) count = 10000 - start + 1;
      const items = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          presignUploadPart(s3, bucket, key, uploadId, start + i).then((presignedUrl) => ({
            partNumber: start + i,
            presignedUrl,
          }))
        )
      );
      return json({ key, uploadId, items });
    }

    if (request.method === 'GET' && action === 'presign-init') {
      const url2 = await presignCreateMultipart(s3, bucket, key);
      return json({ key, presignedUrl: url2 });
    }

    if (request.method === 'GET' && action === 'presign-complete') {
      const uploadId = url.searchParams.get('uploadId');
      if (!uploadId) {
        return json({ error: 'uploadId required' }, 400);
      }
      const url2 = await presignCompleteMultipart(s3, bucket, key, uploadId);
      return json({ key, uploadId, presignedUrl: url2 });
    }

    if (request.method === 'GET' && action === 'presign-abort') {
      const uploadId = url.searchParams.get('uploadId');
      if (!uploadId) {
        return json({ error: 'uploadId required' }, 400);
      }
      const url2 = await presignAbortMultipart(s3, bucket, key, uploadId);
      return json({ key, uploadId, presignedUrl: url2 });
    }

    if (request.method === 'POST' && action === 'complete') {
      const body = await request.json();
      const { uploadId, parts } = body;
      if (!uploadId || !Array.isArray(parts) || parts.length === 0) {
        return json({ error: 'uploadId and parts are required' }, 400);
      }
      await completeMultipartUpload(s3, bucket, key, uploadId, parts);
      return json({ ok: true, key });
    }

    if (request.method === 'POST' && action === 'abort') {
      const body = await request.json();
      const { uploadId } = body;
      if (!uploadId) {
        return json({ error: 'uploadId required' }, 400);
      }
      await abortMultipartUpload(s3, bucket, key, uploadId);
      return json({ ok: true, aborted: true });
    }

    return json({ error: 'Unknown multipart action' }, 400);
  } catch (err) {
    return serverError(err);
  }
}

async function handlePasskeyRoutes(request, url, env) {
  const path = url.pathname;

  if (!path.startsWith('/api/auth/')) {
    return null;
  }

  if (path === '/api/auth/status' && request.method === 'GET') {
    return json(await passkeyStatus(env));
  }

  const isWrite = request.method === 'POST' || request.method === 'DELETE';

  if (path === '/api/auth/register/options' && request.method === 'GET') {
    const result = await beginRegistration(request, env);
    return result.error ? json({ error: result.error }, result.status) : json(result);
  }

  if (path === '/api/auth/register/verify' && request.method === 'POST') {
    const result = await finishRegistration(request, env);
    return result.error ? json({ error: result.error }, result.status) : json(result);
  }

  // [临时开放写权限] 原逻辑: 写操作需 verifySession。临时禁用登录验证，保留原代码以便恢复
  if (isWrite && path !== '/api/auth/login/options' && path !== '/api/auth/login/verify') {
    // if (!(await verifySession(request, env))) {
    //   return unauthorized();
    // }
  }

  if (path === '/api/auth/login/options' && request.method === 'GET') {
    const result = await beginLogin(request, env);
    return result.error ? json({ error: result.error }, result.status) : json(result);
  }

  if (path === '/api/auth/login/verify' && request.method === 'POST') {
    const result = await finishLogin(request, env);
    return result.error ? json({ error: result.error }, result.status) : json(result);
  }

  if (path === '/api/auth/logout' && request.method === 'POST') {
    return json(await logout(request, env));
  }

  if (path === '/api/auth/passkey' && request.method === 'DELETE') {
    return json(await deletePasskey(request, env));
  }

  return notFound();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function unauthorized() {
  return new Response(JSON.stringify({ error: 'Admin authentication required' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function notFound() {
  return json({ error: 'Not found' }, 404);
}

function serverError(err) {
  return json({ error: err.message || 'Internal error' }, 500);
}
