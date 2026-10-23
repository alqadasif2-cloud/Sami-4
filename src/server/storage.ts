import { Storage } from '@google-cloud/storage';
import path from 'path';
import fs from 'fs';
import { memoryStore } from './db';

/**
 * Google Cloud Storage Service for Sami App
 * Configured within Free-Tier limits (5GB-months, 50,000 Class A, 50,000 Class B operations)
 * Features local secure storage fallback if cloud bucket is not provisioned.
 */

const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || 'majestic-interface-ksmzh';
const bucketName = process.env.GCS_BUCKET_NAME || `${projectId}-media`;

let storageClient: Storage | null = null;
let useCloudStorage = false;

try {
  storageClient = new Storage({ projectId });
  useCloudStorage = true;
} catch {
  useCloudStorage = false;
}

// Local cache directory for uploads
const UPLOADS_DIR = path.resolve('data/uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

export interface StoredFile {
  id: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  fileUrl: string;
  storagePath: string;
  uploaderId: number;
  createdAt: number;
}

export async function saveFile(
  fileName: string,
  buffer: Buffer,
  mimeType: string,
  uploaderId: number,
  folder: 'chat_images' | 'chat_files' | 'chat_audio' | 'avatars' = 'chat_files'
): Promise<StoredFile> {
  const now = Date.now();
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const fileId = `${folder}_${uploaderId}_${now}_${Math.random().toString(36).substring(2, 8)}`;
  const storagePath = `${folder}/${fileId}_${safeName}`;
  const fileSize = buffer.length;

  let fileUrl = `/api/files/${fileId}`;

  // 1. Try Google Cloud Storage if available
  if (useCloudStorage && storageClient) {
    try {
      const bucket = storageClient.bucket(bucketName);
      const file = bucket.file(storagePath);
      await file.save(buffer, {
        contentType: mimeType,
        metadata: {
          uploaderId: String(uploaderId),
          originalName: fileName,
        },
      });
      // In production with public read or signed URLs
      // fileUrl = `https://storage.googleapis.com/${bucketName}/${storagePath}`;
    } catch (err) {
      console.warn('[Sami Storage] Google Cloud Storage write notice, using local file store:', err);
    }
  }

  // 2. Save locally for guaranteed resilience
  const localFilePath = path.join(UPLOADS_DIR, `${fileId}_${safeName}`);
  fs.writeFileSync(localFilePath, buffer);

  const record: StoredFile = {
    id: fileId,
    fileName,
    fileSize,
    fileType: mimeType,
    fileUrl,
    storagePath,
    uploaderId,
    createdAt: now,
  };

  memoryStore.files.set(fileId, { ...record, localPath: localFilePath, buffer });
  return record;
}

export function getFile(fileId: string): { file: StoredFile; buffer: Buffer } | null {
  const item = memoryStore.files.get(fileId);
  if (item) {
    let buf = item.buffer;
    if (!buf && item.localPath && fs.existsSync(item.localPath)) {
      buf = fs.readFileSync(item.localPath);
    }
    if (buf) {
      return { file: item, buffer: buf };
    }
  }

  // Scan local directory by prefix
  const files = fs.readdirSync(UPLOADS_DIR);
  const match = files.find((f) => f.startsWith(`${fileId}_`));
  if (match) {
    const fullPath = path.join(UPLOADS_DIR, match);
    const buf = fs.readFileSync(fullPath);
    return {
      file: {
        id: fileId,
        fileName: match.replace(`${fileId}_`, ''),
        fileSize: buf.length,
        fileType: 'application/octet-stream',
        fileUrl: `/api/files/${fileId}`,
        storagePath: `uploads/${match}`,
        uploaderId: 0,
        createdAt: Date.now(),
      },
      buffer: buf,
    };
  }

  return null;
}
