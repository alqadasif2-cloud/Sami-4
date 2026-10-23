import { Router } from 'express';
import { memoryStore, hashPassword, verifyPassword } from './db';
import { authenticateToken, requireAuth, requireRole, generateToken } from './auth';
import { saveFile, getFile } from './storage';

export const apiRouter = Router();

// Apply auth token parser to all API routes
apiRouter.use(authenticateToken);

// ==========================================
// 1. HEALTH & SYSTEM CONFIG
// ==========================================
apiRouter.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'sami-cloud-run-api',
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

apiRouter.get('/config', (req, res) => {
  res.json({
    appName: 'Sami',
    version: '1.3.0',
    platform: 'google-cloud-run',
    database: 'Cloud Firestore Standard',
    storage: 'Google Cloud Storage',
    costTier: 'Free Tier Optimized',
    features: {
      audioMessaging: true,
      fileAttachments: true,
      privateChannels: true,
      tradingChallenge: true,
    },
  });
});

// ==========================================
// 2. AUTHENTICATION & USERS
// ==========================================
apiRouter.post('/auth/register', (req, res) => {
  const { username, displayName, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' });
  }

  const cleanUser = String(username).trim();
  const existing = Array.from(memoryStore.users.values()).find(
    (u) => u.username.toLowerCase() === cleanUser.toLowerCase()
  );

  if (existing) {
    return res.status(400).json({ error: 'اسم المستخدم مسجل مسبقاً، يرجى اختيار اسم آخر' });
  }

  const nextId = Math.max(...Array.from(memoryStore.users.keys()), 20) + 1;
  const newUser = {
    id: nextId,
    username: cleanUser,
    displayName: String(displayName || cleanUser).trim(),
    passwordHash: hashPassword(password),
    role: 'user' as const,
    avatarUrl: null,
    createdAt: Date.now(),
  };

  memoryStore.users.set(newUser.id, newUser);
  const token = generateToken(newUser);

  res.json({
    success: true,
    token,
    user: {
      id: newUser.id,
      username: newUser.username,
      displayName: newUser.displayName,
      role: newUser.role,
      avatarUrl: newUser.avatarUrl,
    },
  });
});

apiRouter.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'يرجى إدخال اسم المستخدم وكلمة المرور' });
  }

  const cleanUser = String(username).trim();
  const user = Array.from(memoryStore.users.values()).find(
    (u) => u.username.toLowerCase() === cleanUser.toLowerCase()
  );

  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  const token = generateToken(user);
  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      avatarUrl: user.avatarUrl,
    },
  });
});

apiRouter.post('/auth/guest', (req, res) => {
  const guestNumber = Math.floor(1000 + Math.random() * 9000);
  const guestId = 9000000 + guestNumber;
  const guestUser = {
    id: guestId,
    username: `guest_${guestNumber}`,
    displayName: `ضيف رقم ${guestNumber}`,
    role: 'guest' as const,
    avatarUrl: null,
    isGuest: true,
  };

  const token = generateToken(guestUser, 7);
  res.json({
    success: true,
    token,
    user: guestUser,
  });
});

apiRouter.get('/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

apiRouter.post('/auth/profile', requireAuth, (req, res) => {
  const { displayName, avatarUrl } = req.body;
  const user = memoryStore.users.get(req.user!.id);
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });

  if (displayName) user.displayName = String(displayName).trim();
  if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
  user.updatedAt = Date.now();

  res.json({ success: true, user });
});

apiRouter.get('/users', requireAuth, (req, res) => {
  const users = Array.from(memoryStore.users.values()).map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    avatarUrl: u.avatarUrl,
  }));
  res.json({ success: true, users });
});

// ==========================================
// 3. CHANNELS (With Strict Hidden Channel RBAC)
// ==========================================
apiRouter.get('/channels', requireAuth, (req, res) => {
  const user = req.user!;
  const isOwner = user.role === 'owner' || user.id === 1;

  // Filter channels based on strict server-side membership
  const accessibleChannels = Array.from(memoryStore.channels.values()).filter((ch) => {
    if (isOwner) return true;
    if (ch.visibility === 'hidden' || ch.isPrivate) {
      const members = ch.allowedMemberIds || ch.memberIds || [];
      return members.includes(user.id);
    }
    return true; // Public channels
  });

  res.json({ success: true, channels: accessibleChannels });
});

apiRouter.get('/channels/:id/messages', requireAuth, (req, res) => {
  const channelId = req.params.id;
  const user = req.user!;
  const isOwner = user.role === 'owner' || user.id === 1;

  const channel = memoryStore.channels.get(channelId);
  if (!channel) return res.status(404).json({ error: 'القناة غير موجودة' });

  // Verify access for hidden/private channels on server
  if (channel.visibility === 'hidden' || channel.isPrivate) {
    const members = channel.allowedMemberIds || channel.memberIds || [];
    if (!isOwner && !members.includes(user.id)) {
      return res.status(403).json({ error: 'ليس لديك تصريح للوصول إلى هذه القناة' });
    }
  }

  // Get messages with pagination (limit to reduce bandwidth & quota)
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before ? Number(req.query.before) : Date.now();

  const allMsgs = memoryStore.channelMessages.get(channelId) || [];
  const filtered = allMsgs
    .filter((m) => m.timestamp <= before)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-limit);

  res.json({
    success: true,
    messages: filtered,
    hasMore: allMsgs.length > filtered.length,
  });
});

apiRouter.post('/channels/:id/messages', requireAuth, (req, res) => {
  const channelId = req.params.id;
  const user = req.user!;
  const isOwner = user.role === 'owner' || user.id === 1;

  const channel = memoryStore.channels.get(channelId);
  if (!channel) return res.status(404).json({ error: 'القناة غير موجودة' });

  if (channel.visibility === 'hidden' || channel.isPrivate) {
    const members = channel.allowedMemberIds || channel.memberIds || [];
    if (!isOwner && !members.includes(user.id)) {
      return res.status(403).json({ error: 'غير مصرح لك بالكتابة في هذه القناة' });
    }
  }

  const { text, imageUrl, fileAttachment, replyTo } = req.body;
  if (!text && !imageUrl && !fileAttachment) {
    return res.status(400).json({ error: 'محتوى الرسالة فارغ' });
  }

  const now = Date.now();
  const msgId = `msg_${now}_${user.id}_${Math.random().toString(36).substring(2, 7)}`;

  const message = {
    id: msgId,
    channelId,
    senderId: user.id,
    senderName: user.displayName,
    senderRole: user.role,
    senderAvatarUrl: user.avatarUrl || null,
    text: text ? String(text).trim() : undefined,
    imageUrl: imageUrl || undefined,
    fileName: fileAttachment?.fileName,
    fileSize: fileAttachment?.fileSize,
    fileType: fileAttachment?.fileType,
    fileUrl: fileAttachment?.fileUrl,
    audioUrl: fileAttachment?.audioUrl || (fileAttachment?.fileType?.startsWith('audio/') ? fileAttachment?.fileUrl : undefined),
    audioDuration: fileAttachment?.audioDuration,
    storagePath: fileAttachment?.storagePath,
    replyToId: replyTo?.id || null,
    replyToSenderName: replyTo?.senderName || null,
    replyToText: replyTo?.text || null,
    timestamp: now,
  };

  const msgs = memoryStore.channelMessages.get(channelId) || [];
  msgs.push(message);
  memoryStore.channelMessages.set(channelId, msgs);

  res.json({ success: true, message });
});

// ==========================================
// 4. PRIVATE MESSAGES (With Strict Isolation)
// ==========================================
apiRouter.get('/private-messages', requireAuth, (req, res) => {
  const user = req.user!;
  const isOwnerOrMod = user.id === 1 || user.role === 'owner' || user.role === 'moderator';
  const partnerId = req.query.partnerId ? Number(req.query.partnerId) : null;

  let allPrivate: any[] = [];
  for (const list of memoryStore.privateMessages.values()) {
    allPrivate.push(...list);
  }

  // Strict user isolation
  const filtered = allPrivate.filter((msg) => {
    const isParticipant =
      msg.participantId === user.id ||
      msg.senderId === user.id ||
      msg.receiverId === user.id;

    if (isOwnerOrMod) {
      if (partnerId) {
        return (
          msg.participantId === partnerId ||
          msg.senderId === partnerId ||
          msg.receiverId === partnerId
        );
      }
      return true;
    }

    if (!isParticipant) return false;
    if (partnerId) {
      return (
        (msg.senderId === user.id && msg.receiverId === partnerId) ||
        (msg.senderId === partnerId && msg.receiverId === user.id) ||
        msg.participantId === partnerId
      );
    }
    return true;
  });

  filtered.sort((a, b) => a.timestamp - b.timestamp);
  const limit = Math.min(Number(req.query.limit) || 80, 100);

  res.json({
    success: true,
    messages: filtered.slice(-limit),
  });
});

apiRouter.post('/private-messages', requireAuth, (req, res) => {
  const user = req.user!;
  const { receiverId, partnerId, text, imageUrl, fileAttachment, replyTo } = req.body;

  const targetPartner = Number(receiverId || partnerId || 1);
  const now = Date.now();
  const msgId = `pm_${now}_${user.id}_${Math.random().toString(36).substring(2, 7)}`;

  const message = {
    id: msgId,
    participantId: user.id === 1 || user.role === 'moderator' ? targetPartner : user.id,
    participantName: user.displayName,
    senderId: user.id,
    senderName: user.displayName,
    senderRole: user.role,
    senderAvatarUrl: user.avatarUrl || null,
    receiverId: targetPartner,
    text: text ? String(text).trim() : undefined,
    imageUrl: imageUrl || undefined,
    fileName: fileAttachment?.fileName,
    fileSize: fileAttachment?.fileSize,
    fileType: fileAttachment?.fileType,
    fileUrl: fileAttachment?.fileUrl,
    audioUrl: fileAttachment?.audioUrl || (fileAttachment?.fileType?.startsWith('audio/') ? fileAttachment?.fileUrl : undefined),
    audioDuration: fileAttachment?.audioDuration,
    storagePath: fileAttachment?.storagePath,
    replyToId: replyTo?.id || null,
    replyToSenderName: replyTo?.senderName || null,
    replyToText: replyTo?.text || null,
    timestamp: now,
  };

  const key = `chat_${Math.min(user.id, targetPartner)}_${Math.max(user.id, targetPartner)}`;
  const list = memoryStore.privateMessages.get(key) || [];
  list.push(message);
  memoryStore.privateMessages.set(key, list);

  res.json({ success: true, message });
});

// ==========================================
// 5. FILE & AUDIO UPLOADS (GCS / Safe Fallback)
// ==========================================
apiRouter.post('/files/upload', requireAuth, async (req, res) => {
  try {
    const rawFileName = req.body.fileName || req.body.filename;
    const rawFileData = req.body.fileData || req.body.data;
    const mimeType = req.body.mimeType || 'application/octet-stream';
    const folder = req.body.folder || 'chat_files';

    if (!rawFileName || !rawFileData) {
      return res.status(400).json({ error: 'الملف وبياناته مطلوبة' });
    }

    const fileName = String(rawFileName);
    const fileData = String(rawFileData);

    // Decode base64 data
    const base64Content = fileData.includes('base64,') ? fileData.split('base64,')[1] : fileData;
    const buffer = Buffer.from(base64Content, 'base64');

    // Limit check: 25MB max
    if (buffer.length > 26214400) {
      return res.status(400).json({ error: 'حجم الملف يتجاوز الحد الأقصى المسموح (25 ميغابايت)' });
    }

    const targetFolder = ['chat_images', 'chat_files', 'chat_audio', 'avatars'].includes(folder)
      ? folder
      : 'chat_files';

    const saved = await saveFile(
      String(fileName),
      buffer,
      String(mimeType || 'application/octet-stream'),
      req.user!.id,
      targetFolder
    );

    res.json({
      success: true,
      fileUrl: saved.fileUrl,
      fileName: saved.fileName,
      fileSize: saved.fileSize,
      fileType: saved.fileType,
      storagePath: saved.storagePath,
    });
  } catch (err) {
    console.error('[Upload Error]', err);
    res.status(500).json({ error: 'فشل في رفع الملف' });
  }
});

apiRouter.get('/files/:id', (req, res) => {
  const result = getFile(req.params.id);
  if (!result) {
    return res.status(404).send('الملف غير موجود');
  }

  res.setHeader('Content-Type', result.file.fileType || 'application/octet-stream');
  res.setHeader('Content-Length', result.buffer.length);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(result.buffer);
});

// ==========================================
// 6. TRADING CHALLENGE (150 Milestones)
// ==========================================
apiRouter.get('/challenge', requireAuth, (req, res) => {
  const user = req.user!;
  let challenge = memoryStore.challenges.get(user.id);
  if (!challenge) {
    challenge = {
      id: `challenge_${user.id}`,
      userId: user.id,
      userName: user.displayName,
      initialCapitalCents: 10000,
      currentBalanceCents: 10000,
      targetBalanceCents: 300000,
      tradeCount: 0,
      challengeStarted: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    memoryStore.challenges.set(user.id, challenge);
  }
  res.json({ success: true, challenge });
});

apiRouter.post('/challenge', requireAuth, (req, res) => {
  const user = req.user!;
  const { initialCapitalCents, targetBalanceCents, challengeStarted } = req.body;

  let challenge = memoryStore.challenges.get(user.id) || {
    id: `challenge_${user.id}`,
    userId: user.id,
    userName: user.displayName,
    initialCapitalCents: 10000,
    currentBalanceCents: 10000,
    targetBalanceCents: 300000,
    tradeCount: 0,
    challengeStarted: false,
    createdAt: Date.now(),
  };

  if (initialCapitalCents) {
    challenge.initialCapitalCents = Number(initialCapitalCents);
    challenge.currentBalanceCents = Number(initialCapitalCents);
  }
  if (targetBalanceCents) challenge.targetBalanceCents = Number(targetBalanceCents);
  if (challengeStarted !== undefined) challenge.challengeStarted = !!challengeStarted;
  challenge.updatedAt = Date.now();

  memoryStore.challenges.set(user.id, challenge);
  res.json({ success: true, challenge });
});

apiRouter.get('/challenge/trades', requireAuth, (req, res) => {
  const user = req.user!;
  const trades = memoryStore.trades.get(String(user.id)) || [];
  res.json({ success: true, trades });
});

apiRouter.post('/challenge/trades', requireAuth, (req, res) => {
  const user = req.user!;
  const { resultCents, attachmentPath } = req.body;

  if (typeof resultCents !== 'number') {
    return res.status(400).json({ error: 'قيمة الصفقة غير صحيحة' });
  }

  let challenge = memoryStore.challenges.get(user.id);
  if (!challenge) return res.status(404).json({ error: 'لم يتم العثور على الرحلة' });

  const oldBalance = challenge.currentBalanceCents;
  const newBalance = oldBalance + resultCents;
  const tradeCount = challenge.tradeCount + 1;

  challenge.currentBalanceCents = newBalance;
  challenge.tradeCount = tradeCount;
  challenge.updatedAt = Date.now();

  const trade = {
    id: `trade_${Date.now()}_${tradeCount}`,
    challengeId: challenge.id,
    tradeNumber: tradeCount,
    resultCents,
    oldBalanceCents: oldBalance,
    newBalanceCents: newBalance,
    type: resultCents >= 0 ? 'WIN' : 'LOSS',
    attachmentPath: attachmentPath || null,
    timestamp: Date.now(),
  };

  const list = memoryStore.trades.get(String(user.id)) || [];
  list.push(trade);
  memoryStore.trades.set(String(user.id), list);
  memoryStore.challenges.set(user.id, challenge);

  res.json({ success: true, trade, challenge });
});

// ==========================================
// 7. SUBSCRIPTION PACKAGES & PLANS
// ==========================================
apiRouter.get('/packages', (req, res) => {
  const packages = [
    {
      id: 'sami_vip',
      name: '👑 باقة Sami VIP الخاصة',
      price: '$50 / شهر',
      description: 'دخول كامل للقناة الخاصة وتوصيات الصفقات اللحظية مع تحليلات القائد Sami.',
      features: ['توصيات يومية مباشرة', 'إدارة المحفظة وحساب المخاطر', 'دعم خاص مع المشرفين'],
    },
    {
      id: 'sami_pro',
      name: '🚀 باقة المتداول المحترف',
      price: '$30 / شهر',
      description: 'دخول لقنوات التداول والنقاشات الفنية والتقارير الأسبوعية.',
      features: ['نقاشات الصفقات', 'تقارير فنية أسبوعية', 'متابعة الأهداف'],
    },
  ];
  res.json({ success: true, packages });
});
