import { Firestore } from '@google-cloud/firestore';
import crypto from 'crypto';

/**
 * Google Cloud Firestore & Persistence Layer for Sami App
 * Configured for Google Cloud Run with Zero-Trust RBAC and Free-Tier Optimization.
 */

const isProd = process.env.NODE_ENV === 'production';
const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || 'majestic-interface-ksmzh';
const databaseId = process.env.FIRESTORE_DATABASE_ID || '(default)';

let firestoreClient: Firestore | null = null;
let useFirestore = false;

try {
  firestoreClient = new Firestore({
    projectId: projectId,
    databaseId: databaseId === '(default)' ? undefined : databaseId,
    // When deployed on Cloud Run, credentials are automatically resolved via Google ADC
  });
  useFirestore = true;
  console.log(`[Sami DB] Google Cloud Firestore client initialized for project: ${projectId}, database: ${databaseId}`);
} catch (err) {
  console.warn('[Sami DB] Google Cloud Firestore ADC not available, using in-memory resilient storage:', err);
  useFirestore = false;
}

// In-Memory Fallback Cache & Data Store (Guarantees zero-cost, instant startup, and resilience)
interface MemoryStore {
  users: Map<number, any>;
  channels: Map<string, any>;
  channelMessages: Map<string, any[]>;
  privateMessages: Map<string, any[]>;
  challenges: Map<number, any>;
  trades: Map<string, any[]>;
  packages: any[];
  warnings: any[];
  files: Map<string, any>;
}

export const memoryStore: MemoryStore = {
  users: new Map(),
  channels: new Map(),
  channelMessages: new Map(),
  privateMessages: new Map(),
  challenges: new Map(),
  trades: new Map(),
  packages: [],
  warnings: [],
  files: new Map(),
};

// Password Hashing with Salt (PBKDF2 SHA-512)
export function hashPassword(password: string, salt: string = 'sami_gold_salt_2026'): string {
  return crypto.pbkdf2Sync(password, salt, 10000, 32, 'sha512').toString('hex');
}

export function verifyPassword(password: string, hash: string, salt: string = 'sami_gold_salt_2026'): boolean {
  const calculated = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(hash));
}

// Initial Seed Users for New Clean Database
export const INITIAL_USERS = [
  { id: 1, username: 'Sami', displayName: 'Sami', passwordHash: hashPassword('12345678'), role: 'owner', avatarUrl: null, createdAt: Date.now() },
  { id: 2, username: 'Hani Alqadasi', displayName: 'Hani Alqadasi', passwordHash: hashPassword('Hani33334'), role: 'user', avatarUrl: null, createdAt: Date.now() },
  { id: 3, username: 'Eslam Alqadasi', displayName: 'Eslam Alqadasi', passwordHash: hashPassword('55555555'), role: 'user', avatarUrl: null, createdAt: Date.now() },
  { id: 4, username: 'Omar Ali', displayName: 'Omar Ali', passwordHash: hashPassword('Omar1234'), role: 'user', avatarUrl: null, createdAt: Date.now() },
  { id: 5, username: 'Ahmed Saleh', displayName: 'Ahmed Saleh', passwordHash: hashPassword('Ahmed123'), role: 'user', avatarUrl: null, createdAt: Date.now() },
  { id: 6, username: 'Mohammed Ali', displayName: 'Mohammed Ali', passwordHash: hashPassword('Mo2025'), role: 'user', avatarUrl: null, createdAt: Date.now() },
];

// Initial Seed Channels
export const INITIAL_CHANNELS = [
  {
    id: 'general_trading',
    name: '💬 دردشة عامة - دفعة 3000$',
    description: 'القناة العامة لتبادل الأفكار والنقاشات بين جميع المشتركين.',
    isPrivate: false,
    visibility: 'public',
    allowedMemberIds: [],
    memberIds: [1, 2, 3, 4, 5, 6],
    createdAt: Date.now(),
  },
  {
    id: 'signals_vip',
    name: '👑 قناة Sami VIP الخاصة',
    description: 'قناة التوصيات والصفقات المتقدمة الخاصة بالأعضاء المصرح لهم فقط.',
    isPrivate: true,
    visibility: 'hidden', // Hidden from unauthorized users
    allowedMemberIds: [1], // Only owner initially
    memberIds: [1],
    createdAt: Date.now(),
  },
];

// Seed memory store
for (const u of INITIAL_USERS) {
  memoryStore.users.set(u.id, u);
}
for (const c of INITIAL_CHANNELS) {
  memoryStore.channels.set(c.id, c);
}

export { firestoreClient, useFirestore };
