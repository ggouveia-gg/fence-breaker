const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Relay control
  setDestinations:      (list) => ipcRenderer.invoke('set-destinations', list),
  setDelay:             (o)    => ipcRenderer.invoke('set-delay', o),
  getStatus:            ()     => ipcRenderer.invoke('get-status'),

  // Stream events
  onStreamEvent:        (cb) => ipcRenderer.on('stream-event',        (_, d) => cb(d)),
  onDelayUpdated:       (cb) => ipcRenderer.on('delay-updated',       (_, d) => cb(d)),
  onDestinationsUpdated:(cb) => ipcRenderer.on('destinations-updated',(_, d) => cb(d)),
  onTimerUpdate:        (cb) => ipcRenderer.on('timer-update',        (_, d) => cb(d)),
  onDestinationError:   (cb) => ipcRenderer.on('destination-error',   (_, d) => cb(d)),
  onFbLog:              (cb) => ipcRenderer.on('fb-log',              (_, d) => cb(d)),

  // License
  getLicenseStatus:     ()    => ipcRenderer.invoke('get-license-status'),
  activateLicense:      (key) => ipcRenderer.invoke('activate-license', key),
  startTrial:           ()    => ipcRenderer.send('start-trial'),
  activationDone:       ()    => ipcRenderer.send('activation-done'),
  openBuyPage:          ()    => ipcRenderer.send('open-buy-page'),
  onLicenseStatus:      (cb)  => ipcRenderer.on('license-status', (_, d) => cb(d)),

  // Updater
  checkUpdate:          ()    => ipcRenderer.invoke('check-update'),
  onUpdateAvailable:    (cb)  => ipcRenderer.on('update-available', (_, d) => cb(d)),
  openUpdatePage:       (url) => ipcRenderer.send('open-update-page', url),

  // Log
  getLogPath:           ()    => ipcRenderer.invoke('get-log-path'),
  openLogFolder:        ()    => ipcRenderer.send('open-log-folder'),

  // Window
  windowMinimize:  () => ipcRenderer.send('window-minimize'),
  windowMaximize:  () => ipcRenderer.send('window-maximize'),
  windowClose:     () => ipcRenderer.send('window-close'),
});
