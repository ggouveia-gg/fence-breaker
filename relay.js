'use strict';
/**
 * relay.js — FenceBreaker professional relay engine
 *
 * Architecture:
 *   OBS → NodeMediaServer (:1935 RTMP)
 *       → HTTP-FLV subscriber (:8000) parses FLV tags → in-memory buffer
 *       → Send loop writes FLV tags to N FFmpeg processes (one per destination)
 *       → Each FFmpeg re-encodes and streams to its platform independently
 *
 * KEY POINTS:
 *   - One FFmpeg process per destination — a failing platform never kills others.
 *   - Delay change = seek the buffer + re-anchor DTS (FFmpeg never restarts).
 *   - DTS is shared across all encoders (same packets, same order).
 *   - Failed encoder auto-retries after 5 s without touching other encoders.
 */

const NodeMediaServer = require('node-media-server');
const { spawn }       = require('child_process');
const EventEmitter    = require('events');
const http            = require('http');

const MAX_BUFFER_MS  = 300_000; // 5-minute rolling buffer
const FRAME_MS       = 33;      // ~30fps frame interval in ms
const RETRY_DELAY_MS = 30_000;  // retry a failed encoder after 30 s

// ── FLV utilities ─────────────────────────────────────────────────────────────

const TAG_AUDIO  = 0x08;
const TAG_VIDEO  = 0x09;
const TAG_SCRIPT = 0x12;

const FLV_HEADER = Buffer.from([
  0x46, 0x4c, 0x56, 0x01, 0x05,
  0x00, 0x00, 0x00, 0x09,
  0x00, 0x00, 0x00, 0x00,
]);

function mkFLVTag(type, data, dts) {
  const sz  = data.length;
  const buf = Buffer.allocUnsafe(11 + sz + 4);
  buf[0] = type;
  buf[1] = (sz >> 16) & 0xFF;
  buf[2] = (sz >> 8)  & 0xFF;
  buf[3] =  sz        & 0xFF;
  buf[4] = (dts >> 16) & 0xFF;
  buf[5] = (dts >> 8)  & 0xFF;
  buf[6] =  dts        & 0xFF;
  buf[7] = (dts >> 24) & 0xFF;
  buf[8] = buf[9] = buf[10] = 0;
  data.copy(buf, 11);
  const pts = 11 + sz;
  buf[pts]   = (pts >> 24) & 0xFF;
  buf[pts+1] = (pts >> 16) & 0xFF;
  buf[pts+2] = (pts >> 8)  & 0xFF;
  buf[pts+3] =  pts        & 0xFF;
  return buf;
}

function isVideoKeyFrame(data)  { return data.length > 0 && (data[0] & 0xF0) === 0x10; }
function isVideoSeqHeader(data) { return data.length > 1 && data[0] === 0x17 && data[1] === 0x00; }
function isAudioSeqHeader(data) { return data.length > 1 && data[0] === 0xAF && data[1] === 0x00; }

function parseFLVStream(res, onTag) {
  let buf          = Buffer.alloc(0);
  let headerParsed = false;

  res.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (!headerParsed) {
      if (buf.length < 13) return;
      buf = buf.slice(13);
      headerParsed = true;
    }
    while (buf.length >= 11) {
      const type = buf[0];
      const sz   = buf.readUIntBE(1, 3);
      if (buf.length < 11 + sz + 4) break;
      const dts  = (buf.readUIntBE(4, 3)) | (buf[7] << 24);
      const data = Buffer.from(buf.slice(11, 11 + sz));
      buf = buf.slice(11 + sz + 4);
      if (type === TAG_AUDIO || type === TAG_VIDEO || type === TAG_SCRIPT) {
        onTag({ type, data, dts });
      }
    }
  });
}

// ── FFmpeg / URL helpers ───────────────────────────────────────────────────────

function findFFmpeg() {
  const fs = require('fs');
  for (const c of ['C:/stream-delay/ffmpeg/bin/ffmpeg.exe', 'C:/ffmpeg/bin/ffmpeg.exe', 'ffmpeg']) {
    try { fs.accessSync(c); return c; } catch {}
  }
  return 'ffmpeg';
}

function buildURL(platform, key) {
  const k = (key || '').trim();
  if (!k) return '';
  const bases = {
    twitch:   'rtmp://live.twitch.tv/app',
    youtube:  'rtmp://a.rtmp.youtube.com/live2',
    kick:     'rtmps://fa723fc1b171.global-contribute.live-video.net/app',
    facebook: 'rtmps://live-api-s.facebook.com:443/rtmp',
  };
  const base = bases[(platform || '').toLowerCase()];
  return base ? `${base}/${k}` : k; // custom = key is already full URL
}

// ── Encoder profiles + detection ──────────────────────────────────────────────

// codec → name mapping (for detection only; args are built dynamically)
const ENCODER_PROFILES = [
  { name: 'NVENC', codec: 'h264_nvenc' },
  { name: 'AMF',   codec: 'h264_amf'   },
  { name: 'QSV',   codec: 'h264_qsv'   },
  { name: 'x264',  codec: 'libx264'     },
];

// Build video+audio FFmpeg args dynamically from current settings.
// fps=0 → no -r flag (passthrough input framerate — warn user: platforms cap at 60/120).
function makeEncoderArgs(codec, bitrateKbps, fps) {
  const bv      = `${bitrateKbps}k`;
  const buf     = `${bitrateKbps * 2}k`;
  const gop     = fps > 0 ? fps * 2 : 120;
  const kfi     = fps > 0 ? fps     :  60;
  const rateArg = fps > 0 ? ['-r', String(fps)] : [];
  const audioArgs = ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'];

  if (codec === 'h264_nvenc') return [
    '-c:v', 'h264_nvenc', '-preset', 'p2', '-tune', 'll',
    '-rc', 'vbr', '-b:v', bv, '-maxrate', bv, '-bufsize', buf,
    '-profile:v', 'main', '-bf', '0',
    ...rateArg, '-g', String(gop), '-keyint_min', String(kfi),
    ...audioArgs,
  ];
  if (codec === 'h264_amf') return [
    '-c:v', 'h264_amf', '-quality', 'speed',
    '-b:v', bv, '-maxrate', bv, '-bufsize', buf,
    '-profile:v', 'main', '-bf', '0',
    ...rateArg, '-g', String(gop), '-keyint_min', String(kfi),
    ...audioArgs,
  ];
  if (codec === 'h264_qsv') return [
    '-c:v', 'h264_qsv', '-preset', 'veryfast',
    '-b:v', bv, '-maxrate', bv, '-bufsize', buf,
    '-profile:v', 'main', '-bf', '0',
    ...rateArg, '-g', String(gop), '-keyint_min', String(kfi),
    ...audioArgs,
  ];
  // libx264 fallback
  return [
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-profile:v', 'main', '-bf', '0',
    '-b:v', bv, '-maxrate', bv, '-bufsize', buf,
    ...rateArg, '-g', String(gop), '-keyint_min', String(kfi),
    ...audioArgs,
  ];
}

function testEncoderAvailable(ffmpegPath, codec) {
  return new Promise(resolve => {
    const args = [
      '-f', 'lavfi', '-i', 'color=black:s=128x72:r=30',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-c:v', codec, '-c:a', 'aac',
      '-frames:v', '10',
      '-f', 'null', '-',
    ];
    const proc = spawn(ffmpegPath, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(false); }, 8000);
    proc.on('close', code => { clearTimeout(timer); resolve(code === 0); });
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

async function detectBestEncoder(ffmpegPath) {
  for (const profile of ENCODER_PROFILES) {
    const ok = await testEncoderAvailable(ffmpegPath, profile.codec);
    if (ok) return profile;
  }
  return ENCODER_PROFILES[ENCODER_PROFILES.length - 1];
}

// ── Main Relay class ───────────────────────────────────────────────────────────

class Relay extends EventEmitter {
  constructor() {
    super();
    this.ffmpeg       = findFFmpeg();
    this.destinations = [];
    this.delayMs      = 0;
    this.isReceiving  = false;

    // In-memory packet buffer
    this.buffer       = [];
    this.videoHeader  = null;
    this.audioHeader  = null;
    this.metaTag      = null;

    // One encoder per destination: Map<platform, { proc, stdin, ready, retryTimer }>
    this.encoders     = new Map();

    // Shared DTS state (all encoders receive identical packets in order)
    this.dtsOffset    = 0;
    this.lastOutDts   = -1;

    // Send loop
    this.bufIdx       = 0;
    this.loopTimer    = null;

    // Video quality settings (user-configurable)
    this.videoSettings = { bitrateKbps: 6000, fps: 60 };

    // Hardware encoder detection (async, resolves before OBS connects in practice)
    this.encoderProfile  = null;
    this.encoderName     = 'detecting';
    this._encoderReady   = detectBestEncoder(this.ffmpeg).then(profile => {
      this.encoderProfile = profile;
      this.encoderName    = profile.name;
      this._log('ok', `Encoder: ${profile.name} (${profile.codec})`);
      this.emit('encoder-detected', profile.name);
    });
  }

  get encoderReady() {
    return [...this.encoders.values()].some(e => e.ready);
  }

  // ── RTMP + HTTP-FLV server ───────────────────────────────────────────────────

  startRTMP() {
    const nms = new NodeMediaServer({
      rtmp: { port: 1935, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 },
      http: { port: 8000, allow_origin: '*' },
      logType: 0,
    });

    nms.on('prePublish', (id, sp) => {
      if (this.isReceiving) return;
      this.isReceiving = true;
      this._log('ok', `OBS connected: ${sp}`);
      this.emit('connected');
      setTimeout(() => this._subscribeHTTPFlv(sp), 500);
    });

    nms.on('donePublish', () => {
      this._log('warn', 'OBS disconnected');
      this.isReceiving = false;
      this._stopLoop();
      this._stopAllEncoders();
      this.buffer = [];
      this.emit('disconnected');
    });

    nms.run();
    this._log('ok', 'RTMP :1935  HTTP-FLV :8000');
  }

  // ── HTTP-FLV subscription ────────────────────────────────────────────────────

  _subscribeHTTPFlv(streamPath) {
    const url = `http://127.0.0.1:8000${streamPath}.flv`;
    this._log('ok', `Subscribing HTTP-FLV: ${url}`);

    const req = http.get(url, res => {
      if (res.statusCode !== 200) {
        this._log('warn', `HTTP-FLV ${res.statusCode} — retry in 1s`);
        setTimeout(() => this._subscribeHTTPFlv(streamPath), 1000);
        return;
      }
      parseFLVStream(res, tag => this._onTag(tag));
      res.on('end', () => {
        if (this.isReceiving) {
          this._log('warn', 'HTTP-FLV ended — retrying');
          setTimeout(() => this._subscribeHTTPFlv(streamPath), 500);
        }
      });
    });

    req.on('error', () => setTimeout(() => this._subscribeHTTPFlv(streamPath), 500));
  }

  _onTag(tag) {
    const wallTime = Date.now();

    if (tag.type === TAG_SCRIPT) {
      this.metaTag = tag;
    } else if (tag.type === TAG_VIDEO && isVideoSeqHeader(tag.data)) {
      this.videoHeader = tag;
    } else if (tag.type === TAG_AUDIO && isAudioSeqHeader(tag.data)) {
      this.audioHeader = tag;
    }

    this.buffer.push({
      type:       tag.type,
      data:       tag.data,
      dts:        tag.dts,
      wallTime,
      isKeyFrame: tag.type === TAG_VIDEO && isVideoKeyFrame(tag.data),
      isHeader:   (tag.type === TAG_VIDEO && isVideoSeqHeader(tag.data)) ||
                  (tag.type === TAG_AUDIO && isAudioSeqHeader(tag.data)) ||
                  tag.type === TAG_SCRIPT,
    });

    const cutoff = Date.now() - MAX_BUFFER_MS;
    while (this.buffer.length > 0 && this.buffer[0].wallTime < cutoff) {
      this.buffer.shift();
      if (this.bufIdx > 0) this.bufIdx--;
    }

    // Auto-start encoders once codec headers are available
    if (this.encoders.size === 0 && this.videoHeader && this.audioHeader && this.destinations.length > 0) {
      this._maybeStartEncoders();
    }
  }

  // ── Per-destination FFmpeg encoder ───────────────────────────────────────────

  _maybeStartEncoders() {
    if (!this.encoderProfile) {
      // Detection still running — retry when done
      this._encoderReady.then(() => this._maybeStartEncoders());
      return;
    }
    if (!this.isReceiving || !this.videoHeader || !this.audioHeader) return;
    for (const dest of this.destinations) {
      if (!this.encoders.has(dest.platform)) {
        this._startOneEncoder(dest);
      }
    }
    if (!this.loopTimer && this.encoderReady) {
      this._seekToDelay();
      this._startLoop();
    }
  }

  _startOneEncoder(dest) {
    const url = buildURL(dest.platform, dest.key);
    if (!url) return;

    const state = { proc: null, stdin: null, ready: false, retryTimer: null };
    this.encoders.set(dest.platform, state);

    const args = [
      '-loglevel', 'warning',
      '-f', 'flv', '-i', 'pipe:0',
      ...makeEncoderArgs(this.encoderProfile.codec, this.videoSettings.bitrateKbps, this.videoSettings.fps),
      '-f', 'flv', url,
    ];

    const proc = spawn(this.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    state.proc  = proc;
    state.stdin = proc.stdin;
    state.ready = true;

    // Suppress EPIPE errors — encoder closing mid-write must not crash the relay
    proc.stdin.on('error', () => { state.ready = false; });

    proc.stderr.on('data', d => {
      const m = d.toString().trim();
      if (!m) return;
      if (m.includes('frame=')) { this.emit('relaying'); return; }
      this._log('warn', `[${dest.platform}] ${m}`);
      this.emit('destination-error', { platform: dest.platform, msg: m });
    });

    proc.on('close', code => {
      this._log('warn', `[${dest.platform}] encoder closed (${code})`);
      state.ready = false;
      state.proc  = null;
      state.stdin = null;

      // Stop loop only if ALL encoders died
      if (!this.encoderReady) {
        this._stopLoop();
        this.emit('relay-stopped');
      }

      // Auto-retry if destination still in list and OBS still connected
      const stillDest = this.destinations.find(d => d.platform === dest.platform);
      if (stillDest && this.isReceiving) {
        this._log('ok', `[${dest.platform}] retry in ${RETRY_DELAY_MS / 1000}s`);
        state.retryTimer = setTimeout(() => {
          if (this.destinations.find(d => d.platform === dest.platform)) {
            this.encoders.delete(dest.platform);
            this._startOneEncoder(stillDest);
            // Re-start loop if it had stopped
            if (!this.loopTimer && this.encoderReady) {
              this._seekToDelay();
              this._startLoop();
            }
          }
        }, RETRY_DELAY_MS);
      } else {
        this.encoders.delete(dest.platform);
      }
    });

    // Write FLV header
    proc.stdin.write(FLV_HEADER);

    // If loop is already running (mid-stream restart), send codec headers now
    // so the encoder can decode incoming packets from current bufIdx onward
    if (this.loopTimer) {
      const hDts = Math.max(0, this.lastOutDts);
      if (this.metaTag)     this._writeTagToEnc(state, this.metaTag,     hDts);
      if (this.videoHeader) this._writeTagToEnc(state, this.videoHeader, hDts);
      if (this.audioHeader) this._writeTagToEnc(state, this.audioHeader, hDts);
    }

    this._log('ok', `[${dest.platform}] encoder started → ${url.slice(0, 50)}`);
    this.emit('destinations-updated', this.destinations.map(d => d.platform));
  }

  _stopOneEncoder(platform) {
    const state = this.encoders.get(platform);
    if (!state) return;
    clearTimeout(state.retryTimer);
    if (state.stdin) { try { state.stdin.end(); } catch {} }
    if (state.proc)  { try { state.proc.kill('SIGKILL'); } catch {} }
    this.encoders.delete(platform);
  }

  _stopAllEncoders() {
    this._stopLoop();
    for (const platform of [...this.encoders.keys()]) {
      this._stopOneEncoder(platform);
    }
  }

  // ── Delay seek ───────────────────────────────────────────────────────────────

  _seekToDelay() {
    if (!this.buffer.length) return;

    const targetWall = Date.now() - this.delayMs;
    let idx = -1;

    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i].wallTime >= targetWall && this.buffer[i].isKeyFrame) {
        idx = i; break;
      }
    }
    if (idx < 0) {
      for (let i = this.buffer.length - 1; i >= 0; i--) {
        if (this.buffer[i].isKeyFrame) { idx = i; break; }
      }
    }
    if (idx < 0) idx = this.buffer.length - 1;

    // Send codec headers to ALL ready encoders
    const headerDts = Math.max(0, this.lastOutDts);
    if (this.metaTag)     this._writeTagToAll(this.metaTag,     headerDts);
    if (this.videoHeader) this._writeTagToAll(this.videoHeader, headerDts);
    if (this.audioHeader) this._writeTagToAll(this.audioHeader, headerDts);

    const firstDts = this.buffer[idx].dts;
    const nextDts  = this.lastOutDts < 0 ? 0 : this.lastOutDts + FRAME_MS;
    this.dtsOffset = nextDts - firstDts;
    this.bufIdx    = idx;

    this._log('ok', `Seeked buf[${idx}] delay=${this.delayMs / 1000}s`);
  }

  // ── Send loop ────────────────────────────────────────────────────────────────

  _startLoop() { this._stopLoop(); this._tick(); }

  _stopLoop() {
    if (this.loopTimer) { clearTimeout(this.loopTimer); this.loopTimer = null; }
  }

  _tick() {
    const now = Date.now();

    while (this.bufIdx < this.buffer.length) {
      const tag = this.buffer[this.bufIdx];
      if (tag.isHeader)                         { this.bufIdx++; continue; }
      if (tag.wallTime + this.delayMs > now)    break;
      this._writeTagToAll(tag, -1);
      this.bufIdx++;
    }

    const nextTag = this.buffer[this.bufIdx];
    const wait    = nextTag ? Math.min(Math.max(1, (nextTag.wallTime + this.delayMs) - Date.now()), 20) : 5;
    this.loopTimer = setTimeout(() => this._tick(), wait);
  }

  // ── Write helpers ─────────────────────────────────────────────────────────────

  // Write to all ready encoders (advances shared DTS)
  _writeTagToAll(tag, forceDts) {
    let outDts = forceDts >= 0 ? forceDts : tag.dts + this.dtsOffset;
    if (outDts <= this.lastOutDts) outDts = this.lastOutDts + 1;

    const buf = mkFLVTag(tag.type, tag.data, outDts);
    for (const state of this.encoders.values()) {
      if (state.ready && state.stdin && !state.stdin.destroyed) {
        try { state.stdin.write(buf); } catch {}
      }
    }
    this.lastOutDts = outDts;
  }

  // Write to a single encoder (mid-stream codec header injection, no DTS advance)
  _writeTagToEnc(state, tag, dts) {
    if (!state.ready || !state.stdin || state.stdin.destroyed) return;
    try { state.stdin.write(mkFLVTag(tag.type, tag.data, dts)); } catch {}
  }

  // ── Public control API ────────────────────────────────────────────────────────

  setDelay(seconds) {
    const newMs = Math.max(0, Math.min(300, seconds)) * 1000;
    const bufSec = this._bufferDurationSec();

    if (seconds > 0 && bufSec < seconds + 3) {
      this._log('warn', `Buffer ${bufSec}s < ${seconds + 3}s needed — waiting`);
      this.delayMs = newMs;
      this.emit('delay-updated', seconds);
      clearTimeout(this._delayRetry);
      this._delayRetry = setTimeout(() => this.setDelay(seconds), 1000);
      return;
    }

    clearTimeout(this._delayRetry);
    this.delayMs = newMs;
    this._log('ok', `Delay → ${seconds}s`);
    this.emit('delay-updated', seconds);

    if (this.encoderReady) {
      this._stopLoop();
      this._seekToDelay();
      this._startLoop();
    }
  }

  setDestinations(list) {
    const newDests    = (list || []).filter(d => (d.key || '').trim());
    const newPlatforms = new Set(newDests.map(d => d.platform));

    // Stop encoders for removed destinations
    for (const p of [...this.encoders.keys()]) {
      if (!newPlatforms.has(p)) this._stopOneEncoder(p);
    }

    this.destinations = newDests;

    // Start encoders for new destinations (if OBS connected and headers ready)
    if (this.isReceiving && this.videoHeader && this.audioHeader) {
      this._maybeStartEncoders();
    }

    const names = newDests.map(d => d.platform);
    this._log('ok', `Destinations → ${names.join(', ') || 'none'}`);
    this.emit('destinations-updated', names);
  }

  setVideoSettings({ bitrateKbps, fps }) {
    const newBitrate = Math.max(1000, Math.min(60000, Number(bitrateKbps) || 6000));
    const newFps     = [0, 30, 60, 120, 240].includes(Number(fps)) ? Number(fps) : 60;

    const changed = newBitrate !== this.videoSettings.bitrateKbps || newFps !== this.videoSettings.fps;
    this.videoSettings = { bitrateKbps: newBitrate, fps: newFps };

    const fpsLabel = newFps === 0 ? 'passthrough' : `${newFps}fps`;
    this._log('ok', `Video: ${newBitrate}kbps ${fpsLabel}`);
    this.emit('video-settings-updated', this.videoSettings);

    // Restart encoders with new settings if they're running
    if (changed && this.encoderReady) {
      this._restartAllEncoders();
    }
  }

  _restartAllEncoders() {
    const platforms = [...this.encoders.keys()];
    this._stopAllEncoders();
    // Start encoders first so _seekToDelay can deliver codec headers to them
    for (const dest of this.destinations.filter(d => platforms.includes(d.platform))) {
      this._startOneEncoder(dest);
    }
    if (this.encoderReady) {
      this._seekToDelay();
      this._startLoop();
    }
  }

  getStatus() {
    return {
      isReceiving:  this.isReceiving,
      isRelaying:   this.encoderReady,
      delay:        this.delayMs / 1000,
      destinations: this.destinations.map(d => d.platform),
      bufferSecs:   this._bufferDurationSec(),
      encoder:       this.encoderName,
      videoSettings: this.videoSettings,
    };
  }

  _bufferDurationSec() {
    if (this.buffer.length < 2) return 0;
    return Math.round((this.buffer[this.buffer.length - 1].wallTime - this.buffer[0].wallTime) / 1000);
  }

  _log(type, msg) {
    const ts = new Date().toTimeString().slice(0, 8);
    process.stdout.write(`[${ts}][${type}] ${msg}\n`);
    this.emit('log', { type, msg });
  }
}

// ── HTTP API (:9191) ──────────────────────────────────────────────────────────

function startAPI(relay) {
  const clients = new Set();

  function broadcast(evt) {
    const d = `data: ${JSON.stringify(evt)}\n\n`;
    for (const r of clients) { try { r.write(d); } catch { clients.delete(r); } }
  }

  ['connected','disconnected','relaying','relay-stopped'].forEach(t =>
    relay.on(t, () => broadcast({ type: t })));
  relay.on('delay-updated',        s => broadcast({ type: 'delay-updated', data: s }));
  relay.on('destinations-updated', n => broadcast({ type: 'destinations-updated', data: n }));
  relay.on('destination-error',    d => broadcast({ type: 'destination-error', data: d }));
  relay.on('encoder-detected',       n => broadcast({ type: 'encoder-detected', data: n }));
  relay.on('video-settings-updated', s => broadcast({ type: 'video-settings-updated', data: s }));
  relay.on('log',                    d => broadcast({ type: 'log', data: d }));

  const srv = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(relay.getStatus()));
    }

    if (req.url === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      clients.add(res);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { clearInterval(hb); } }, 5000);
      req.on('close', () => { clients.delete(res); clearInterval(hb); });
      return;
    }

    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      try {
        const data = JSON.parse(body || '{}');
        if (req.url === '/api/delay')          relay.setDelay(Number(data.seconds) || 0);
        if (req.url === '/api/destinations')   relay.setDestinations(Array.isArray(data) ? data : []);
        if (req.url === '/api/video-settings') relay.setVideoSettings(data);
      } catch (e) { relay._log('warn', `parse err: ${e.message}`); }
    });
  });

  srv.listen(9191, '127.0.0.1', () => relay._log('ok', 'API :9191'));
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

process.on('uncaughtException',  e => process.stdout.write(`[ERR] ${e.stack}\n`));
process.on('unhandledRejection', e => process.stdout.write(`[REJ] ${e}\n`));

const relay = new Relay();
relay.startRTMP();
startAPI(relay);
process.stdout.write('READY\n');
