import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export function createS3(env) {
  return new S3Client({
    endpoint: env.FILEBASE_ENDPOINT,
    region: env.FILEBASE_REGION || 'us-east-1',
    credentials: {
      accessKeyId: env.FILEBASE_ACCESS_KEY,
      secretAccessKey: env.FILEBASE_SECRET_KEY,
    },
    forcePathStyle: true,
    signatureVersion: 'v4',
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export function toEnvKey(key) {
  return decodeURIComponent(key);
}

export async function listObjects(s3, bucket, prefix) {
  const command = new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix || '',
  });
  const res = await s3.send(command);
  return (res.Contents || [])
    .filter((obj) => obj.Key && !obj.Key.endsWith('/'))
    .map((obj) => ({
      key: obj.Key,
      size: obj.Size,
      lastModified: obj.LastModified,
    }));
}

export async function putObject(s3, bucket, key, body, contentType) {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
  });
  return s3.send(command);
}

export async function getObject(s3, bucket, key) {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return s3.send(command);
}

export async function deleteObject(s3, bucket, key) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const command = new DeleteObjectCommand({ Bucket: bucket, Key: key });
      return await s3.send(command);
    } catch (err) {
      lastErr = err;
      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  throw lastErr;
}

export async function createShareUrl(s3, bucket, key, expiresInSeconds) {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const url = await getSignedUrl(s3, command, {
    expiresIn: expiresInSeconds || 3600,
  });
  return url;
}

export async function createMultipartUpload(s3, bucket, key, contentType) {
  const command = new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
  });
  const res = await s3.send(command);
  return res.UploadId;
}

export async function presignUploadPart(s3, bucket, key, uploadId, partNumber) {
  const command = new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(s3, command, { expiresIn: 6 * 3600 });
}

export async function completeMultipartUpload(s3, bucket, key, uploadId, parts) {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const command = new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: sorted.map((p) => ({
        PartNumber: p.partNumber,
        ETag: p.etag,
      })),
    },
  });
  return s3.send(command);
}

export async function abortMultipartUpload(s3, bucket, key, uploadId) {
  const command = new AbortMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
  });
  return s3.send(command);
}
