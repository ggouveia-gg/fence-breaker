/**
 * RTMPDelayServer — segment buffer + multi-platform
 *
 * Architecture:
 *   OBS → NodeMediaServer → Writer FFmpeg → 1-sec .ts segments on disk
 *                                         → Reader FFmpeg → tee → platforms
 *
 * The writer NEVER stops while OBS is connected.
 * Changing delay only restarts the reader (seeks to a different point in the
 * buffer), causing a ~300ms gap instead of a full stream reconnect.
 *
 * Buffer: 600 × 1s segments = 10 minutes max delay.
 */

const NodeMediaServer = require('node-media-server');
const { spawn }       = require('child_process');
const EventEmitter    = require('events');
const fs              = require('fs');
const path            = require('path');
const os              = require('os');

const SEG_DURATION = 1;    // seconds per segment
const MAX_SEGS     = 600;  // 10-minute rolling buffer

class RTMPDelayServer extends EventEmitter {
  constructor (ffmpegPath) {
    super();
    this.bin          = ffmpegPath;
    this.delayMs      = 0;
    this.destinations = [];
    this.isReceiving  = false;
    this.isRelaying   = false;

    this.nms            = null;
    this.writer         = null;
    this.reader         = null;
    this.obsStreamPath  = '';
    this.readerRetry    = null;

    // Segment tracking
    this.segDir      = path.join(os.tmpdir(), `fb_buf_${process.pid}`);
    this.segLog      = [];   // [{ fileIdx, createdAt }] newest at end
    this.latestFile  = -1;   // file index of most recent segment (0-599)
    this.pollTimer   = null;

    // Playlist
    this.m3u8Path        = path.join(this.segDir, 'live.m3u8');
    this.playlistTimer   = null;
    this.playlistLastIdx = -1;  // last fileIdx written to playlist

    this.DEST = {
      twitch:   'rtmp://live.twitch.tv/app',
      youtube:  'rtmp://a.rtmp.youtube.com/live2',
      kick:     'rtmp://fa723fc1b171.global-contribute.live-video.net/app',
      facebook: 'rtmps://live-api-s.facebook.com:443/rtmp',
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _segFile (fileIdx) {
    return path.join(this.segDir, `seg${String(fileIdx).padStart(5, '0')}.ts`);
  }

  _fwd (p) { return p.replace(/\\/g, '/'); }

  _buildUrl (dest) {
    const base = this.DEST[dest.platform];
    return base ? `${base}/${dest.key}` : dest.key;
  }

  // ── RTMP server ────────────────────────────────────────────────────────────

  start () {
    fs.mkdirSync(this.segDir, { recursive: true });

    this.nms = new NodeMediaServer({
      rtmp: { port: 1935, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 },
      logType: 0,
    });

    this.nms.on('prePublish', (id, sp) => {
      if (this.isReceiving) return;
      this.obsStreamPath = sp;
      this.isReceiving   = true;
      this.emit('log', 'ok', `OBS connected: ${sp}`);
      this.emit('connected');
      this._startWriter();
    });

    this.nms.on('donePublish', (id, sp) => {
      if (sp !== this.obsStreamPath) return;
      this.emit('log', 'warn', 'OBS disconnected');
      this.isReceiving = false;
      this._stopReader();
      this._stopWriter();
      this.emit('disconnected');
    });

    this.nms.run();
    this.emit('log', 'ok', 'RTMP server on port 1935');
  }

  // ── Writer (records buffer to disk) ───────────────────────────────────────

  _startWriter () {
    this._stopWriter();
    this.segLog     = [];
    this.latestFile = -1;
    this._cleanDir();

    const args = [
      '-loglevel', 'warning',
      '-i', `rtmp://127.0.0.1:1935${this.obsStreamPath}`,
      '-c', 'copy',
      '-f', 'segment',
      '-segment_time',   String(SEG_DURATION),
      '-segment_wrap',   String(MAX_SEGS),
      '-segment_format', 'mpegts',
      path.join(this.segDir, 'seg%05d.ts'),
    ];

    this.writer = spawn(this.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.emit('log', 'ok', 'Buffer recording started');

    this.writer.stderr.on('data', d => {
      const m = d.toString().trim();
      if (m) this.emit('log', 'warn', `buf: ${m.slice(0, 100)}`);
    });

    this.writer.on('close', code => {
      this.emit('log', 'warn', `Buffer closed (${code})`);
      if (this.isReceiving) setTimeout(() => this._startWriter(), 1000);
    });

    // Poll for new segment files
    this.pollTimer = setInterval(() => this._pollSegs(), 300);

    // Start reader once we have enough buffer
    const delaySec  = Math.floor(this.delayMs / 1000);
    const waitSec   = Math.max(delaySec + 2, 3);
    setTimeout(() => {
      if (this.isReceiving && this.destinations.length > 0) {
        this._startReader();
      }
    }, waitSec * 1000);
  }

  _stopWriter () {
    if (this.pollTimer)  { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.writer)     { this.writer.kill('SIGKILL'); this.writer = null; }
  }

  _pollSegs () {
    try {
      const files = fs.readdirSync(this.segDir)
        .filter(f => /^seg\d{5}\.ts$/.test(f));

      for (const f of files) {
        const fileIdx = parseInt(f.replace('seg', '').replace('.ts', ''), 10);
        if (!this.segLog.find(e => e.fileIdx === fileIdx)) {
          this.segLog.push({ fileIdx, createdAt: Date.now() });
          this.latestFile = fileIdx;
        }
      }

      // Keep log bounded
      if (this.segLog.length > MAX_SEGS) {
        this.segLog = this.segLog.slice(-MAX_SEGS);
      }
    } catch {}
  }

  _cleanDir () {
    try {
      fs.readdirSync(this.segDir)
        .filter(f => f.endsWith('.ts') || f.endsWith('.m3u8'))
        .forEach(f => { try { fs.unlinkSync(path.join(this.segDir, f)); } catch {} });
    } catch {}
  }

  // ── Reader (reads buffer, relays to platforms) ─────────────────────────────

  _segAtDelay (delaySec) {
    if (this.segLog.length === 0) return null;
    const target = Date.now() - delaySec * 1000;
    let best = null, bestDiff = Infinity;
    for (const e of this.segLog) {
      const d = Math.abs(e.createdAt - target);
      if (d < bestDiff) { bestDiff = d; best = e; }
    }
    return best;
  }

  _writePlaylist (startEntry) {
    const pos = this.segLog.findIndex(e => e.fileIdx === startEntry.fileIdx);
    if (pos < 0) return false;

    const entries = this.segLog.slice(pos);
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${SEG_DURATION}`,
      `#EXT-X-MEDIA-SEQUENCE:${startEntry.fileIdx}`,
    ];

    for (const e of entries) {
      const f = this._segFile(e.fileIdx);
      if (fs.existsSync(f)) {
        lines.push(`#EXTINF:${SEG_DURATION}.0,`);
        lines.push(this._fwd(f));
      }
    }

    fs.writeFileSync(this.m3u8Path, lines.join('\n') + '\n', 'utf8');
    this.playlistLastIdx = entries.length
      ? entries[entries.length - 1].fileIdx
      : startEntry.fileIdx;
    return true;
  }

  _startPlaylistUpdater () {
    if (this.playlistTimer) clearInterval(this.playlistTimer);

    this.playlistTimer = setInterval(() => {
      if (this.latestFile <= this.playlistLastIdx) return;
      try {
        const newEntries = this.segLog.filter(e => e.fileIdx > this.playlistLastIdx);
        let append = '';
        for (const e of newEntries) {
          const f = this._segFile(e.fileIdx);
          if (fs.existsSync(f)) {
            append += `#EXTINF:${SEG_DURATION}.0,\n${this._fwd(f)}\n`;
          }
        }
        if (append) {
          fs.appendFileSync(this.m3u8Path, append, 'utf8');
          this.playlistLastIdx = newEntries[newEntries.length - 1].fileIdx;
        }
      } catch {}
    }, 300);
  }

  _stopPlaylistUpdater () {
    if (this.playlistTimer) { clearInterval(this.playlistTimer); this.playlistTimer = null; }
  }

  _startReader () {
    this._stopReader();
    if (!this.isReceiving || this.destinations.length === 0) return;

    const delaySec   = Math.floor(this.delayMs / 1000);
    const startEntry = this._segAtDelay(delaySec);

    if (!startEntry) {
      this.emit('log', 'warn', 'Buffer not ready, retrying...');
      this.readerRetry = setTimeout(() => this._startReader(), 1000);
      return;
    }

    if (!this._writePlaylist(startEntry)) {
      this.emit('log', 'warn', 'Playlist error, retrying...');
      this.readerRetry = setTimeout(() => this._startReader(), 1000);
      return;
    }

    this._startPlaylistUpdater();

    const urls  = this.destinations.map(d => this._buildUrl(d));
    const names = this.destinations.map(d => d.platform).join(', ');
    this.emit('log', 'ok', `Relay: delay=${delaySec}s → ${names}`);

    const args = [
      '-loglevel', 'warning',
      '-re',
      '-i', this._fwd(this.m3u8Path),
      '-c', 'copy',
    ];

    if (urls.length === 1) {
      args.push('-f', 'flv', urls[0]);
    } else {
      const tee = urls.map(u => `[f=flv:onfail=ignore]${u}`).join('|');
      args.push('-f', 'tee', tee);
    }

    this.reader = spawn(this.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let started = false;
    this.reader.stderr.on('data', d => {
      const m = d.toString();
      if (!started && m.includes('frame=')) {
        started = true;
        this.isRelaying = true;
        this.emit('relaying');
        this.emit('log', 'ok', `LIVE! delay=${delaySec}s → ${names}`);
      }
      if (m.trim()) this.emit('log', 'warn', `relay: ${m.slice(0, 120).trim()}`);
    });

    this.reader.on('close', code => {
      started = false;
      this.isRelaying = false;
      this._stopPlaylistUpdater();
      this.emit('log', 'warn', `Relay closed (${code})`);
      if (this.isReceiving && this.destinations.length > 0 && code !== null && code !== 255) {
        this.readerRetry = setTimeout(() => this._startReader(), 2000);
      }
    });
  }

  _stopReader () {
    this._stopPlaylistUpdater();
    if (this.readerRetry) { clearTimeout(this.readerRetry); this.readerRetry = null; }
    if (this.reader)      { this.reader.kill('SIGKILL'); this.reader = null; }
    this.isRelaying = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setDestinations (list) {
    this.destinations = list
      .filter(d => d.key && d.key.trim())
      .map(d => ({ platform: d.platform, key: d.key.trim() }));

    const names = this.destinations.map(d => d.platform).join(', ') || 'none';
    this.emit('log', 'ok', `Destinations: ${names}`);
    this.emit('destinations-updated', this.destinations.map(d => d.platform));

    if (this.isReceiving) {
      this._stopReader();
      if (this.destinations.length > 0) setTimeout(() => this._startReader(), 500);
    }
  }

  setDelay (seconds) {
    this.delayMs = Math.max(0, Math.min(500, seconds)) * 1000;
    this.emit('log', 'ok', `Delay → ${seconds}s (restarting relay...)`);
    this.emit('delay-updated', seconds);

    if (this.isReceiving && this.destinations.length > 0) {
      // Only the reader restarts — writer keeps recording, OBS stays connected
      this._stopReader();
      setTimeout(() => this._startReader(), 200);
    }
  }

  stop () {
    this._stopReader();
    this._stopWriter();
    if (this.nms) this.nms.stop();
  }
}

module.exports = RTMPDelayServer;
