import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
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
  const command = new DeleteObjectCommand({ Bucket: bucket, Key: key });
  return s3.send(command);
}

export async function createShareUrl(s3, bucket, key, expiresInSeconds) {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const url = await getSignedUrl(s3, command, {
    expiresIn: expiresInSeconds || 3600,
  });
  return url;
}
