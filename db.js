/**
 * DENTSHUB RISET - HIGH-PERFORMANCE CONSOLIDATED DATABASE LAYER
 * Architecture: Consolidated Domain Mappings (DENTSHUB_DB:*)
 * 
 * Clean Upstash Data Browser:
 * - DENTSHUB_DB:USERS
 * - DENTSHUB_DB:SESSIONS
 * - DENTSHUB_DB:PROJECTS
 * - DENTSHUB_DB:CHAPTERS
 * - DENTSHUB_DB:ARTICLES
 * - DENTSHUB_DB:PAYMENTS
 * - DENTSHUB_DB:CREDIT_LEDGER
 * - DENTSHUB_DB:AI_USAGE
 * - DENTSHUB_DB:AUDIT_LOGS
 * - DENTSHUB_DB:SETTINGS
 */

const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

// Initialize Redis Client if env is present
let redisClient = null;
const isProd = process.env.NODE_ENV === 'production';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('[REDIS DAL] Client Upstash Redis REST aktif dengan Consolidated Mappings (DENTSHUB_DB:*).');
  } catch (err) {
    console.error('[REDIS DAL ERROR] Gagal menginisialisasi Redis client:', err.message);
  }
} else {
  console.warn('[REDIS DAL WARNING] UPSTASH_REDIS_REST_URL belum diisi. Mengaktifkan Dev In-Memory Storage.');
}

// In-Memory Fallback & Fast Cache Store
const memStore = {
  USERS: {},
  SESSIONS: {},
  PROJECTS: {},
  CHAPTERS: {},
  ARTICLES: {},
  PAYMENTS: {},
  CREDIT_LEDGER: {},
  AI_USAGE: [],
  AUDIT_LOGS: [],
  ASSISTANT_SESSIONS: {},
  SETTINGS: {
    custom_prompts: null,
    ai_config: null,
    company_profile: null,
    vouchers_claimed: {},
  },
};

// Rate limiter memory map (sliding window, 0ms latency, does not clutter Redis Data Browser)
const rateLimitStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitStore.entries()) {
    if (record.resetAt <= now) {
      rateLimitStore.delete(key);
    }
  }
}, 60000).unref();

function safeParse(data, defaultValue) {
  if (data === null || data === undefined) return defaultValue;
  if (typeof data === 'object') return data;
  try {
    return JSON.parse(data);
  } catch (e) {
    return defaultValue;
  }
}

function hashString(str) {
  return crypto.createHash('sha256').update(str || '').digest('hex').substring(0, 16);
}

// Helper to get raw domain object from Redis or fallback
async function readDomain(key, defaultValue) {
  const shortKey = key.replace('DENTSHUB_DB:', '');
  if (!redisClient) {
    return memStore[shortKey] !== undefined ? memStore[shortKey] : defaultValue;
  }
  try {
    const raw = await redisClient.get(key);
    if (raw === null || raw === undefined) {
      return defaultValue;
    }
    return safeParse(raw, defaultValue);
  } catch (err) {
    console.error(`[REDIS READ ERROR ${key}]`, err.message);
    return memStore[shortKey] !== undefined ? memStore[shortKey] : defaultValue;
  }
}

// Helper to write domain object to Redis and update memory fallback
async function writeDomain(key, value) {
  const shortKey = key.replace('DENTSHUB_DB:', '');
  memStore[shortKey] = value;
  if (!redisClient) return true;
  try {
    await redisClient.set(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.error(`[REDIS WRITE ERROR ${key}]`, err.message);
    return false;
  }
}

// ==========================================
// 1. USERS DOMAIN (DENTSHUB_DB:USERS)
// ==========================================
const users = {
  async get(userId) {
    if (!userId) return null;
    const all = await readDomain('DENTSHUB_DB:USERS', {});
    if (all[userId]) return all[userId];

    // Lazy migration fallback for legacy keys
    if (redisClient) {
      try {
        const legacy = await redisClient.get(`user:${userId}`);
        if (legacy) {
          const userObj = safeParse(legacy, null);
          if (userObj) {
            all[userId] = userObj;
            await writeDomain('DENTSHUB_DB:USERS', all);
            return userObj;
          }
        }
      } catch (e) {}
    }
    return null;
  },

  async getByEmail(email) {
    if (!email) return null;
    const cleanEmail = email.trim().toLowerCase();
    const all = await readDomain('DENTSHUB_DB:USERS', {});
    
    for (const u of Object.values(all)) {
      if (u.email && u.email.trim().toLowerCase() === cleanEmail) {
        return u;
      }
    }

    // Lazy migration check for legacy email pointer
    if (redisClient) {
      try {
        const legacyUid = await redisClient.get(`email:${cleanEmail}`);
        if (legacyUid) {
          return await this.get(legacyUid);
        }
      } catch (e) {}
    }
    return null;
  },

  async set(userId, userData) {
    if (!userId || !userData) return;
    const all = await readDomain('DENTSHUB_DB:USERS', {});
    all[userId] = {
      ...userData,
      id: userId,
      credit_balance: userData.credit_balance !== undefined ? Number(userData.credit_balance) : 0,
      updated_at: new Date().toISOString(),
    };
    await writeDomain('DENTSHUB_DB:USERS', all);
    return all[userId];
  },

  async update(userId, partialData) {
    if (!userId) return null;
    const all = await readDomain('DENTSHUB_DB:USERS', {});
    const existing = all[userId];
    if (!existing) return null;

    all[userId] = {
      ...existing,
      ...partialData,
      updated_at: new Date().toISOString(),
    };
    await writeDomain('DENTSHUB_DB:USERS', all);
    return all[userId];
  },

  async delete(userId) {
    if (!userId) return false;
    const all = await readDomain('DENTSHUB_DB:USERS', {});
    if (all[userId]) {
      delete all[userId];
      await writeDomain('DENTSHUB_DB:USERS', all);
      return true;
    }
    return false;
  },

  async getAll() {
    const all = await readDomain('DENTSHUB_DB:USERS', {});
    return Object.values(all).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  },
};

// ==========================================
// 2. SESSIONS DOMAIN (DENTSHUB_DB:SESSIONS)
// ==========================================
const sessions = {
  async create(userId, req, res) {
    const sessionId = crypto.randomBytes(32).toString('hex');
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'unknown';
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_SECONDS * 1000;

    const sessionData = {
      id: sessionId,
      user_id: userId,
      created_at: now,
      expires_at: expiresAt,
      ip_hash: hashString(ip),
      user_agent_hash: hashString(userAgent),
    };

    const all = await readDomain('DENTSHUB_DB:SESSIONS', {});
    
    // Auto-prune expired sessions on every session creation to keep JSON minimal
    for (const [sid, s] of Object.entries(all)) {
      if (s.expires_at && s.expires_at <= now) {
        delete all[sid];
      }
    }

    all[sessionId] = sessionData;
    await writeDomain('DENTSHUB_DB:SESSIONS', all);

    if (res) {
      res.cookie('session_id', sessionId, {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax',
        maxAge: SESSION_TTL_SECONDS * 1000,
        path: '/',
      });
    }

    return sessionId;
  },

  async get(sessionId) {
    if (!sessionId) return null;
    const all = await readDomain('DENTSHUB_DB:SESSIONS', {});
    const s = all[sessionId];
    if (!s) return null;

    if (s.expires_at && s.expires_at <= Date.now()) {
      delete all[sessionId];
      await writeDomain('DENTSHUB_DB:SESSIONS', all);
      return null;
    }
    return s;
  },

  async destroy(sessionId, res) {
    if (sessionId) {
      const all = await readDomain('DENTSHUB_DB:SESSIONS', {});
      if (all[sessionId]) {
        delete all[sessionId];
        await writeDomain('DENTSHUB_DB:SESSIONS', all);
      }
    }

    if (res) {
      res.clearCookie('session_id', {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax',
        path: '/',
      });
      res.clearCookie('csrf_token', { path: '/' });
    }
  },

  async destroyAllForUser(userId) {
    if (!userId) return;
    const all = await readDomain('DENTSHUB_DB:SESSIONS', {});
    let modified = false;
    for (const [sid, s] of Object.entries(all)) {
      if (s.user_id === userId) {
        delete all[sid];
        modified = true;
      }
    }
    if (modified) {
      await writeDomain('DENTSHUB_DB:SESSIONS', all);
    }
  },
};

// ==========================================
// 3. CREDITS & LEDGER DOMAIN (DENTSHUB_DB:CREDIT_LEDGER)
// ==========================================
const UNLIMITED_ROLES = ['owner', 'admin', 'supervisor'];

const credits = {
  isUnlimitedRole(role) {
    return UNLIMITED_ROLES.includes(String(role || '').trim().toLowerCase());
  },

  async isUnlimited(userId) {
    if (!userId) return false;
    const u = await users.get(userId);
    return !!(u && this.isUnlimitedRole(u.role));
  },

  async getBalance(userId) {
    if (!userId) return 0;
    const u = await users.get(userId);
    if (!u) return 0;
    if (this.isUnlimitedRole(u.role)) {
      return 'UNLIMITED';
    }
    return Number(u.credit_balance || 0);
  },

  async grant(userId, amount, type, referenceType, referenceId, description = '') {
    const numAmount = Math.max(0, parseInt(amount, 10));
    if (numAmount <= 0) throw new Error('Jumlah kredit harus lebih dari nol.');

    const u = await users.get(userId);
    if (!u) throw new Error('Pengguna tidak ditemukan untuk penambahan kredit.');

    const isPrivileged = this.isUnlimitedRole(u.role);
    const newBalance = isPrivileged ? 'UNLIMITED' : (Number(u.credit_balance || 0) + numAmount);

    if (!isPrivileged) {
      await users.update(userId, { credit_balance: newBalance });
    }

    const ledgerEntry = {
      id: `led_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      user_id: userId,
      type,
      amount: numAmount,
      balance_after: newBalance,
      reference_type: referenceType,
      reference_id: referenceId,
      description: isPrivileged ? `${description} (Akses Unlimited)` : description,
      created_at: new Date().toISOString(),
    };

    const ledgerMap = await readDomain('DENTSHUB_DB:CREDIT_LEDGER', {});
    if (!Array.isArray(ledgerMap[userId])) {
      ledgerMap[userId] = [];
    }
    ledgerMap[userId].unshift(ledgerEntry);
    // Keep max 200 transactions per user
    if (ledgerMap[userId].length > 200) {
      ledgerMap[userId] = ledgerMap[userId].slice(0, 200);
    }
    await writeDomain('DENTSHUB_DB:CREDIT_LEDGER', ledgerMap);

    return { balance: newBalance, ledgerEntry };
  },

  async consume(userId, amount, referenceType, referenceId, description = '') {
    const numAmount = Math.max(0, parseInt(amount, 10));
    if (numAmount <= 0) throw new Error('Biaya kredit harus lebih dari nol.');

    const u = await users.get(userId);
    if (!u) return { success: false, error: 'USER_NOT_FOUND', balance: 0 };

    const isPrivileged = this.isUnlimitedRole(u.role);

    // Privileged accounts (owner, admin, supervisor) NEVER run out of credits!
    if (isPrivileged) {
      const ledgerEntry = {
        id: `led_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        user_id: userId,
        type: 'usage_unlimited',
        amount: 0,
        balance_after: 'UNLIMITED',
        reference_type: referenceType,
        reference_id: referenceId,
        description: `${description} [Akses Unlimited]`,
        created_at: new Date().toISOString(),
      };

      const ledgerMap = await readDomain('DENTSHUB_DB:CREDIT_LEDGER', {});
      if (!Array.isArray(ledgerMap[userId])) {
        ledgerMap[userId] = [];
      }
      ledgerMap[userId].unshift(ledgerEntry);
      if (ledgerMap[userId].length > 200) {
        ledgerMap[userId] = ledgerMap[userId].slice(0, 200);
      }
      await writeDomain('DENTSHUB_DB:CREDIT_LEDGER', ledgerMap);

      return { success: true, balance: 'UNLIMITED', ledgerEntry };
    }

    const currentBal = Number(u.credit_balance || 0);
    if (currentBal < numAmount) {
      return { success: false, error: 'CREDIT_INSUFFICIENT', balance: currentBal };
    }

    const newBalance = currentBal - numAmount;
    await users.update(userId, { credit_balance: newBalance });

    const ledgerEntry = {
      id: `led_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      user_id: userId,
      type: 'usage',
      amount: -numAmount,
      balance_after: newBalance,
      reference_type: referenceType,
      reference_id: referenceId,
      description,
      created_at: new Date().toISOString(),
    };

    const ledgerMap = await readDomain('DENTSHUB_DB:CREDIT_LEDGER', {});
    if (!Array.isArray(ledgerMap[userId])) {
      ledgerMap[userId] = [];
    }
    ledgerMap[userId].unshift(ledgerEntry);
    if (ledgerMap[userId].length > 200) {
      ledgerMap[userId] = ledgerMap[userId].slice(0, 200);
    }
    await writeDomain('DENTSHUB_DB:CREDIT_LEDGER', ledgerMap);

    return { success: true, balance: newBalance, ledgerEntry };
  },

  async getLedger(userId) {
    if (!userId) return [];
    const ledgerMap = await readDomain('DENTSHUB_DB:CREDIT_LEDGER', {});
    return Array.isArray(ledgerMap[userId]) ? ledgerMap[userId] : [];
  },
};

// ==========================================
// 4. PROJECTS DOMAIN (DENTSHUB_DB:PROJECTS)
// ==========================================
const projects = {
  async getUserProjects(userId) {
    if (!userId) return [];
    const all = await readDomain('DENTSHUB_DB:PROJECTS', {});
    return Object.values(all)
      .filter((p) => p.user_id === userId)
      .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  },

  async getById(projectId, userId = null) {
    if (!projectId) return null;
    const all = await readDomain('DENTSHUB_DB:PROJECTS', {});
    const project = all[projectId] || null;
    if (!project) return null;
    if (userId && project.user_id !== userId) return null;
    return project;
  },

  async save(project) {
    if (!project || !project.id) return;
    const all = await readDomain('DENTSHUB_DB:PROJECTS', {});
    all[project.id] = {
      ...project,
      updated_at: new Date().toISOString(),
    };
    await writeDomain('DENTSHUB_DB:PROJECTS', all);
    return all[project.id];
  },

  async delete(projectId, userId) {
    if (!projectId) return false;
    const all = await readDomain('DENTSHUB_DB:PROJECTS', {});
    const prj = all[projectId];
    if (!prj) return false;
    if (userId && prj.user_id !== userId) return false;

    delete all[projectId];
    await writeDomain('DENTSHUB_DB:PROJECTS', all);

    // Also delete all associated chapters
    await chapters.deleteByProjectId(projectId);
    return true;
  },

  async addFeedback(projectId, feedback) {
    const prj = await this.getById(projectId);
    if (!prj) return;
    if (!Array.isArray(prj.feedbacks)) prj.feedbacks = [];
    prj.feedbacks.unshift(feedback);
    await this.save(prj);
  },

  async getFeedbacks(projectId) {
    const prj = await this.getById(projectId);
    return (prj && prj.feedbacks) || [];
  },
};

// ==========================================
// 5. CHAPTERS DOMAIN (DENTSHUB_DB:CHAPTERS)
// ==========================================
const chapters = {
  async getByProjectId(projectId) {
    if (!projectId) return [];
    const all = await readDomain('DENTSHUB_DB:CHAPTERS', {});
    return Object.values(all)
      .filter((c) => c.project_id === projectId)
      .sort((a, b) => (a.position || 0) - (b.position || 0));
  },

  async getById(chapterId) {
    if (!chapterId) return null;
    const all = await readDomain('DENTSHUB_DB:CHAPTERS', {});
    return all[chapterId] || null;
  },

  async save(chapter) {
    if (!chapter || !chapter.id) return;
    const all = await readDomain('DENTSHUB_DB:CHAPTERS', {});
    all[chapter.id] = {
      ...chapter,
      updated_at: new Date().toISOString(),
    };
    await writeDomain('DENTSHUB_DB:CHAPTERS', all);
    return all[chapter.id];
  },

  async delete(chapterId) {
    if (!chapterId) return false;
    const all = await readDomain('DENTSHUB_DB:CHAPTERS', {});
    if (all[chapterId]) {
      delete all[chapterId];
      await writeDomain('DENTSHUB_DB:CHAPTERS', all);
      return true;
    }
    return false;
  },

  async deleteByProjectId(projectId) {
    if (!projectId) return;
    const all = await readDomain('DENTSHUB_DB:CHAPTERS', {});
    let modified = false;
    for (const [cid, c] of Object.entries(all)) {
      if (c.project_id === projectId) {
        delete all[cid];
        modified = true;
      }
    }
    if (modified) {
      await writeDomain('DENTSHUB_DB:CHAPTERS', all);
    }
  },
};

// ==========================================
// 6. ARTICLES DOMAIN (DENTSHUB_DB:ARTICLES)
// ==========================================
const articles = {
  async getUserArticles(userId) {
    if (!userId) return [];
    const all = await readDomain('DENTSHUB_DB:ARTICLES', {});
    return Object.values(all)
      .filter((a) => a.user_id === userId)
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  },

  async getById(articleId) {
    if (!articleId) return null;
    const all = await readDomain('DENTSHUB_DB:ARTICLES', {});
    return all[articleId] || null;
  },

  async save(article) {
    if (!article || !article.id) return;
    const all = await readDomain('DENTSHUB_DB:ARTICLES', {});
    all[article.id] = {
      ...article,
      created_at: article.created_at || new Date().toISOString(),
    };
    await writeDomain('DENTSHUB_DB:ARTICLES', all);
    return all[article.id];
  },
};

// ==========================================
// 7. PAYMENTS DOMAIN (DENTSHUB_DB:PAYMENTS)
// ==========================================
const payments = {
  async getUserPayments(userId) {
    if (!userId) return [];
    const all = await readDomain('DENTSHUB_DB:PAYMENTS', {});
    return Object.values(all)
      .filter((p) => p.user_id === userId)
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  },

  async getById(paymentId) {
    if (!paymentId) return null;
    const all = await readDomain('DENTSHUB_DB:PAYMENTS', {});
    return all[paymentId] || null;
  },

  async getByExternalId(externalId) {
    if (!externalId) return null;
    const all = await readDomain('DENTSHUB_DB:PAYMENTS', {});
    return Object.values(all).find((p) => p.external_id === externalId) || null;
  },

  async save(payment) {
    if (!payment || !payment.id) return;
    const all = await readDomain('DENTSHUB_DB:PAYMENTS', {});
    all[payment.id] = {
      ...payment,
      updated_at: new Date().toISOString(),
    };
    await writeDomain('DENTSHUB_DB:PAYMENTS', all);
    return all[payment.id];
  },
};

// ==========================================
// 8. AI USAGE DOMAIN (DENTSHUB_DB:AI_USAGE)
// ==========================================
const aiUsage = {
  async record(userId, projectId, feature, model, inputTokens, outputTokens, creditCost, status) {
    const record = {
      id: `aiu_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      user_id: userId,
      project_id: projectId || null,
      feature,
      model,
      input_tokens: inputTokens || 0,
      output_tokens: outputTokens || 0,
      credit_cost: creditCost,
      status,
      created_at: new Date().toISOString(),
    };

    const list = await readDomain('DENTSHUB_DB:AI_USAGE', []);
    const updated = Array.isArray(list) ? list : [];
    updated.unshift(record);
    // Keep max 1000 records to prevent memory bloat
    if (updated.length > 1000) {
      updated.length = 1000;
    }
    await writeDomain('DENTSHUB_DB:AI_USAGE', updated);
    return record;
  },

  async getUserUsage(userId, limit = 50) {
    const list = await readDomain('DENTSHUB_DB:AI_USAGE', []);
    if (!Array.isArray(list)) return [];
    return list.filter((r) => r.user_id === userId).slice(0, limit);
  },
};

// ==========================================
// 9. AUDIT LOGS DOMAIN (DENTSHUB_DB:AUDIT_LOGS)
// ==========================================
const audits = {
  async write(actorId, action, targetType, targetId, metadata = {}) {
    const safeMeta = { ...metadata };
    delete safeMeta.password;
    delete safeMeta.password_hash;
    delete safeMeta.token;
    delete safeMeta.secret;
    delete safeMeta._csrf;

    const logEntry = {
      id: `aud_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      actor_id: actorId || 'system',
      action,
      target_type: targetType,
      target_id: targetId,
      metadata: safeMeta,
      created_at: new Date().toISOString(),
    };

    try {
      const list = await readDomain('DENTSHUB_DB:AUDIT_LOGS', []);
      const updated = Array.isArray(list) ? list : [];
      updated.unshift(logEntry);
      if (updated.length > 1000) {
        updated.length = 1000;
      }
      await writeDomain('DENTSHUB_DB:AUDIT_LOGS', updated);
    } catch (err) {
      console.error('[AUDIT WRITE ERROR]', err.message);
    }
    return logEntry;
  },

  async getAll(limit = 50) {
    const list = await readDomain('DENTSHUB_DB:AUDIT_LOGS', []);
    if (!Array.isArray(list)) return [];
    return list.slice(0, limit);
  },
};

// ==========================================
// 10. SYSTEM SETTINGS DOMAIN (DENTSHUB_DB:SETTINGS)
// ==========================================
const settings = {
  async getAllSettings() {
    return await readDomain('DENTSHUB_DB:SETTINGS', {
      custom_prompts: null,
      ai_config: null,
      company_profile: null,
      vouchers_claimed: {},
    });
  },

  async getCustomPrompts() {
    const s = await this.getAllSettings();
    return s.custom_prompts || null;
  },

  async saveCustomPrompts(prompts) {
    const s = await this.getAllSettings();
    s.custom_prompts = prompts;
    await writeDomain('DENTSHUB_DB:SETTINGS', s);
    return prompts;
  },

  async getAiConfig() {
    const s = await this.getAllSettings();
    return s.ai_config || null;
  },

  async saveAiConfig(config) {
    const s = await this.getAllSettings();
    s.ai_config = config;
    await writeDomain('DENTSHUB_DB:SETTINGS', s);
    return config;
  },

  async getCompanyProfile() {
    const s = await this.getAllSettings();
    return s.company_profile || null;
  },

  async saveCompanyProfile(profile) {
    const s = await this.getAllSettings();
    s.company_profile = profile;
    await writeDomain('DENTSHUB_DB:SETTINGS', s);
    return profile;
  },

  async isVoucherClaimed(voucherCode, userId) {
    const s = await this.getAllSettings();
    if (!s.vouchers_claimed) return false;
    return !!s.vouchers_claimed[`${voucherCode}:${userId}`];
  },

  async claimVoucher(voucherCode, userId) {
    const s = await this.getAllSettings();
    if (!s.vouchers_claimed) s.vouchers_claimed = {};
    s.vouchers_claimed[`${voucherCode}:${userId}`] = new Date().toISOString();
    await writeDomain('DENTSHUB_DB:SETTINGS', s);
  },
};

// ==========================================
// ZERO-LATENCY IN-MEMORY RATE LIMITER
// ==========================================
function checkRateLimit(key, maxAttempts, windowSeconds) {
  const now = Date.now();
  let record = rateLimitStore.get(key);

  if (!record || record.resetAt <= now) {
    record = {
      count: 1,
      resetAt: now + windowSeconds * 1000,
    };
    rateLimitStore.set(key, record);
    return {
      allowed: true,
      remaining: maxAttempts - 1,
      retryAfterSeconds: windowSeconds,
    };
  }

  record.count += 1;
  const remaining = Math.max(0, maxAttempts - record.count);
  const retryAfterSeconds = Math.ceil((record.resetAt - now) / 1000);

  if (record.count > maxAttempts) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds,
    };
  }

  return {
    allowed: true,
    remaining,
    retryAfterSeconds,
  };
}

function resetRateLimit(key) {
  if (key) {
    rateLimitStore.delete(key);
  }
}

// ==========================================
// ASSISTANT CHAT SESSIONS (DENTSHUB_DB:ASSISTANT_SESSIONS)
// ==========================================
const assistant = {
  async getSessions(userId) {
    const map = await readDomain('DENTSHUB_DB:ASSISTANT_SESSIONS', {});
    const list = Object.values(map).filter((s) => s && s.user_id === userId);
    return list.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  },

  async getSession(sessionId, userId) {
    const map = await readDomain('DENTSHUB_DB:ASSISTANT_SESSIONS', {});
    const s = map[sessionId];
    if (s && s.user_id === userId) return s;
    return null;
  },

  async saveSession(sessionData) {
    const map = await readDomain('DENTSHUB_DB:ASSISTANT_SESSIONS', {});
    const now = new Date().toISOString();
    const updated = {
      ...sessionData,
      updated_at: now,
      created_at: sessionData.created_at || now,
    };
    map[sessionData.id] = updated;
    await writeDomain('DENTSHUB_DB:ASSISTANT_SESSIONS', map);
    return updated;
  },

  async deleteSession(sessionId, userId) {
    const map = await readDomain('DENTSHUB_DB:ASSISTANT_SESSIONS', {});
    if (map[sessionId] && map[sessionId].user_id === userId) {
      delete map[sessionId];
      await writeDomain('DENTSHUB_DB:ASSISTANT_SESSIONS', map);
      return true;
    }
    return false;
  }
};

// ==========================================
// AUTOMATIC DEFAULT ACCOUNTS SEEDER
// ==========================================
function hashPasswordAsync(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

const DEFAULT_ACCOUNTS = [
  {
    id: 'usr_owner_official_01',
    email: 'owner@dentshub.id',
    plainPassword: 'OwnerRiset2026!',
    name: 'Owner Dentshub',
    role: 'owner',
    credit_balance: 'UNLIMITED',
    institution: 'DENTSHUB Riset Headquarter',
    field: 'System Architecture & Health Sciences',
  },
  {
    id: 'usr_admin_official_02',
    email: 'admin@dentshub.id',
    plainPassword: 'AdminRiset2026!',
    name: 'Admin Riset Dentshub',
    role: 'admin',
    credit_balance: 'UNLIMITED',
    institution: 'DENTSHUB Riset Headquarter',
    field: 'Administration & Moderation',
  },
  {
    id: 'usr_supervisor_official_03',
    email: 'supervisor@dentshub.id',
    plainPassword: 'SupervisorRiset2026!',
    name: 'Supervisor Riset',
    role: 'supervisor',
    credit_balance: 'UNLIMITED',
    institution: 'Universitas Indonesia (Fakultas Kedokteran Gigi)',
    field: 'Kedokteran Gigi Klinis & Akademik',
  },
  {
    id: 'usr_demo_official_04',
    email: 'user@dentshub.id',
    plainPassword: 'UserRiset2026!',
    name: 'Peneliti Demo',
    role: 'user',
    credit_balance: 100,
    institution: 'Universitas Airlangga',
    field: 'Pendidikan Dokter Gigi',
  },
];

async function ensureDefaultAccounts() {
  try {
    const usersMap = await readDomain('DENTSHUB_DB:USERS', {});
    let hasChanges = false;

    for (const acc of DEFAULT_ACCOUNTS) {
      let existing = Object.values(usersMap).find(
        (u) => (u.email || '').toLowerCase() === acc.email.toLowerCase()
      );

      const targetId = existing ? existing.id : acc.id;
      const passHash = await hashPasswordAsync(acc.plainPassword);

      usersMap[targetId] = {
        id: targetId,
        name: acc.name,
        email: acc.email,
        password_hash: passHash,
        role: acc.role,
        status: 'active',
        credit_balance: acc.credit_balance,
        institution: acc.institution,
        field: acc.field,
        is_verified: true,
        created_at: existing ? existing.created_at : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      hasChanges = true;
    }

    if (hasChanges) {
      await writeDomain('DENTSHUB_DB:USERS', usersMap);
      console.log('✅ [DB SEEDER] 4 Default Accounts ensured in Redis (OWNER, ADMIN, SUPERVISOR, USER DEMO).');
    }
  } catch (err) {
    console.error('❌ [DB SEEDER ERROR] Failed to seed default accounts:', err.message);
  }
}

// Self-execute seeder immediately on module load
ensureDefaultAccounts().catch((e) => console.error('[DB SEED INIT ERROR]', e));

// Diagnostics check
async function ping() {
  if (redisClient) {
    return await redisClient.ping();
  }
  return 'PONG';
}

module.exports = {
  redisClient,
  users,
  sessions,
  credits,
  projects,
  chapters,
  articles,
  payments,
  aiUsage,
  audits,
  settings,
  assistant,
  checkRateLimit,
  resetRateLimit,
  ensureDefaultAccounts,
  UNLIMITED_ROLES,
  ping,
};
