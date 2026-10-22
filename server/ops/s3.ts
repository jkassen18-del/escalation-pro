import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';

/**
 * Just enough of the S3 API for backups: put, get and delete one object,
 * signed with AWS Signature Version 4. Works against AWS S3, Cloudflare R2,
 * DigitalOcean Spaces, MinIO, Backblaze B2 and any other S3-compatible store.
 */
export interface S3Target {
  endpoint?: string;
  region?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** RFC 3986 encoding, which is what SigV4 canonicalises with. */
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

export function objectUrl(target: S3Target, key: string): URL {
  const region = target.region || 'us-east-1';
  if (!target.endpoint) return new URL(`https://${target.bucket}.s3.${region}.amazonaws.com/${encodeKey(key)}`);
  // Path-style for everything else: it is what MinIO and most compatibles expect.
  return new URL(`${target.endpoint.replace(/\/+$/, '')}/${target.bucket}/${encodeKey(key)}`);
}

export function signRequest(
  target: S3Target,
  method: string,
  url: URL,
  payloadHash: string,
  extraHeaders: Record<string, string> = {},
  now = new Date(),
): Record<string, string> {
  const region = target.region || 'us-east-1';
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const signedHeaders = Object.keys(headers).sort();
  const canonical = [
    method,
    url.pathname,
    url.searchParams.toString(),
    signedHeaders.map((h) => `${h}:${headers[h].trim()}\n`).join(''),
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${target.secretAccessKey}`, date), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
  };
}

function send(url: URL, method: string, headers: Record<string, string>, body?: Readable): Promise<http.IncomingMessage> {
  const transport = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, { method, headers, timeout: 120_000 }, resolve);
    req.on('timeout', () => req.destroy(new Error('Object storage did not answer in time')));
    req.on('error', reject);
    if (body) body.pipe(req);
    else req.end();
  });
}

async function readError(response: http.IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of response) text += chunk;
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
  const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
  return `${response.statusCode}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`;
}

export async function putObject(target: S3Target, key: string, file: string, sha256: string, { objectLockDays }: { objectLockDays?: number } = {}): Promise<string> {
  const url = objectUrl(target, key);
  const size = fs.statSync(file).size;
  const extra: Record<string, string> = { 'content-type': 'application/octet-stream', 'content-length': String(size) };
  if (objectLockDays) {
    // Immutable copies: the bucket must have Object Lock enabled.
    extra['x-amz-object-lock-mode'] = 'COMPLIANCE';
    extra['x-amz-object-lock-retain-until-date'] = new Date(Date.now() + objectLockDays * 86_400_000).toISOString();
  }
  const response = await send(url, 'PUT', signRequest(target, 'PUT', url, sha256, extra), fs.createReadStream(file));
  if (response.statusCode !== 200) throw new Error(`Upload failed: ${await readError(response)}`);
  response.resume();
  return `s3://${target.bucket}/${key}`;
}

export async function getObject(target: S3Target, key: string): Promise<http.IncomingMessage> {
  const url = objectUrl(target, key);
  const response = await send(url, 'GET', signRequest(target, 'GET', url, sha256Hex('')));
  if (response.statusCode !== 200) throw new Error(`Download failed: ${await readError(response)}`);
  return response;
}

export async function deleteObject(target: S3Target, key: string): Promise<void> {
  const url = objectUrl(target, key);
  const response = await send(url, 'DELETE', signRequest(target, 'DELETE', url, sha256Hex('')));
  if (response.statusCode !== 204 && response.statusCode !== 200) throw new Error(`Delete failed: ${await readError(response)}`);
  response.resume();
}
