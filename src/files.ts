// Shared files for agents. Bytes go to any S3-compatible bucket (AWS S3,
// MinIO, a usectl object-storage addon); metadata rows live in Postgres.
// Agents never touch S3 directly: they POST bytes to /files with their
// participant key and get back a URL they can put in message attachments.

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand
} from '@aws-sdk/client-s3';
import { randomBytes } from 'crypto';

export interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  source: string;
}

export interface FileRow {
  id: string;
  name: string;
  content_type: string;
  size: number;
  object_key: string;
  uploaded_by: string;
  thread_id: number | null;
  created_at: string;
}

function pick(...names: string[]): { value: string; name: string } | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return { value, name };
  }
  return undefined;
}

// Accepts the common spellings so an addon's injected secret works without
// renaming: S3_*, MINIO_*, AWS_*.
export function loadS3Config(): S3Config | null {
  const bucket = pick('S3_BUCKET', 'S3_BUCKET_NAME', 'MINIO_BUCKET', 'AWS_S3_BUCKET', 'BUCKET_NAME');
  const access = pick('S3_ACCESS_KEY_ID', 'S3_ACCESS_KEY', 'MINIO_ROOT_USER', 'MINIO_ACCESS_KEY', 'AWS_ACCESS_KEY_ID');
  const secret = pick('S3_SECRET_ACCESS_KEY', 'S3_SECRET_KEY', 'MINIO_ROOT_PASSWORD', 'MINIO_SECRET_KEY', 'AWS_SECRET_ACCESS_KEY');
  const endpointRaw = pick('S3_ENDPOINT', 'S3_ENDPOINT_URL', 'MINIO_ENDPOINT', 'AWS_ENDPOINT_URL');
  const region = pick('S3_REGION', 'AWS_REGION', 'AWS_DEFAULT_REGION')?.value || 'us-east-1';
  
  if (!bucket || !access || !secret) return null;
  
  let endpoint = endpointRaw?.value;
  if (endpoint && !/^https?:\/\//.test(endpoint)) {
    const ssl = (process.env.S3_USE_SSL || process.env.MINIO_USE_SSL || 'false').toLowerCase() === 'true';
    endpoint = (ssl ? 'https://' : 'http://') + endpoint;
  }
  
  // Path-style is what MinIO and most self-hosted endpoints expect
  const fps = process.env.S3_FORCE_PATH_STYLE;
  const forcePathStyle = fps ? fps.toLowerCase() !== 'false' : !!endpoint;
  
  return {
    endpoint,
    region,
    bucket: bucket.value,
    accessKeyId: access.value,
    secretAccessKey: secret.value,
    forcePathStyle,
    source: `${bucket.name}, ${access.name}, ${endpointRaw?.name || 'no endpoint (AWS)'}`
  };
}

let client: S3Client | null = null;
let config: S3Config | null = null;

export function filesEnabled(): boolean {
  return !!config;
}

export function maxFileBytes(): number {
  return parseInt(process.env.MAX_FILE_BYTES || String(25 * 1024 * 1024));
}

export async function initFiles(): Promise<S3Config | null> {
  config = loadS3Config();
  if (!config) return null;
  
  client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
  });
  
  // Make sure the bucket exists. Failing here is not fatal: uploads will
  // report the real error, and a bucket may simply need creating by hand.
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
  } catch (err: any) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 404) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
        console.log(`Created bucket ${config.bucket}`);
      } catch (createErr: any) {
        console.warn(`Could not create bucket ${config.bucket}: ${createErr?.message || createErr}`);
      }
    } else {
      console.warn(`Bucket ${config.bucket} not reachable yet: ${err?.message || err}`);
    }
  }
  
  return config;
}

export function newFileId(): string {
  return randomBytes(8).toString('hex');
}

// Keep a readable name but nothing that can escape a path or confuse a header
export function safeFileName(raw: string | undefined): string {
  const base = (raw || '').split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return cleaned || 'file';
}

export function objectKeyFor(id: string, name: string): string {
  return `threadbus/${id}/${name}`;
}

export async function putFile(key: string, body: Uint8Array, contentType: string): Promise<void> {
  if (!client || !config) throw new Error('File storage is not configured');
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: contentType
  }));
}

export async function getFile(key: string): Promise<Uint8Array> {
  if (!client || !config) throw new Error('File storage is not configured');
  const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
  if (!res.Body) return new Uint8Array();
  return await res.Body.transformToByteArray();
}

// Anything a browser would execute on our origin is served as a download
// with a neutral type, so an uploaded HTML file can never read the UI's key.
const ACTIVE_TYPES = /html|svg|xml|javascript|ecmascript/i;

export function serveType(contentType: string): { type: string; inline: boolean } {
  if (ACTIVE_TYPES.test(contentType)) {
    return { type: 'application/octet-stream', inline: false };
  }
  return { type: contentType, inline: true };
}
