import {
  createS3,
  listObjects,
  putObject,
  getObject,
  deleteObject,
  createShareUrl,
  createMultipartUpload,
  presignUploadPart,
  completeMultipartUpload,
  abortMultipartUpload,
  toEnvKey,
} from './s3.js';

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

  if (request.method === 'PUT' || request.method === 'DELETE' || request.method === 'POST') {
    if (!isAdmin(request, env)) {
      return unauthorized();
    }
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
        const obj = await getObject(s3, bucket, key);
        const headers = new Headers();
        headers.set('Content-Type', obj.ContentType || 'application/octet-stream');
        const name = key.split('/').pop() || 'file';
        headers.set('Content-Disposition', `inline; filename="${name.replace(/"/g, '')}"`);
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isAdmin(request, env) {
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) {
    return false;
  }
  const expected = 'admin:' + (env.ADMIN_PASSWORD || '');
  try {
    const decoded = atob(header.slice(6).trim());
    if (decoded.length !== expected.length) {
      return false;
    }
    let diff = 0;
    for (let i = 0; i < decoded.length; i++) {
      diff |= decoded.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

function unauthorized() {
  return new Response(JSON.stringify({ error: 'Admin authentication required' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Basic realm="flybase admin", charset="UTF-8"',
    },
  });
}

function notFound() {
  return json({ error: 'Not found' }, 404);
}

function serverError(err) {
  return json({ error: err.message || 'Internal error' }, 500);
}
