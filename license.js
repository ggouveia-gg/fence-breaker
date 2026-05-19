'use strict';
const { app } = require('electron');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const https   = require('https');

const TRIAL_DAYS   = 7;
const API_BASE     = 'https://fencebreaker-api.vercel.app'; // updated after deploy
const LICENSE_FILE = () => path.join(app.getPath('userData'), 'license.json');
const MACHINE_FILE = () => path.join(app.getPath('userData'), '.mid');

// ── Machine ID ────────────────────────────────────────────────────────────────

function getMachineId() {
  const f = MACHINE_FILE();
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const id = crypto.randomUUID();
  fs.writeFileSync(f, id);
  return id;
}

// ── License file ──────────────────────────────────────────────────────────────

function read()       { try { return JSON.parse(fs.readFileSync(LICENSE_FILE(), 'utf8')); } catch { return {}; } }
function write(data)  { fs.writeFileSync(LICENSE_FILE(), JSON.stringify(data, null, 2)); }

// ── Trial ─────────────────────────────────────────────────────────────────────

function ensureTrialStart() {
  const d = read();
  if (!d.trialStart) { d.trialStart = Date.now(); write(d); }
  return d.trialStart;
}

function trialDaysElapsed() {
  return Math.floor((Date.now() - ensureTrialStart()) / 86_400_000);
}

// ── API call ──────────────────────────────────────────────────────────────────

function apiPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url  = new URL(API_BASE + endpoint);
    const req  = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

async function activate(licenseKey) {
  const key = (licenseKey || '').trim().toUpperCase();
  if (!key) return { ok: false, error: 'License key is empty.' };

  let res;
  try {
    res = await apiPost('/api/validate', { key });
  } catch {
    return { ok: false, error: 'No internet connection.' };
  }

  if (res?.ok) {
    const d = read();
    d.licenseKey  = key;
    d.activatedAt = Date.now();
    d.email       = res.email || '';
    d.machineId   = getMachineId();
    write(d);
    return { ok: true, email: d.email };
  }

  return { ok: false, error: res?.error || 'Invalid license key. Check your purchase email.' };
}

async function silentValidate() {
  const d = read();
  if (!d.licenseKey) return false;
  try {
    const res = await apiPost('/api/validate', { key: d.licenseKey });
    return res?.ok === true;
  } catch {
    return true; // offline — trust cached key
  }
}

function getStatus() {
  const d       = read();
  const elapsed = trialDaysElapsed();
  const daysLeft = Math.max(0, TRIAL_DAYS - elapsed);

  if (d.licenseKey) {
    return { licensed: true, email: d.email || '', trialExpired: false, daysLeft: 0, trialStart: d.trialStart };
  }
  return {
    licensed:     false,
    trialExpired: elapsed >= TRIAL_DAYS,
    daysLeft,
    email:        '',
    trialStart:   d.trialStart,
  };
}

module.exports = { activate, silentValidate, getStatus, TRIAL_DAYS };
