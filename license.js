'use strict';
const { app } = require('electron');
const path    = require('path');
const fs      = require('fs');
const https   = require('https');
const crypto  = require('crypto');

const TRIAL_DAYS       = 7;
const GUMROAD_PRODUCT  = 'fencebreaker-pro';
const LICENSE_FILE     = () => path.join(app.getPath('userData'), 'license.json');
const MACHINE_FILE     = () => path.join(app.getPath('userData'), '.mid');

// ── Machine ID ────────────────────────────────────────────────────────────────

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

// ── Gumroad API ───────────────────────────────────────────────────────────────

function gumroadVerify(licenseKey, incrementUses) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      product_permalink:    GUMROAD_PRODUCT,
      license_key:          licenseKey,
      increment_uses_count: incrementUses ? 'true' : 'false',
    }).toString();

    const req = https.request({
      hostname: 'api.gumroad.com',
      path:     '/v2/licenses/verify',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
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
    req.write(body);
    req.end();
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

async function activate(licenseKey) {
  const key = (licenseKey || '').trim();
  if (!key) return { ok: false, error: 'License key is empty.' };

  let res;
  try {
    res = await gumroadVerify(key, true);
  } catch {
    return { ok: false, error: 'No internet connection.' };
  }

  if (res.status === 200 && res.body.success === true) {
    const d = read();
    d.licenseKey  = key;
    d.activatedAt = Date.now();
    d.email       = res.body.purchase?.email || '';
    d.machineId   = getMachineId();
    write(d);
    return { ok: true, email: d.email };
  }

  const msg = (res.body?.message || '').toLowerCase();
  if (msg.includes('exceeded') || msg.includes('used')) {
    return { ok: false, error: 'This license has already been used the maximum number of times.' };
  }
  return { ok: false, error: 'Invalid license key. Check your purchase email.' };
}

async function silentValidate() {
  const d = read();
  if (!d.licenseKey) return false;
  try {
    const res = await gumroadVerify(d.licenseKey, false);
    return res.status === 200 && res.body.success === true;
  } catch {
    return true; // offline — trust cached
  }
}

function getStatus() {
  const d        = read();
  const elapsed  = trialDaysElapsed();
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
