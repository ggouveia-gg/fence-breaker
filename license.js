'use strict';
const { app } = require('electron');
const path    = require('path');
const fs      = require('fs');
const https   = require('https');
const crypto  = require('crypto');

const TRIAL_DAYS    = 7;
const LICENSE_FILE  = () => path.join(app.getPath('userData'), 'license.json');
const MACHINE_FILE  = () => path.join(app.getPath('userData'), '.mid');

// ── Machine ID (stored UUID, created on first run) ────────────────────────────

function getMachineId() {
  const f = MACHINE_FILE();
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const id = crypto.randomUUID();
  fs.writeFileSync(f, id);
  return id;
}

// ── License file helpers ──────────────────────────────────────────────────────

function read() {
  try { return JSON.parse(fs.readFileSync(LICENSE_FILE(), 'utf8')); } catch { return {}; }
}

function write(data) {
  fs.writeFileSync(LICENSE_FILE(), JSON.stringify(data, null, 2));
}

// ── Trial ─────────────────────────────────────────────────────────────────────

function ensureTrialStart() {
  const d = read();
  if (!d.trialStart) { d.trialStart = Date.now(); write(d); }
  return d.trialStart;
}

function trialDaysElapsed() {
  const start = ensureTrialStart();
  return Math.floor((Date.now() - start) / 86_400_000);
}

// ── Lemon Squeezy API ─────────────────────────────────────────────────────────

function lsRequest(endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.lemonsqueezy.com',
      path: `/v1/licenses/${endpoint}`,
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch  { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

async function activate(licenseKey) {
  const key = (licenseKey || '').trim();
  if (!key) return { ok: false, error: 'License key is empty.' };

  let res;
  try {
    res = await lsRequest('activate', {
      license_key: key,
      instance_name: getMachineId(),
    });
  } catch {
    return { ok: false, error: 'No internet connection.' };
  }

  if (res.status === 200 && res.body.activated) {
    const d = read();
    d.licenseKey  = key;
    d.instanceId  = res.body.instance?.id;
    d.activatedAt = Date.now();
    d.email       = res.body.meta?.customer_email || '';
    write(d);
    return { ok: true, email: d.email };
  }

  // LS returns 400 when license is already used on another machine
  const errMsg = res.body?.error || '';
  if (errMsg.toLowerCase().includes('already')) {
    return { ok: false, error: 'This license is already activated on another machine.' };
  }
  return { ok: false, error: 'Invalid license key. Check your purchase email.' };
}

async function silentValidate() {
  const d = read();
  if (!d.licenseKey) return false;
  try {
    const res = await lsRequest('validate', {
      license_key: d.licenseKey,
      instance_id: d.instanceId,
    });
    return res.status === 200 && res.body.valid === true;
  } catch {
    return true; // offline — trust cached
  }
}

function getStatus() {
  const d       = read();
  const elapsed = trialDaysElapsed();
  const daysLeft = Math.max(0, TRIAL_DAYS - elapsed);

  if (d.licenseKey) {
    return { licensed: true, email: d.email || '', trialExpired: false, daysLeft: 0 };
  }
  return {
    licensed:     false,
    trialExpired: elapsed >= TRIAL_DAYS,
    daysLeft,
    email:        '',
  };
}

module.exports = { activate, silentValidate, getStatus, TRIAL_DAYS };
