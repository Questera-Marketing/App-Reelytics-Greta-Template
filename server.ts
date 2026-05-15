import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { Composio, SessionPreset } from '@composio/core';
import { query } from '@anthropic-ai/claude-agent-sdk';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_KEY;
const COMPOSIO_KEY = process.env.COMPOSIO_API_KEY ?? process.env.COMPOSIO_MCP_KEY;
const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
let INSTAGRAM_AUTH_CONFIG_ID = process.env.COMPOSIO_INSTAGRAM_AUTH_CONFIG_ID;

if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing Supabase configuration in .env');
if (!COMPOSIO_KEY) console.warn('No COMPOSIO_API_KEY in .env — each user must set their own key in Settings.');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

class ComposioKeyMissing extends Error {
  constructor() { super('Composio API key not configured. Open Settings (⚙) to add one.'); this.name = 'ComposioKeyMissing'; }
}

// Per-user Composio client when the user has overridden the API key in settings
const composioCache = new Map<string, Composio>();
function composioFor(user: any): Composio {
  const userKey = user?.settings?.composioApiKey?.trim() || COMPOSIO_KEY;
  if (!userKey) throw new ComposioKeyMissing();
  let c = composioCache.get(userKey);
  if (!c) {
    c = new Composio({ apiKey: userKey });
    composioCache.set(userKey, c);
  }
  return c;
}

const authConfigCache = new Map<string, string>();
async function getInstagramAuthConfigIdFor(user: any) {
  const userKey = user?.settings?.composioApiKey?.trim() || COMPOSIO_KEY!;
  const cached = authConfigCache.get(userKey);
  if (cached) return cached;
  if (userKey === COMPOSIO_KEY && INSTAGRAM_AUTH_CONFIG_ID) {
    authConfigCache.set(userKey, INSTAGRAM_AUTH_CONFIG_ID);
    return INSTAGRAM_AUTH_CONFIG_ID;
  }
  const c = composioFor(user);
  const list = await c.authConfigs.list({ toolkit: 'instagram' });
  let id: string;
  if (list.items.length > 0) {
    id = list.items[0].id;
  } else {
    const created = await c.authConfigs.create('instagram', {
      type: 'use_composio_managed_auth',
      name: 'Instagram Auth Config',
      isEnabledForToolRouter: true
    });
    id = created.id;
  }
  authConfigCache.set(userKey, id);
  if (userKey === COMPOSIO_KEY) INSTAGRAM_AUTH_CONFIG_ID = id;
  return id;
}

function maskKey(key?: string): string {
  if (!key) return '';
  if (key.length <= 10) return '•'.repeat(key.length);
  return key.slice(0, 4) + '•'.repeat(key.length - 8) + key.slice(-4);
}

// ============== Email + OTP ==============
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM ?? 'Reelytics <onboarding@resend.dev>';
const OTP_TTL_MINUTES = 10;

function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendEmail(to: string, subject: string, text: string): Promise<{ ok: boolean; devMode: boolean }> {
  if (!RESEND_API_KEY) {
    console.log('\n========== [DEV-MODE EMAIL] ==========');
    console.log(`To:      ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body:\n${text}`);
    console.log('======================================\n');
    return { ok: true, devMode: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to, subject, text })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend send failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return { ok: true, devMode: false };
}

async function sendVerificationEmail(email: string, code: string) {
  return sendEmail(
    email,
    `Reelytics verification code: ${code}`,
    `Your Reelytics verification code is:\n\n${code}\n\nThis code expires in ${OTP_TTL_MINUTES} minutes.\n\nIf you didn't request this, you can safely ignore this email.`
  );
}

async function sendInviteEmail(email: string, inviter: string, accountLabel: string, role: string) {
  return sendEmail(
    email,
    `You've been added to ${accountLabel} on Reelytics`,
    `${inviter} added you as a "${role}" on the ${accountLabel} Reelytics dashboard.\n\nVisit ${PUBLIC_URL} and sign in with this email (${email}). After you verify the OTP we send, you'll see the dashboard automatically.\n\nIf you don't recognize this invite, you can safely ignore it.`
  );
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THUMBS_DIR = path.join(__dirname, 'thumbs');
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/thumbs', express.static(THUMBS_DIR, { fallthrough: true, maxAge: '7d' }));

// Self-healing thumbnail fallback: if the local file is missing, look up the reel's
// original thumbnailUrl from any saved report and re-fetch it once. This handles
// Railway's ephemeral filesystem (every redeploy wipes ./thumbs/) and Instagram CDN
// URL expiry. Concurrent requests for the same id are de-duped.
const inflightThumbFetches = new Map<string, Promise<boolean>>();
app.get('/thumbs/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!/^[a-zA-Z0-9_\-]+\.jpg$/i.test(filename)) return res.status(404).end();
  const idKey = filename.replace(/\.jpg$/i, '');
  const filepath = path.join(THUMBS_DIR, `${idKey}.jpg`);

  let pending = inflightThumbFetches.get(idKey);
  if (!pending) {
    pending = (async () => {
      const { data: recent } = await supabase
        .from('reports')
        .select('data')
        .order('created_at', { ascending: false })
        .limit(30);
      let url: string | null = null;
      for (const r of (recent ?? [])) {
        const reels = (r.data as any)?.reels ?? [];
        const hit = reels.find((x: any) => sanitize(x.id) === idKey || x.id === idKey);
        if (hit?.thumbnailUrl) { url = hit.thumbnailUrl; break; }
      }
      if (!url) return false;
      const result = await downloadOne(idKey, url);
      return result.ok;
    })();
    inflightThumbFetches.set(idKey, pending);
    pending.finally(() => inflightThumbFetches.delete(idKey));
  }
  const ok = await pending;
  if (ok) return res.sendFile(filepath);
  return res.status(404).end();
});

// SPA routes — serve index.html for both / and /app
app.get(['/app', '/dashboard'], (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ============== Auth ==============
app.post('/api/auth', async (req, res) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const name = String(req.body?.name ?? '').trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });

    const { data: existing, error: lookupErr } = await supabase.from('users').select('*').eq('email', email).limit(1);
    if (lookupErr) throw lookupErr;

    let user = existing?.[0];
    if (!user) {
      const userId = randomUUID();
      const { data: created, error: insertErr } = await supabase.from('users').insert([{
        id: userId,
        email,
        name: name || email.split('@')[0],
        composio_user_id: `user:${userId}`,
        email_verified: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }]).select('*').single();
      if (insertErr) throw insertErr;
      user = created;
    }

    // If user is already verified AND has logged in here before (grandfathered or returning),
    // skip OTP and return them directly.
    if (user.email_verified) {
      return res.json({ user, verified: true });
    }

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString();
    await supabase.from('users').update({
      verification_code: code,
      verification_code_expires_at: expiresAt,
      updated_at: new Date().toISOString()
    }).eq('id', user.id);

    const send = await sendVerificationEmail(email, code);
    return res.json({
      verified: false,
      requiresVerification: true,
      userId: user.id,
      email: user.email,
      ...(send.devMode ? { devCode: code, devMode: true } : {})
    });
  } catch (err) {
    console.error('auth failed', err);
    return res.status(500).json({ error: String(err) });
  }
});

app.post('/api/auth/verify', async (req, res) => {
  try {
    const userId = String(req.body?.userId ?? '');
    const code = String(req.body?.code ?? '').trim();
    if (!userId || !code) return res.status(400).json({ error: 'userId and code required' });

    const { data: user, error } = await supabase.from('users').select('*').eq('id', userId).single();
    if (error || !user) return res.status(404).json({ error: 'user not found' });

    if (user.email_verified) return res.json({ user, verified: true });

    if (!user.verification_code || user.verification_code !== code) {
      return res.status(400).json({ error: 'Invalid code' });
    }
    if (user.verification_code_expires_at && new Date(user.verification_code_expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Code expired — request a new one' });
    }

    const { data: updated, error: updateErr } = await supabase.from('users').update({
      email_verified: true,
      verification_code: null,
      verification_code_expires_at: null,
      updated_at: new Date().toISOString()
    }).eq('id', userId).select('*').single();
    if (updateErr) throw updateErr;

    return res.json({ user: updated, verified: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

app.post('/api/auth/resend', async (req, res) => {
  try {
    const userId = String(req.body?.userId ?? '');
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const { data: user, error } = await supabase.from('users').select('*').eq('id', userId).single();
    if (error || !user) return res.status(404).json({ error: 'user not found' });
    if (user.email_verified) return res.json({ verified: true });

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString();
    await supabase.from('users').update({
      verification_code: code,
      verification_code_expires_at: expiresAt,
      updated_at: new Date().toISOString()
    }).eq('id', userId);
    const send = await sendVerificationEmail(user.email, code);
    return res.json({ ok: true, ...(send.devMode ? { devCode: code, devMode: true } : {}) });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

app.get('/api/me', async (req, res) => {
  const userId = String(req.query.userId ?? '');
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const { data: user, error } = await supabase.from('users').select('*').eq('id', userId).single();
  if (error || !user) return res.status(404).json({ error: error?.message ?? 'user not found' });

  // Auto-accept any pending memberships for this user's email
  await supabase.from('memberships').update({
    status: 'active',
    accepted_user_id: userId,
    accepted_at: new Date().toISOString()
  }).eq('invited_email', user.email).eq('status', 'pending');

  // Strip secrets before sending to client
  const safeUser = { ...user, settings: undefined, verification_code: undefined, verification_code_expires_at: undefined };

  const { data: owned } = await supabase.from('connected_accounts').select('*').eq('user_id', userId).order('created_at', { ascending: false });
  const ownedWithRole = (owned ?? []).map((a: any) => ({ ...a, role: 'owner', viaMembership: false }));

  // Shared accounts via memberships — fetch in two queries because PostgREST's
  // auto-join doesn't reliably resolve FKs targeting unique-text columns.
  const { data: memberRows } = await supabase
    .from('memberships')
    .select('role, connected_account_id')
    .eq('invited_email', user.email)
    .eq('status', 'active');
  let sharedWithRole: any[] = [];
  if (memberRows && memberRows.length) {
    const ids = memberRows.map((m: any) => m.connected_account_id);
    const { data: sharedAccounts } = await supabase
      .from('connected_accounts')
      .select('*')
      .in('connected_account_id', ids);
    const roleByAccount = new Map(memberRows.map((m: any) => [m.connected_account_id, m.role]));
    sharedWithRole = (sharedAccounts ?? []).map((a: any) => ({
      ...a,
      role: roleByAccount.get(a.connected_account_id) ?? 'viewer',
      viaMembership: true
    }));
  }

  // Dedupe in case the user is both owner and (somehow) member
  const seen = new Set<string>();
  const accounts: any[] = [];
  for (const a of [...ownedWithRole, ...sharedWithRole]) {
    if (!a?.connected_account_id || seen.has(a.connected_account_id)) continue;
    seen.add(a.connected_account_id);
    accounts.push(a);
  }

  return res.json({ user: safeUser, accounts });
});

// ============== Team / memberships ==============
async function getRoleForAccount(userId: string, connectedAccountId: string): Promise<'owner' | 'admin' | 'viewer' | null> {
  const { data: user } = await supabase.from('users').select('email').eq('id', userId).single();
  if (!user) return null;
  const { data: owned } = await supabase.from('connected_accounts')
    .select('user_id').eq('connected_account_id', connectedAccountId).single();
  if (owned?.user_id === userId) return 'owner';
  const { data: m } = await supabase.from('memberships')
    .select('role')
    .eq('connected_account_id', connectedAccountId)
    .eq('invited_email', user.email)
    .eq('status', 'active')
    .single();
  return (m?.role as any) ?? null;
}

app.get('/api/team', async (req, res) => {
  try {
    const userId = String(req.query.userId ?? '');
    const connectedAccountId = String(req.query.connectedAccountId ?? '');
    if (!userId || !connectedAccountId) return res.status(400).json({ error: 'userId and connectedAccountId required' });

    const role = await getRoleForAccount(userId, connectedAccountId);
    if (!role) return res.status(403).json({ error: 'No access to this account' });

    const { data: account } = await supabase.from('connected_accounts')
      .select('*, owner:user_id(id, email, name)')
      .eq('connected_account_id', connectedAccountId).single();
    const { data: members } = await supabase.from('memberships')
      .select('*')
      .eq('connected_account_id', connectedAccountId)
      .order('created_at', { ascending: true });

    return res.json({
      role,
      owner: account?.owner,
      members: members ?? []
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

app.post('/api/team/invite', async (req, res) => {
  try {
    const userId = String(req.body?.userId ?? '');
    const connectedAccountId = String(req.body?.connectedAccountId ?? '');
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const role = String(req.body?.role ?? 'viewer');
    if (!userId || !connectedAccountId || !email) return res.status(400).json({ error: 'userId, connectedAccountId, email required' });
    if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'role must be admin or viewer' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });

    const myRole = await getRoleForAccount(userId, connectedAccountId);
    if (myRole !== 'owner' && myRole !== 'admin') return res.status(403).json({ error: 'Only owners and admins can invite' });

    const { data: account } = await supabase.from('connected_accounts').select('*').eq('connected_account_id', connectedAccountId).single();
    if (!account) return res.status(404).json({ error: 'account not found' });

    // If invitee email = owner email, reject
    const { data: owner } = await supabase.from('users').select('email').eq('id', account.user_id).single();
    if (owner?.email === email) return res.status(400).json({ error: 'That email already owns this account' });

    // Check if invitee already has an active account (so they can immediately use it)
    const { data: invitee } = await supabase.from('users').select('id, email_verified').eq('email', email).single();
    const status = invitee?.email_verified ? 'active' : 'pending';

    const { error: upsertErr } = await supabase.from('memberships').upsert([{
      connected_account_id: connectedAccountId,
      invited_email: email,
      invited_by_user_id: userId,
      role,
      status,
      accepted_user_id: invitee?.id ?? null,
      accepted_at: status === 'active' ? new Date().toISOString() : null
    }], { onConflict: 'connected_account_id,invited_email' });
    if (upsertErr) throw upsertErr;

    const { data: me } = await supabase.from('users').select('name, email').eq('id', userId).single();
    const inviter = me?.name || me?.email || 'Someone';
    const accountLabel = `@${account.username || account.alias || 'Instagram'}`;
    const send = await sendInviteEmail(email, inviter, accountLabel, role);

    return res.json({ ok: true, status, ...(send.devMode ? { devMode: true } : {}) });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

app.patch('/api/team/:membershipId', async (req, res) => {
  try {
    const userId = String(req.body?.userId ?? '');
    const role = String(req.body?.role ?? '');
    const id = req.params.membershipId;
    if (!userId || !['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'userId and role required' });

    const { data: m } = await supabase.from('memberships').select('*').eq('id', id).single();
    if (!m) return res.status(404).json({ error: 'membership not found' });

    const myRole = await getRoleForAccount(userId, m.connected_account_id);
    if (myRole !== 'owner' && myRole !== 'admin') return res.status(403).json({ error: 'Only owners and admins can change roles' });

    const { error } = await supabase.from('memberships').update({ role }).eq('id', id);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

app.delete('/api/team/:membershipId', async (req, res) => {
  try {
    const userId = String(req.query.userId ?? '');
    const id = req.params.membershipId;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const { data: m } = await supabase.from('memberships').select('*').eq('id', id).single();
    if (!m) return res.status(404).json({ error: 'membership not found' });

    const myRole = await getRoleForAccount(userId, m.connected_account_id);
    // Only owner can remove anyone; admins can remove viewers only
    if (myRole === 'owner' || (myRole === 'admin' && m.role === 'viewer')) {
      const { error } = await supabase.from('memberships').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }
    return res.status(403).json({ error: 'Insufficient permissions' });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ============== Settings ==============
app.get('/api/settings', async (req, res) => {
  const userId = String(req.query.userId ?? '');
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const { data: user, error } = await supabase.from('users').select('settings').eq('id', userId).single();
  if (error || !user) return res.status(404).json({ error: error?.message ?? 'user not found' });
  const s = (user.settings as any) ?? {};
  return res.json({
    settings: {
      composioApiKey: { isSet: !!s.composioApiKey, preview: maskKey(s.composioApiKey) },
      anthropicApiKey: { isSet: !!s.anthropicApiKey, preview: maskKey(s.anthropicApiKey) },
      openaiApiKey: { isSet: !!s.openaiApiKey, preview: maskKey(s.openaiApiKey) },
      geminiApiKey: { isSet: !!s.geminiApiKey, preview: maskKey(s.geminiApiKey) },
      provider: s.provider || 'anthropic'
    },
    defaults: {
      composioApiKey: { isSet: !!COMPOSIO_KEY, preview: maskKey(COMPOSIO_KEY) },
      anthropicApiKey: { isSet: !!process.env.ANTHROPIC_API_KEY, preview: maskKey(process.env.ANTHROPIC_API_KEY) },
      openaiApiKey: { isSet: !!process.env.OPENAI_API_KEY, preview: maskKey(process.env.OPENAI_API_KEY) },
      geminiApiKey: { isSet: !!process.env.GEMINI_API_KEY, preview: maskKey(process.env.GEMINI_API_KEY) }
    }
  });
});

app.put('/api/settings', async (req, res) => {
  try {
    const userId = String(req.body?.userId ?? '');
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const { data: user, error: lookupErr } = await supabase.from('users').select('settings').eq('id', userId).single();
    if (lookupErr || !user) return res.status(404).json({ error: 'user not found' });

    const next: any = { ...((user.settings as any) ?? {}) };
    const FIELDS = ['composioApiKey', 'anthropicApiKey', 'openaiApiKey', 'geminiApiKey', 'provider'];
    for (const f of FIELDS) {
      if (!(f in (req.body || {}))) continue;
      const v = req.body[f];
      if (v === null || v === '') delete next[f];
      else if (typeof v === 'string') next[f] = v.trim();
    }

    // Clear cached per-user clients for this user so the new key is picked up immediately
    const oldKey = (user.settings as any)?.composioApiKey;
    if (oldKey && oldKey !== next.composioApiKey) {
      composioCache.delete(oldKey);
      authConfigCache.delete(oldKey);
    }

    const { error: updateErr } = await supabase.from('users').update({
      settings: next,
      updated_at: new Date().toISOString()
    }).eq('id', userId);
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ============== Composio account flow ==============
app.post('/api/connect', async (req, res) => {
  try {
    const userId = String(req.body?.userId ?? '');
    const username = String(req.body?.username ?? '').trim().replace(/^@/, '');
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!username) return res.status(400).json({ error: 'username is required' });

    const { data: user, error: userErr } = await supabase.from('users').select('*').eq('id', userId).single();
    if (userErr || !user) return res.status(404).json({ error: 'user not found' });

    const callbackUrl = `${PUBLIC_URL.replace(/\/+$/, '')}/api/callback?userId=${encodeURIComponent(userId)}`;
    const c = composioFor(user);
    const authConfigId = await getInstagramAuthConfigIdFor(user);
    const connection = await c.connectedAccounts.link(user.composio_user_id, authConfigId, {
      callbackUrl,
      alias: username,
      allowMultiple: true
    });

    const { error: insertErr } = await supabase.from('connected_accounts').insert([{
      id: randomUUID(),
      user_id: userId,
      connected_account_id: connection.id,
      alias: username,
      username,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }]);
    if (insertErr) throw insertErr;

    return res.json({ redirectUrl: connection.redirectUrl });
  } catch (err: any) {
    if (err instanceof ComposioKeyMissing) return res.status(400).json({ error: err.message, code: 'COMPOSIO_KEY_MISSING' });
    console.error('connect failed', err);
    return res.status(500).json({ error: String(err) });
  }
});

app.get('/api/callback', async (req, res) => {
  const userId = String(req.query.userId ?? '');
  if (!userId) return res.status(400).send(callbackPage('Connection failed', 'Missing userId in callback URL.'));

  try {
    const { data: account, error: accErr } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (accErr || !account) return res.status(404).send(callbackPage('Connection failed', 'No pending connection found.'));

    try {
      const { data: user } = await supabase.from('users').select('*').eq('id', userId).single();
      const c = composioFor(user);
      const connected = await c.connectedAccounts.waitForConnection(account.connected_account_id, 120000);
      await supabase.from('connected_accounts').update({
        status: 'active',
        connected_status: connected.status,
        updated_at: new Date().toISOString()
      }).eq('id', account.id);

      if (user && !user.selected_connected_account_id) {
        await supabase.from('users').update({
          selected_connected_account_id: account.connected_account_id,
          updated_at: new Date().toISOString()
        }).eq('id', userId);
      }

      return res.send(callbackPage(`@${account.username || account.alias} connected`, 'Account linked successfully. You can close this tab and return to the dashboard.'));
    } catch (waitErr) {
      await supabase.from('connected_accounts').update({
        status: 'failed',
        connected_status: String(waitErr),
        updated_at: new Date().toISOString()
      }).eq('id', account.id);
      return res.status(500).send(callbackPage('Connection failed', String(waitErr)));
    }
  } catch (err) {
    console.error('callback failed', err);
    return res.status(500).send(callbackPage('Callback failed', String(err)));
  }
});

app.patch('/api/select-account', async (req, res) => {
  const userId = String(req.body?.userId ?? '');
  const connectedAccountId = String(req.body?.connectedAccountId ?? '');
  if (!userId || !connectedAccountId) return res.status(400).json({ error: 'userId and connectedAccountId required' });

  // Verify access (owner OR active member). Previously this filtered by user_id, which broke
  // admins/viewers selecting shared accounts.
  const role = await getRoleForAccount(userId, connectedAccountId);
  if (!role) return res.status(403).json({ error: 'No access to this account' });

  const { error: updateErr } = await supabase.from('users').update({
    selected_connected_account_id: connectedAccountId,
    updated_at: new Date().toISOString()
  }).eq('id', userId);
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  return res.json({ selectedConnectedAccountId: connectedAccountId });
});

app.delete('/api/accounts/:connectedAccountId', async (req, res) => {
  try {
    const userId = String(req.query.userId ?? '');
    const connectedAccountId = req.params.connectedAccountId;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const role = await getRoleForAccount(userId, connectedAccountId);
    if (role !== 'owner') return res.status(403).json({ error: 'Only the account owner can disconnect.' });

    const { data: user } = await supabase.from('users').select('*').eq('id', userId).single();
    const c = composioFor(user);
    try { await c.connectedAccounts.delete(connectedAccountId); } catch (e) { console.warn('composio delete failed', e); }
    await supabase.from('connected_accounts').delete().eq('user_id', userId).eq('connected_account_id', connectedAccountId);

    if (user?.selected_connected_account_id === connectedAccountId) {
      const { data: remaining } = await supabase.from('connected_accounts').select('connected_account_id').eq('user_id', userId).eq('status', 'active').limit(1);
      await supabase.from('users').update({
        selected_connected_account_id: remaining?.[0]?.connected_account_id ?? null,
        updated_at: new Date().toISOString()
      }).eq('id', userId);
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ============== Report job system ==============
type JobLog = { level: 'info' | 'warn' | 'error' | 'tool'; message: string; timestamp: string };
type Job = {
  id: string;
  userId: string;
  connectedAccountId: string;
  status: 'running' | 'done' | 'failed';
  logs: JobLog[];
  result?: any;
  error?: string;
  emitter: EventEmitter;
  startedAt: string;
};

const jobs = new Map<string, Job>();

function createJob(userId: string, connectedAccountId: string): Job {
  const job: Job = {
    id: randomUUID(),
    userId,
    connectedAccountId,
    status: 'running',
    logs: [],
    emitter: new EventEmitter(),
    startedAt: new Date().toISOString()
  };
  job.emitter.setMaxListeners(20);
  jobs.set(job.id, job);
  setTimeout(() => jobs.delete(job.id), 30 * 60 * 1000);
  return job;
}

function jobLog(job: Job, level: JobLog['level'], message: string) {
  const entry: JobLog = { level, message, timestamp: new Date().toISOString() };
  job.logs.push(entry);
  job.emitter.emit('log', entry);
}

app.post('/api/report/start', async (req, res) => {
  try {
    const userId = String(req.body?.userId ?? '');
    const overrideAccountId = req.body?.connectedAccountId ? String(req.body.connectedAccountId) : null;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const { data: user, error: userErr } = await supabase.from('users').select('*').eq('id', userId).single();
    if (userErr || !user) return res.status(404).json({ error: 'user not found' });

    const selectedId = overrideAccountId || user.selected_connected_account_id;
    if (!selectedId) return res.status(400).json({ error: 'no Instagram account selected' });

    const role = await getRoleForAccount(userId, selectedId);
    if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Read-only access — ask an admin to generate the report.' });

    // For shared accounts, run Composio using the OWNER's key (the IG connection lives under their composio_user_id)
    const { data: ownerRow } = await supabase.from('connected_accounts').select('user_id').eq('connected_account_id', selectedId).single();
    const { data: ownerUser } = ownerRow?.user_id ? await supabase.from('users').select('*').eq('id', ownerRow.user_id).single() : { data: null };
    const composioOwner = ownerUser ?? user;

    composioFor(composioOwner); // pre-flight: throws ComposioKeyMissing → caught below

    const job = createJob(userId, selectedId);
    runReportJob(job, composioOwner, selectedId).catch((err) => {
      job.status = 'failed';
      job.error = String(err);
      jobLog(job, 'error', `Job failed: ${err}`);
      job.emitter.emit('done');
    });

    return res.json({ jobId: job.id });
  } catch (err: any) {
    if (err instanceof ComposioKeyMissing) return res.status(400).json({ error: err.message, code: 'COMPOSIO_KEY_MISSING' });
    return res.status(500).json({ error: String(err) });
  }
});

app.get('/api/report/stream', (req, res) => {
  const jobId = String(req.query.jobId ?? '');
  const job = jobs.get(jobId);
  if (!job) return res.status(404).end('job not found');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('status', { status: job.status, startedAt: job.startedAt });
  for (const log of job.logs) send('log', log);

  if (job.status === 'done') {
    send('done', { reportId: job.result?.reportId ?? null });
    return res.end();
  }
  if (job.status === 'failed') {
    send('failed', { error: job.error });
    return res.end();
  }

  const onLog = (entry: JobLog) => send('log', entry);
  const onDone = () => {
    if (job.status === 'done') send('done', { reportId: job.result?.reportId ?? null });
    else send('failed', { error: job.error });
    cleanup();
    res.end();
  };
  const cleanup = () => {
    job.emitter.off('log', onLog);
    job.emitter.off('done', onDone);
  };
  job.emitter.on('log', onLog);
  job.emitter.on('done', onDone);

  req.on('close', cleanup);
});

app.get('/api/report/result', async (req, res) => {
  const jobId = String(req.query.jobId ?? '');
  const job = jobs.get(jobId);
  if (job?.result?.report) return res.json({ report: job.result.report, reportId: job.result.reportId });
  // fall back to DB if the in-memory job is gone
  const reportId = req.query.reportId ? String(req.query.reportId) : null;
  if (reportId) {
    const { data } = await supabase.from('reports').select('*').eq('id', reportId).single();
    if (data) return res.json({ report: data.data, reportId: data.id });
  }
  return res.status(404).json({ error: 'job/report not found' });
});

app.get('/api/reports', async (req, res) => {
  const userId = String(req.query.userId ?? '');
  const connectedAccountId = String(req.query.connectedAccountId ?? '');
  if (!userId || !connectedAccountId) return res.status(400).json({ error: 'userId and connectedAccountId are required' });

  const role = await getRoleForAccount(userId, connectedAccountId);
  if (!role) return res.status(403).json({ error: 'No access to this account' });

  const { data, error } = await supabase.from('reports')
    .select('id, created_at')
    .eq('connected_account_id', connectedAccountId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ reports: data ?? [] });
});

app.get('/api/report/latest', async (req, res) => {
  const userId = String(req.query.userId ?? '');
  const connectedAccountId = String(req.query.connectedAccountId ?? '');
  if (!userId || !connectedAccountId) return res.status(400).json({ error: 'userId and connectedAccountId are required' });

  // Verify access (owner OR active member); fetch by connected_account_id so admins/viewers
  // see the report even though it's stored under the owner's user_id.
  const role = await getRoleForAccount(userId, connectedAccountId);
  if (!role) return res.status(403).json({ error: 'No access to this account' });

  const { data, error } = await supabase.from('reports')
    .select('*')
    .eq('connected_account_id', connectedAccountId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ report: data?.[0]?.data ?? null, createdAt: data?.[0]?.created_at ?? null, reportId: data?.[0]?.id ?? null });
});

// Note: registered AFTER /api/report/latest so Express matches the literal path first.
app.get('/api/report/:reportId', async (req, res) => {
  const userId = String(req.query.userId ?? '');
  const reportId = req.params.reportId;
  if (!userId || !reportId) return res.status(400).json({ error: 'userId and reportId required' });

  const { data, error } = await supabase.from('reports').select('*').eq('id', reportId).single();
  if (error || !data) return res.status(404).json({ error: 'report not found' });

  const role = await getRoleForAccount(userId, data.connected_account_id);
  if (!role) return res.status(403).json({ error: 'No access to this report' });

  return res.json({ report: data.data, createdAt: data.created_at, reportId: data.id });
});

async function runReportJob(job: Job, user: any, connectedAccountId: string) {
  jobLog(job, 'info', `Starting report for account ${connectedAccountId}`);

  const { data: account } = await supabase.from('connected_accounts').select('*').eq('user_id', user.id).eq('connected_account_id', connectedAccountId).single();
  if (!account) throw new Error('connected account not found');
  jobLog(job, 'info', `Account alias: @${account.username || account.alias}`);

  jobLog(job, 'info', 'Creating Composio session with Instagram tools…');
  const c = composioFor(user);
  // Note: INSTAGRAM_GET_IG_USER_INFO doesn't exist as a slug in Composio's Instagram toolkit
  // (verified via runtime error). When/if Composio adds a follower-count tool, append its slug here
  // and the agent prompt will pick it up automatically.
  const igTools = ['INSTAGRAM_GET_IG_USER_MEDIA', 'INSTAGRAM_GET_IG_MEDIA_INSIGHTS'];
  const session = await c.create(user.composio_user_id, {
    sessionPreset: SessionPreset.DIRECT_TOOLS,
    toolkits: ['instagram'],
    tools: { instagram: igTools },
    connectedAccounts: { instagram: connectedAccountId },
    manageConnections: false,
    preload: { tools: igTools }
  });
  jobLog(job, 'info', 'Composio session ready.');

  const prompt = `You are a reporting assistant. Use the Instagram MCP tools to fetch the authenticated user's Reels from the last 15 days.\n\n` +
    `1) Call INSTAGRAM_GET_IG_USER_MEDIA. ALWAYS pass a "fields" parameter (or equivalent) with this comma-separated list: id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp,video_duration,username. Fetch enough pages to cover the full 15-day window. Also try requesting "username" so we can derive accountUsername from the response.\n` +
    `2) Keep only items posted within the last 15 days AND where media_product_type === "REELS" (or media_type === "VIDEO" when product type is missing).\n` +
    `3) For EACH reel, call INSTAGRAM_GET_IG_MEDIA_INSIGHTS. Try to request these metrics by name when the tool accepts a metric list: views, reach, likes, comments, saved, shares, total_interactions, ig_reels_video_view_total_time, ig_reels_avg_watch_time, plays, clips_replays_count, profile_activity. If the tool supports a breakdown parameter, request breakdown=follow_type on reach (so we can compute non-follower reach) and breakdown=action_type on profile_activity. Collect every numeric field returned. Keep the raw response in the "insights" object verbatim — including any "breakdowns" array or nested object Instagram returns.\n` +
    `4) For each reel capture: id, caption, permalink, thumbnailUrl (use media node's thumbnail_url for videos, or media_url if not present), timestamp (postedAt as the raw ISO string Instagram returned — do NOT convert timezone here), mediaProductType, durationSeconds (from video_duration; null if not exposed). CRITICAL: Always copy the caption verbatim from the media node — never replace with "(no caption)" or "". If the API returns no caption field for a media item, use an empty string. Never omit thumbnailUrl if the tool returned one.\n` +
    `5) Return ONLY a JSON object with: reportGeneratedAt (ISO timestamp), dateRange (string like "Last 15 days: YYYY-MM-DD to YYYY-MM-DD"), accountUsername (string, from any media node's username field if present), followerCount (set to null — Composio's Instagram toolkit doesn't currently expose a follower-count tool), reels (array of { id, caption, permalink, thumbnailUrl, postedAt, mediaProductType, durationSeconds, insights }).\n` +
    `6) No markdown fences, no commentary.`;

  const schema = {
    type: 'object',
    properties: {
      reportGeneratedAt: { type: 'string' },
      dateRange: { type: 'string' },
      accountUsername: { type: 'string' },
      followerCount: { type: ['number', 'null'] },
      reels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            caption: { type: 'string' },
            permalink: { type: 'string' },
            thumbnailUrl: { type: 'string' },
            postedAt: { type: 'string' },
            mediaProductType: { type: 'string' },
            durationSeconds: { type: ['number', 'null'] },
            insights: { type: 'object', additionalProperties: true }
          },
          required: ['id', 'insights'],
          additionalProperties: true
        }
      }
    },
    required: ['reportGeneratedAt', 'reels'],
    additionalProperties: true
  };

  const fetchModel = resolveModel(user);
  jobLog(job, 'info', `Invoking Claude Agent SDK${fetchModel ? ` (model: ${fetchModel})` : ''}…`);
  const raw = await runAgentStreamed(prompt, schema, session.mcp, job, fetchModel);
  jobLog(job, 'info', `Agent returned ${raw.reels?.length ?? 0} reels.`);
  if (raw.accountUsername) {
    jobLog(job, 'info', `Detected Instagram username: @${raw.accountUsername}`);
    await supabase.from('connected_accounts').update({
      username: raw.accountUsername,
      updated_at: new Date().toISOString()
    }).eq('user_id', user.id).eq('connected_account_id', connectedAccountId);
  }

  jobLog(job, 'info', 'Enriching reels with metrics (hook score, watch_s, share/save pct, replay rate)…');
  const enriched: any = enrichReport(raw);
  jobLog(job, 'info', `Enriched ${enriched.reels.length} reels.`);

  jobLog(job, 'info', 'Computing trends (time series, day-of-week, caption breakdown)…');
  enriched.analysis = analyzeReport(enriched);
  jobLog(job, 'info', `Analysis ready: ${enriched.analysis.timeSeries.length} time-series points, ${enriched.analysis.dayOfWeek.filter((d: any) => d.count).length} active weekdays.`);

  const withThumb = enriched.reels.filter((r: any) => r.thumbnailUrl).length;
  jobLog(job, 'info', `Agent supplied ${withThumb}/${enriched.reels.length} thumbnail URLs.`);
  if (withThumb < enriched.reels.length) {
    jobLog(job, 'warn', `Reels with missing thumbnailUrl will show a placeholder. (Instagram's media node didn't expose thumbnail_url for those.)`);
  }
  jobLog(job, 'info', `Downloading thumbnails via curl…`);
  const dlResults = await downloadThumbnails(enriched.reels, job);
  jobLog(job, 'info', `Thumbnails: ${dlResults.ok} downloaded, ${dlResults.failed} failed${dlResults.failed ? ' (browser will retry the remote URL directly)' : ''}.`);

  jobLog(job, 'info', 'Asking Claude for "Do more / Do less of" suggestions…');
  try {
    const suggestions = await generateSuggestions(enriched, job, user);
    (enriched as any).suggestions = suggestions;
    jobLog(job, 'info', `Suggestions generated (${suggestions.doMoreOf?.length ?? 0} do-more, ${suggestions.doLessOf?.length ?? 0} do-less).`);
  } catch (suggErr) {
    jobLog(job, 'warn', `Suggestions skipped: ${suggErr}`);
    (enriched as any).suggestions = null;
  }

  jobLog(job, 'info', 'Saving report to Supabase…');
  const reportId = randomUUID();
  const { error: reportErr } = await supabase.from('reports').insert([{
    id: reportId,
    user_id: user.id,
    connected_account_id: connectedAccountId,
    data: enriched,
    created_at: new Date().toISOString()
  }]);
  if (reportErr) throw reportErr;
  jobLog(job, 'info', `Report saved (id=${reportId}).`);

  await supabase.from('users').update({
    last_report_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq('id', user.id);

  job.status = 'done';
  job.result = { reportId, report: enriched };
  jobLog(job, 'info', '✓ Done. You can close this tab.');
  job.emitter.emit('done');
}

app.use((_req, res) => res.status(404).send('Not found'));
// Bind explicitly to 0.0.0.0 — required so Railway / containers can reach the server from outside the loopback.
app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on 0.0.0.0:${PORT}  (PUBLIC_URL=${PUBLIC_URL})  (raw process.env.PORT=${process.env.PORT ?? 'unset'})`));

// ============== Enrichment ==============
type RawReel = {
  id: string;
  caption?: string;
  permalink?: string;
  thumbnailUrl?: string;
  postedAt?: string;
  mediaProductType?: string;
  durationSeconds?: number;
  insights: Record<string, unknown>;
};

function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[^0-9.\-]+/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const DEFAULT_REEL_DURATION_SECONDS = 30; // Fallback when Instagram doesn't expose video_duration

// Extract numbers from possibly-nested Instagram breakdowns (e.g. reach with breakdown=follow_type)
function extractBreakdown(ins: any, metricKey: string, breakdownDimension: string, label: string): number {
  const breakdowns = ins?.[metricKey]?.breakdowns ?? ins?.breakdowns;
  if (!Array.isArray(breakdowns)) return 0;
  for (const b of breakdowns) {
    if (b?.dimension_keys?.includes?.(breakdownDimension) || b?.name === breakdownDimension) {
      const values = b?.results ?? b?.values ?? [];
      for (const v of values) {
        const valueLabel = v?.dimension_values?.[0] ?? v?.label ?? v?.name;
        if (valueLabel === label) return num(v?.value);
      }
    }
  }
  return 0;
}

function enrichReport(raw: any) {
  const now = Date.now();
  const followerCount = num(raw.followerCount);
  const reels = (raw.reels ?? []).map((reel: RawReel) => {
    const ins = reel.insights ?? {};
    const views = num((ins as any).views ?? (ins as any).plays ?? (ins as any).impressions);
    const reach = num((ins as any).reach);
    const impressions = num((ins as any).impressions ?? views);
    const likes = num((ins as any).likes ?? (ins as any).like_count);
    const comments = num((ins as any).comments ?? (ins as any).comment_count);
    const shares = num((ins as any).shares ?? (ins as any).share_count);
    const saves = num((ins as any).saved ?? (ins as any).saves ?? (ins as any).save_count);
    const totalInteractions = num((ins as any).total_interactions ?? (ins as any).interactions ?? (likes + comments + shares + saves));
    const avgWatchRaw = num((ins as any).ig_reels_avg_watch_time ?? (ins as any).ig_reels_avg_watch_time_ms ?? (ins as any).average_watch_time);
    const watchSeconds = avgWatchRaw > 1000 ? avgWatchRaw / 1000 : avgWatchRaw;
    const totalWatchRaw = num((ins as any).ig_reels_video_view_total_time ?? (ins as any).ig_reels_video_view_total_time_ms);
    const totalWatchSeconds = totalWatchRaw > 1000 ? totalWatchRaw / 1000 : totalWatchRaw;
    const duration = num(reel.durationSeconds ?? (ins as any).video_duration);
    const durationEstimated = !(duration > 0);
    const effectiveDuration = duration > 0 ? duration : DEFAULT_REEL_DURATION_SECONDS;

    const sharePct = reach > 0 ? (shares / reach) * 100 : 0;
    const savePct = reach > 0 ? (saves / reach) * 100 : 0;
    const replayRate = reach > 0 ? views / reach : 0;
    const hookRate = watchSeconds > 0 ? watchSeconds / effectiveDuration : 0;
    const engagementRate = reach > 0 ? (totalInteractions / reach) * 100 : 0;

    // New per-reel metrics requested by the user
    const postedTs = new Date(reel.postedAt ?? '').getTime();
    const daysLive = !Number.isNaN(postedTs) ? Math.max(0.5, (now - postedTs) / 86_400_000) : 0;
    // Project to 30 days using observed daily rate, capped at 5× current views so a 1-day-old reel doesn't claim wild numbers
    const projectedViews30d = daysLive > 0 ? Math.round(views * Math.min(30 / daysLive, 5)) : views;
    const saveShareRatio = shares > 0 ? saves / shares : (saves > 0 ? saves : 0);
    const engagementVelocity = daysLive > 0 ? totalInteractions / daysLive : 0;
    const commentLikeRatio = likes > 0 ? comments / likes : 0;
    const shareSaveLikesRatio = likes > 0 ? (shares + saves) / likes : 0;
    const replaysRaw = num((ins as any).clips_replays_count ?? (ins as any).replays);

    // Non-follower reach from breakdown=follow_type (Instagram returns FOLLOWER / NON_FOLLOWER)
    const reachNonFollower = extractBreakdown(ins, 'reach', 'follow_type', 'NON_FOLLOWER') || extractBreakdown(ins, 'reach', 'follow_type', 'non_follower');
    const reachFollower = extractBreakdown(ins, 'reach', 'follow_type', 'FOLLOWER') || extractBreakdown(ins, 'reach', 'follow_type', 'follower');
    const nonFollowerReachPct = reach > 0 && (reachNonFollower || reachFollower) ? (reachNonFollower / reach) * 100 : null;
    const reachRate = followerCount > 0 ? (reach / followerCount) * 100 : null;

    // Profile activity (visits / follows / bio_link taps). Total, then breakdowns when available.
    const profileActions = num((ins as any).profile_activity?.value ?? (ins as any).profile_activity);
    const profileFollows = extractBreakdown(ins, 'profile_activity', 'action_type', 'FOLLOW');
    const profileBioTaps = extractBreakdown(ins, 'profile_activity', 'action_type', 'BIO_LINK_CLICKED') || extractBreakdown(ins, 'profile_activity', 'action_type', 'bio_link_clicked');
    const reachFactor = Math.sqrt(Math.max(reach, 0));
    const socialBoost = 1 + sharePct / 100 + savePct / 200;
    const hookScore = watchSeconds * reachFactor * socialBoost;
    const hookScoreFromRate = duration > 0 ? hookRate * reachFactor * socialBoost : null;

    return {
      id: reel.id,
      caption: reel.caption ?? '',
      permalink: reel.permalink ?? '',
      thumbnailUrl: reel.thumbnailUrl ?? '',
      postedAt: reel.postedAt ?? '',
      mediaProductType: reel.mediaProductType ?? '',
      durationSeconds: duration || null,
      durationEstimated,
      effectiveDurationSeconds: effectiveDuration,
      metrics: {
        views,
        reach,
        impressions,
        likes,
        comments,
        shares,
        saves,
        totalInteractions,
        watchSeconds: round(watchSeconds, 2),
        totalWatchSeconds: round(totalWatchSeconds, 2),
        sharePct: round(sharePct, 2),
        savePct: round(savePct, 2),
        replayRate: round(replayRate, 3),
        hookRate: round(Math.min(hookRate, 5) * 100, 2),  // % of video watched on average; capped at 500% so outliers don't break the scale
        hookRateEstimated: durationEstimated,
        engagementRate: round(engagementRate, 2),
        hookScore: round(hookScore, 2),
        hookScoreFromRate: hookScoreFromRate === null ? null : round(hookScoreFromRate, 2),
        hookScoreNormalized: 0,  // filled in below
        daysLive: round(daysLive, 1),
        projectedViews30d,
        saveShareRatio: round(saveShareRatio, 2),
        engagementVelocity: round(engagementVelocity, 1),
        commentLikeRatio: round(commentLikeRatio, 3),
        shareSaveLikesRatio: round(shareSaveLikesRatio, 3),
        replaysRaw,
        nonFollowerReachPct: nonFollowerReachPct === null ? null : round(nonFollowerReachPct, 1),
        reachRate: reachRate === null ? null : round(reachRate, 2),
        profileActions,
        profileFollows,
        profileBioTaps
      },
      insights: ins,
      localThumbnail: `/thumbs/${sanitize(reel.id)}.jpg`
    };
  });

  // Normalize hook score 0-100 across the report (min-max)
  if (reels.length) {
    const scores = reels.map((r: any) => r.metrics.hookScore);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const span = max - min;
    for (const r of reels) {
      r.metrics.hookScoreNormalized = span > 0 ? round(((r.metrics.hookScore - min) / span) * 100, 1) : 100;
    }
  }

  reels.sort((a: any, b: any) => (b.metrics.hookScore ?? 0) - (a.metrics.hookScore ?? 0));

  const totals = reels.reduce((acc: any, r: any) => {
    acc.views += r.metrics.views;
    acc.reach += r.metrics.reach;
    acc.likes += r.metrics.likes;
    acc.comments += r.metrics.comments;
    acc.shares += r.metrics.shares;
    acc.saves += r.metrics.saves;
    acc.totalInteractions += r.metrics.totalInteractions;
    return acc;
  }, { views: 0, reach: 0, likes: 0, comments: 0, shares: 0, saves: 0, totalInteractions: 0 });

  const avg = (key: string) => reels.length ? round(reels.reduce((s: number, r: any) => s + (r.metrics[key] ?? 0), 0) / reels.length, 2) : 0;

  // Observed window length (days) from earliest to latest reel
  const validDates = reels
    .map((r: any) => new Date(r.postedAt).getTime())
    .filter((t: number) => !Number.isNaN(t));
  const observedDays = validDates.length >= 2
    ? Math.max(1, (Math.max(...validDates) - Math.min(...validDates)) / 86_400_000)
    : Math.max(1, reels.length);

  // Posting velocity (kept; the user wanted Proj-30 reels removed but velocity remains useful in stat tooltips)
  const reelsPerWeek = round((reels.length / observedDays) * 7, 1);

  // Score tiers from normalized hook
  const tiers = { hot: 0, solid: 0, weak: 0 };
  for (const r of reels) {
    const v = r.metrics.hookScoreNormalized ?? 0;
    if (v >= 70) tiers.hot++;
    else if (v >= 35) tiers.solid++;
    else tiers.weak++;
  }

  return {
    reportGeneratedAt: raw.reportGeneratedAt ?? new Date().toISOString(),
    dateRange: raw.dateRange ?? 'Last 15 days',
    accountUsername: raw.accountUsername ?? '',
    followerCount: followerCount || null,
    totals,
    averages: {
      hookScore: avg('hookScore'),
      hookScoreNormalized: avg('hookScoreNormalized'),
      hookRate: avg('hookRate'),
      engagementRate: avg('engagementRate'),
      watchSeconds: avg('watchSeconds'),
      sharePct: avg('sharePct'),
      savePct: avg('savePct'),
      replayRate: avg('replayRate'),
      saveShareRatio: avg('saveShareRatio'),
      engagementVelocity: avg('engagementVelocity'),
      commentLikeRatio: avg('commentLikeRatio'),
      nonFollowerReachPct: avg('nonFollowerReachPct'),
      reachRate: avg('reachRate')
    },
    reelsPerWeek,
    tiers,
    observedDays: round(observedDays, 1),
    reelCount: reels.length,
    reels
  };
}

function sanitize(value: string): string {
  return String(value).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 120);
}

// ============== Trend analysis ==============
const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CTA_REGEX = /\b(comment|dm me|dm us|link in bio|click|tap|reply|share this|save this|follow|tag)\b/i;

function analyzeReport(report: any) {
  const reels = report.reels ?? [];

  // Time series — chronological order
  const timeSeries = reels
    .map((r: any) => ({
      id: r.id,
      date: r.postedAt,
      hookScoreNormalized: r.metrics.hookScoreNormalized ?? 0,
      hookScore: r.metrics.hookScore ?? 0,
      views: r.metrics.views ?? 0,
      reach: r.metrics.reach ?? 0,
      watchSeconds: r.metrics.watchSeconds ?? 0,
      caption: (r.caption || '').slice(0, 60)
    }))
    .filter((p: any) => p.date && !Number.isNaN(new Date(p.date).getTime()))
    .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // 3-reel rolling average over the sorted series
  const rolling = timeSeries.map((p: any, i: number) => {
    const window = timeSeries.slice(Math.max(0, i - 2), i + 1);
    const avg = window.reduce((s: number, w: any) => s + (w.hookScoreNormalized ?? 0), 0) / window.length;
    return { ...p, rolling: round(avg, 1) };
  });

  // Day-of-week aggregates
  const dayBuckets = Array.from({ length: 7 }, () => ({ count: 0, sumHook: 0, sumViews: 0, sumWatch: 0 }));
  for (const r of reels) {
    const d = new Date(r.postedAt);
    if (Number.isNaN(d.getTime())) continue;
    const dow = d.getDay();
    dayBuckets[dow].count++;
    dayBuckets[dow].sumHook += r.metrics.hookScoreNormalized ?? 0;
    dayBuckets[dow].sumViews += r.metrics.views ?? 0;
    dayBuckets[dow].sumWatch += r.metrics.watchSeconds ?? 0;
  }
  const dayOfWeek = dayBuckets.map((b, i) => ({
    day: i,
    label: DOW_LABELS[i],
    count: b.count,
    avgHookNormalized: b.count ? round(b.sumHook / b.count, 1) : null,
    avgViews: b.count ? Math.round(b.sumViews / b.count) : null,
    avgWatch: b.count ? round(b.sumWatch / b.count, 2) : null
  }));

  // Caption analysis
  const captionBuckets = analyzeCaptions(reels);

  return { timeSeries: rolling, dayOfWeek, captionBuckets };
}

function analyzeCaptions(reels: any[]) {
  const lengthBuckets = [
    { label: 'Short (<60 chars)', min: 0, max: 60, count: 0, sumHook: 0, sumViews: 0 },
    { label: 'Medium (60–150)', min: 60, max: 150, count: 0, sumHook: 0, sumViews: 0 },
    { label: 'Long (150+)', min: 150, max: Infinity, count: 0, sumHook: 0, sumViews: 0 }
  ];
  let withCTA = { count: 0, sumHook: 0, sumViews: 0 };
  let noCTA = { count: 0, sumHook: 0, sumViews: 0 };
  let totalHashtags = 0;
  let totalEmojis = 0;
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]/gu;

  for (const r of reels) {
    const cap = r.caption || '';
    const len = cap.length;
    const hook = r.metrics.hookScoreNormalized ?? 0;
    const views = r.metrics.views ?? 0;
    const hasCTA = CTA_REGEX.test(cap);
    const hashtags = (cap.match(/#\w+/g) || []).length;
    const emojis = (cap.match(emojiRegex) || []).length;
    totalHashtags += hashtags;
    totalEmojis += emojis;

    for (const b of lengthBuckets) {
      if (len >= b.min && len < b.max) {
        b.count++;
        b.sumHook += hook;
        b.sumViews += views;
        break;
      }
    }
    const target = hasCTA ? withCTA : noCTA;
    target.count++;
    target.sumHook += hook;
    target.sumViews += views;
  }

  return {
    byLength: lengthBuckets.map((b) => ({
      bucket: b.label,
      count: b.count,
      avgHook: b.count ? round(b.sumHook / b.count, 1) : null,
      avgViews: b.count ? Math.round(b.sumViews / b.count) : null
    })),
    byCTA: [
      { label: 'Has CTA', count: withCTA.count, avgHook: withCTA.count ? round(withCTA.sumHook / withCTA.count, 1) : null, avgViews: withCTA.count ? Math.round(withCTA.sumViews / withCTA.count) : null },
      { label: 'No CTA', count: noCTA.count, avgHook: noCTA.count ? round(noCTA.sumHook / noCTA.count, 1) : null, avgViews: noCTA.count ? Math.round(noCTA.sumViews / noCTA.count) : null }
    ],
    hashtagsAvg: reels.length ? round(totalHashtags / reels.length, 1) : 0,
    emojisAvg: reels.length ? round(totalEmojis / reels.length, 1) : 0
  };
}

// ============== Thumbnails ==============
async function downloadThumbnails(reels: Array<{ id: string; thumbnailUrl: string }>, job?: Job) {
  await fs.mkdir(THUMBS_DIR, { recursive: true });
  const results = await Promise.all(reels.map((r) => downloadOne(r.id, r.thumbnailUrl, job)));
  const failed = results.filter((r) => !r.ok);
  if (job && failed.length) {
    const sample = failed.slice(0, 3).map((r) => `${r.id}: ${r.reason}`).join(' · ');
    jobLog(job, 'warn', `Curl failures (sample): ${sample}`);
  }
  return { ok: results.filter((r) => r.ok).length, failed: failed.length };
}

const CURL_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

function downloadOne(id: string, url: string, _job?: Job): Promise<{ id: string; ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    if (!url) return resolve({ id, ok: false, reason: 'no thumbnailUrl from agent' });
    const out = path.join(THUMBS_DIR, `${sanitize(id)}.jpg`);
    const args = [
      '-sSL',
      '--max-time', '20',
      '-A', CURL_UA,
      '-H', 'Referer: https://www.instagram.com/',
      '-H', 'Accept: image/webp,image/apng,image/*,*/*;q=0.8',
      '-o', out,
      url
    ];
    let stderr = '';
    const child = spawn('curl', args);
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (d: Buffer | string) => { stderr += String(d); });
    child.on('exit', async (code: number | null) => {
      if (code === 0) {
        try {
          const stat = await fs.stat(out);
          if (stat.size > 100) return resolve({ id, ok: true });
          try { await fs.unlink(out); } catch {}
          return resolve({ id, ok: false, reason: `empty file (${stat.size} bytes)` });
        } catch (e) { return resolve({ id, ok: false, reason: `stat failed: ${e}` }); }
      }
      try { await fs.unlink(out); } catch {}
      resolve({ id, ok: false, reason: stderr.split('\n')[0]?.slice(0, 120) || `curl exit ${code}` });
    });
    child.on('error', (e) => resolve({ id, ok: false, reason: String(e) }));
  });
}

// ============== Suggestions (provider-dispatched) ==============
// Auto-selected "best" model per provider — no per-user model toggle in the UI.
const PROVIDER_BEST_MODEL: Record<string, string> = {
  anthropic: 'claude-opus-4-7',
  openai: 'gpt-5',
  google: 'gemini-2.5-pro'
};

function resolveProvider(user: any): 'anthropic' | 'openai' | 'google' {
  const p = (user?.settings ?? {}).provider;
  return (p === 'openai' || p === 'google') ? p : 'anthropic';
}

// Returns the model name passed to the Claude Agent SDK. Always Anthropic — the agent step
// requires Claude for MCP. The analysis step may use a different provider; that's handled
// in generateSuggestions directly.
function resolveModel(_user: any): string | undefined {
  return PROVIDER_BEST_MODEL.anthropic;
}

async function generateSuggestions(report: any, job: Job, user?: any) {
  const reels = (report.reels ?? []).map((r: any) => ({
    id: r.id,
    caption: (r.caption || '').slice(0, 280),
    postedAt: r.postedAt,
    durationSeconds: r.durationSeconds,
    hookScore: r.metrics.hookScore,
    hookScoreNormalized: r.metrics.hookScoreNormalized,
    watchSeconds: r.metrics.watchSeconds,
    hookRatePct: r.metrics.hookRate,
    views: r.metrics.views,
    reach: r.metrics.reach,
    sharePct: r.metrics.sharePct,
    savePct: r.metrics.savePct,
    engagementRate: r.metrics.engagementRate
  }));

  const prompt = `You are an Instagram Reels growth strategist writing a brief for a 2-person content team. Analyze the report and produce a punchy team-facing headline plus what to do MORE/LESS of next week.

TIMEZONE RULE: Every day/time you reference must be expressed in PACIFIC TIME (PST/PDT, UTC-8). When Instagram timestamps are in UTC, convert them to PST before quoting. Examples: "Tue–Wed 6–8pm PST", "Saturday morning PST". Never use UTC or any other timezone.

Look at patterns across top vs bottom quartile (by hookScoreNormalized): caption length, hook style, hashtag use, CTA language ("comment X", "DM me", "link in bio"), posting day/time (in PST), content theme, watch_s, hook_rate.

REPORT_DATE_RANGE: ${report.dateRange}
ACCOUNT: @${report.accountUsername || 'unknown'}
REEL_COUNT: ${reels.length}
REELS_JSON:
${JSON.stringify(reels)}

Return ONLY a JSON object with this shape, no commentary, no fences:
{
  "actionHeadline": "2-4 sentences written for the team. Format: 'Create more videos like X (concrete topic/style with reel id reference, why it worked). Avoid Y (concrete pattern, why it underperformed). Focus on Z next week.' Use real reel ids from the data. Concrete. No corporate fluff.",
  "summary": "1-2 sentence diagnosis of what's working overall.",
  "doMoreOf": [{ "title": "Short imperative (≤8 words)", "reasoning": "1 sentence with evidence, citing a hook score or watch time when possible.", "examples": ["reel id 1", "reel id 2"] }],
  "doLessOf": [{ "title": "Short imperative (≤8 words)", "reasoning": "1 sentence with evidence.", "examples": ["reel id 1"] }]
}

Provide 3-5 items in each list. Be specific — never generic platitudes like "post consistently".`;

  const schema = {
    type: 'object',
    properties: {
      actionHeadline: { type: 'string' },
      summary: { type: 'string' },
      doMoreOf: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            reasoning: { type: 'string' },
            examples: { type: 'array', items: { type: 'string' } }
          },
          required: ['title', 'reasoning']
        }
      },
      doLessOf: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            reasoning: { type: 'string' },
            examples: { type: 'array', items: { type: 'string' } }
          },
          required: ['title', 'reasoning']
        }
      }
    },
    required: ['actionHeadline', 'summary', 'doMoreOf', 'doLessOf']
  };

  const provider = resolveProvider(user);
  const settings = (user?.settings ?? {}) as any;
  const hasKey = (p: string) => p === 'anthropic' ? !!(settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY)
    : p === 'openai' ? !!(settings.openaiApiKey || process.env.OPENAI_API_KEY)
    : !!(settings.geminiApiKey || process.env.GEMINI_API_KEY);
  const chosen = hasKey(provider) ? provider : (hasKey('anthropic') ? 'anthropic' : provider);
  const model = PROVIDER_BEST_MODEL[chosen];
  jobLog(job, 'info', `Suggestions provider: ${chosen} (${model})${chosen !== provider ? ` — fell back from ${provider} because no key found` : ''}`);

  if (chosen === 'openai') {
    return suggestionsViaOpenAI(prompt, schema, settings.openaiApiKey || process.env.OPENAI_API_KEY!, model);
  }
  if (chosen === 'google') {
    return suggestionsViaGemini(prompt, schema, settings.geminiApiKey || process.env.GEMINI_API_KEY!, model);
  }

  // Anthropic path via Claude Agent SDK (default)
  const stream = query({
    prompt,
    options: {
      outputFormat: { type: 'json_schema', schema },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      thinking: { type: 'adaptive' },
      effort: 'low',
      model
    } as any
  });

  for await (const message of stream) {
    if (message.type === 'result') {
      if (message.subtype === 'success') {
        if ('structured_output' in message && (message as any).structured_output) return (message as any).structured_output;
        try { return JSON.parse((message as any).result); } catch { /* fall through */ }
      }
      if (message.subtype.startsWith('error')) {
        const errors = (message as any).errors;
        throw new Error(`Suggestions error: ${message.subtype} ${errors ? errors.join('; ') : ''}`);
      }
    }
  }
  throw new Error('Suggestions agent ended without a result.');
}

async function suggestionsViaOpenAI(prompt: string, schema: any, apiKey: string, model: string) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'suggestions', strict: false, schema }
      }
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
  }
  const json: any = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI: empty content');
  return JSON.parse(content);
}

async function suggestionsViaGemini(prompt: string, schema: any, apiKey: string, model: string) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema }
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
  }
  const json: any = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? '';
  if (!text) throw new Error('Gemini: empty content');
  return JSON.parse(text);
}

// ============== Agent runner with progress streaming ==============
async function runAgentStreamed(prompt: string, schema: any, mcpServer: any, job: Job, model?: string) {
  const stream = query({
    prompt,
    options: {
      mcpServers: { composio: mcpServer },
      outputFormat: { type: 'json_schema', schema },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      thinking: { type: 'adaptive' },
      effort: 'medium',
      ...(model ? { model } : {})
    } as any
  });

  for await (const message of stream) {
    try {
      if (message.type === 'assistant' && (message as any).message?.content) {
        for (const block of (message as any).message.content) {
          if (block.type === 'tool_use') {
            const toolName = block.name?.replace(/^mcp__composio__/, '') ?? block.name;
            const inputSummary = summarizeToolInput(block.input);
            jobLog(job, 'tool', `→ ${toolName}${inputSummary ? ' ' + inputSummary : ''}`);
          } else if (block.type === 'text' && block.text?.trim()) {
            const text = String(block.text).trim();
            if (text.length < 600) jobLog(job, 'info', text);
          }
        }
      } else if (message.type === 'user' && (message as any).message?.content) {
        for (const block of (message as any).message.content) {
          if (block.type === 'tool_result') {
            const summary = summarizeToolResult(block.content);
            jobLog(job, 'tool', `← ${summary}`);
          }
        }
      } else if (message.type === 'result') {
        if (message.subtype === 'success') {
          if ('structured_output' in message && (message as any).structured_output) return (message as any).structured_output;
          try { return JSON.parse((message as any).result); } catch (e) { throw new Error(`Failed to parse agent result: ${e}`); }
        }
        if (message.subtype.startsWith('error')) {
          const errors = (message as any).errors;
          throw new Error(`Agent error: ${message.subtype} ${errors ? errors.join('; ') : ''}`);
        }
      }
    } catch (e) {
      jobLog(job, 'warn', `Stream parse warning: ${e}`);
    }
  }
  throw new Error('Agent ended without a result.');
}

function summarizeToolInput(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const keys = Object.keys(input);
  if (!keys.length) return '';
  const parts: string[] = [];
  for (const k of keys.slice(0, 3)) {
    const v = input[k];
    if (v === null || v === undefined) continue;
    const s = typeof v === 'string' ? v.slice(0, 40) : typeof v === 'object' ? '{…}' : String(v);
    parts.push(`${k}=${s}`);
  }
  return parts.length ? `(${parts.join(', ')})` : '';
}

function summarizeToolResult(content: any): string {
  if (typeof content === 'string') return content.slice(0, 160);
  if (Array.isArray(content)) {
    const text = content.map((c) => (c?.text ?? '')).join(' ').slice(0, 160);
    return text || `${content.length} block(s)`;
  }
  try { return JSON.stringify(content).slice(0, 160); } catch { return 'result received'; }
}

function callbackPage(title: string, message: string) {
  const safe = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safe(title)}</title>
  <style>body{font-family:Inter,system-ui,sans-serif;background:#0a0a0f;color:#f5f5f7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
  .card{max-width:560px;background:#15151c;border:1px solid #2a2a36;border-radius:24px;padding:40px;box-shadow:0 40px 80px rgba(0,0,0,0.4)}
  h1{margin:0 0 12px;font-size:1.6rem} p{color:#a8a8b8;line-height:1.6}
  a{color:#8b7cff;text-decoration:none;font-weight:600}</style></head>
  <body><div class="card"><h1>${safe(title)}</h1><p>${safe(message)}</p><p><a href="/app">Return to dashboard →</a></p></div></body></html>`;
}
