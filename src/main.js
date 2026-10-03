import '@fontsource/montserrat/400.css';
import '@fontsource/montserrat/500.css';
import '@fontsource/montserrat/600.css';
import { open } from '@tauri-apps/plugin-dialog';
import { Command } from '@tauri-apps/plugin-shell';
import { invoke } from '@tauri-apps/api/core';
import { availableMonitors, getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { resolveResource } from '@tauri-apps/api/path';

const AUDIO_EXTENSIONS = new Set(['mp3','wav','m4a','flac','aac','ogg','opus','wma']);
const MEDIA_EXTENSIONS = new Set(['mp4','mkv','mov','avi','webm','m4v','mp3','wav','m4a','flac','aac','ogg','opus','wma','ts','mts','m2ts']);
const IMAGE_EXTENSIONS = ['png','jpg','jpeg','webp','bmp'];
const STORAGE = {
  currentPlaylist: 'ankino.currentPlaylist',
  savedPlaylists: 'ankino.savedPlaylists',
  loopMode: 'ankino.loopMode',
  autoNext: 'ankino.autoNext',
  volume: 'ankino.volume',
  monitorIndex: 'ankino.monitorIndex'
};

const els = Object.fromEntries([
  'addFilesBtn','removeBtn','clearBtn','playlist','selectedTitle','selectedPath','previewIcon','programTitle','timeText','progress',
  'prevBtn','playBtn','stopBtn','nextBtn','monitorSelect','refreshMonitorsBtn','volume','volumeValue','autoNext','loopMode',
  'audioBgBtn','clearAudioBgBtn','audioBgName','audioDeviceSelect','refreshAudioBtn','muteBtn','blackBtn','blackMuteBtn','projectBtn','message','outputStatus','aboutBtn','aboutModal','closeAboutBtn',
  'diffusionState','screenState','modeState','qualityState','stopOutputBtn','holdingBtn','savedPlaylistSelect','savePlaylistBtn','loadPlaylistBtn','deletePlaylistBtn','dropOverlay','shortcutHint'
].map(id => [id, document.getElementById(id)]));

const mainWebview = getCurrentWebview();

let playlist = readJson(STORAGE.currentPlaylist, []);
let savedPlaylists = readJson(STORAGE.savedPlaylists, {});
let selectedIndex = playlist.length ? 0 : -1;
let programIndex = -1;
let playerChild = null;
let playerScreen = null;
let isPaused = false;
let duration = 0;
let statusTimer = null;
let audioBackgroundPath = localStorage.getItem('ankino.audioBackgroundPath') || '';
let holdingResourcePath = '';
let selectedAudioDevice = localStorage.getItem('ankino.audioDevice') || 'auto';
let muted = false;
let appClosing = false;
let missingPaths = new Set();
let statusTick = 0;
let handlingEof = false;
const mainWindow = getCurrentWindow();

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function fileName(path) {
  return path.split(/[\\/]/).pop() || path;
}

function fileExtension(path) {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isAudioPath(path) {
  return AUDIO_EXTENSIONS.has(fileExtension(path));
}

function isSupportedMedia(path) {
  return MEDIA_EXTENSIONS.has(fileExtension(path));
}

function mediaType(path) {
  return isAudioPath(path) ? 'AUDIO' : 'VIDÉO';
}

function setMessage(text, error = false) {
  els.message.textContent = text;
  els.message.classList.toggle('error', error);
}

function setOutputState(diffusion, screen, mode, quality = null) {
  els.diffusionState.textContent = diffusion;
  els.screenState.textContent = screen;
  els.modeState.textContent = mode;
  if (quality !== null) els.qualityState.textContent = quality;
}

function saveCurrentPlaylist() {
  localStorage.setItem(STORAGE.currentPlaylist, JSON.stringify(playlist));
}

function persistSettings() {
  localStorage.setItem(STORAGE.loopMode, els.loopMode.value);
  localStorage.setItem(STORAGE.autoNext, els.autoNext.checked ? '1' : '0');
  localStorage.setItem(STORAGE.volume, els.volume.value);
  localStorage.setItem(STORAGE.monitorIndex, els.monitorSelect.value || '0');
}

async function fileExists(path) {
  try {
    return await invoke('file_exists', { path });
  } catch {
    return true;
  }
}

async function validatePlaylist() {
  const checks = await Promise.all(playlist.map(async path => [path, await fileExists(path)]));
  missingPaths = new Set(checks.filter(([, exists]) => !exists).map(([path]) => path));
  renderPlaylist();
}

function renderSavedPlaylists() {
  const current = els.savedPlaylistSelect.value;
  els.savedPlaylistSelect.innerHTML = '<option value="">Playlists enregistrées</option>';
  Object.keys(savedPlaylists).sort((a,b) => a.localeCompare(b, 'fr')).forEach(name => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    els.savedPlaylistSelect.appendChild(option);
  });
  if (savedPlaylists[current]) els.savedPlaylistSelect.value = current;
}

async function ensureHoldingPath() {
  if (!holdingResourcePath) holdingResourcePath = await resolveResource('resources/holding.jpg');
  return holdingResourcePath;
}

function updateAudioBackgroundLabel() {
  els.audioBgName.textContent = audioBackgroundPath ? fileName(audioBackgroundPath) : 'Fond Ankino par défaut';
  els.audioBgName.title = audioBackgroundPath || 'Fond bleu nuit Ankino + titre du morceau';
}

function renderPlaylist() {
  if (!playlist.length) {
    els.playlist.className = 'playlist empty-state';
    els.playlist.textContent = 'Glissez vos vidéos ou MP3 ici.';
    return;
  }

  els.playlist.className = 'playlist';
  els.playlist.innerHTML = '';

  playlist.forEach((path, index) => {
    const audio = isAudioPath(path);
    const missing = missingPaths.has(path);
    const item = document.createElement('div');
    item.className = `playlist-item ${index === selectedIndex ? 'selected' : ''} ${missing ? 'missing' : ''}`;
    item.innerHTML = `
      <div class="item-index">${String(index + 1).padStart(2,'0')}</div>
      <div>
        <div class="item-mainline">
          <div class="item-name"></div>
          <span class="item-type ${audio ? 'audio' : ''}">${missing ? 'ABSENT' : (audio ? 'AUDIO' : 'VIDÉO')}</span>
        </div>
        <div class="item-path"></div>
      </div>`;
    item.querySelector('.item-name').textContent = fileName(path);
    item.querySelector('.item-path').textContent = path;
    item.addEventListener('click', () => selectIndex(index));
    item.addEventListener('dblclick', () => projectIndex(index));
    els.playlist.appendChild(item);
  });
}

function selectIndex(index) {
  selectedIndex = index;
  const path = playlist[index];

  if (!path) {
    els.previewIcon.textContent = '▶';
    els.previewIcon.classList.remove('audio');
    els.selectedTitle.textContent = 'Sélectionnez un média';
    els.selectedPath.textContent = 'Le média choisi sera envoyé vers l’écran de diffusion.';
    renderPlaylist();
    return;
  }

  const audio = isAudioPath(path);
  const missing = missingPaths.has(path);
  els.previewIcon.textContent = missing ? '!' : (audio ? '♫' : '▶');
  els.previewIcon.classList.toggle('audio', audio && !missing);
  els.selectedTitle.textContent = fileName(path);
  els.selectedPath.textContent = missing ? 'Fichier introuvable. Il a peut-être été déplacé.' : `${audio ? 'Audio' : 'Vidéo'} • ${path}`;
  renderPlaylist();
}

async function addMediaPaths(paths, sourceLabel = 'Ajout') {
  const supported = [...new Set(paths.filter(isSupportedMedia))];
  if (!supported.length) {
    setMessage('Aucun média compatible détecté.', true);
    return;
  }
  const existing = new Set(playlist);
  const added = supported.filter(path => !existing.has(path));
  playlist.push(...added);
  saveCurrentPlaylist();
  await validatePlaylist();
  if (selectedIndex < 0 && playlist.length) selectIndex(0);
  setMessage(`${sourceLabel} : ${added.length} nouveau(x) média(s).`);
}

async function refreshMonitors() {
  try {
    const monitors = await availableMonitors();
    const saved = Number(localStorage.getItem(STORAGE.monitorIndex) || 1);
    const previous = Number(els.monitorSelect.value || saved || 0);
    els.monitorSelect.innerHTML = '';

    monitors.forEach((m, index) => {
      const option = document.createElement('option');
      option.value = index;
      option.textContent = `Écran ${index + 1}${m.name ? ` • ${m.name}` : ''} (${m.size.width}×${m.size.height})`;
      els.monitorSelect.appendChild(option);
    });

    if (monitors.length > 1) els.monitorSelect.value = String(Math.min(previous || 1, monitors.length - 1));
    else els.monitorSelect.value = '0';
    localStorage.setItem(STORAGE.monitorIndex, els.monitorSelect.value);
    if (!playerChild) els.screenState.textContent = `Écran ${Number(els.monitorSelect.value) + 1} sélectionné`;

    setMessage(`${monitors.length} écran(s) détecté(s).`);
  } catch (err) {
    setMessage(`Impossible de détecter les écrans : ${err}`, true);
  }
}

async function mpv(request) {
  return await invoke('mpv_ipc', { request });
}

async function safeMpvProperty(name) {
  try {
    const response = await mpv({ command: ['get_property', name] });
    return response?.data ?? null;
  } catch {
    return null;
  }
}

async function waitForPlayer() {
  let lastError;

  for (let i = 0; i < 25; i++) {
    try {
      return await mpv({ command: ['get_property', 'idle-active'] });
    } catch (err) {
      lastError = err;
      await new Promise(r => setTimeout(r, 120));
    }
  }

  throw new Error(`La sortie vidéo ne répond pas. ${lastError || ''}`);
}

async function startOutput() {
  const screen = Number(els.monitorSelect.value || 0);
  if (playerChild && playerScreen === screen) return;

  if (playerChild) {
    try { await playerChild.kill(); } catch {}
    playerChild = null;
    await new Promise(r => setTimeout(r, 250));
  }

  const args = [
    '--no-config',
    '--idle=yes',
    '--force-window=yes',
    '--keep-open=yes',
    '--fullscreen',
    `--screen=${screen}`,
    `--fs-screen=${screen}`,
    '--osc=no',
    '--input-default-bindings=no',
    '--cursor-autohide=always',
    '--terminal=no',
    '--input-ipc-server=ankino-diffusion-mpv',
    '--background=color',
    '--background-color=#212E44',
    '--image-display-duration=inf',
    '--framedrop=vo',
    '--audio-display=no',
    '--osd-level=0',
    '--osd-color=#F8BA08',
    '--osd-outline-color=#101722',
    '--osd-outline-size=2',
    '--osd-font-size=42',
    '--osd-align-x=center',
    '--osd-align-y=center',
    '--osd-bold=yes',
    '--video-aspect-override=-1',
    '--hwdec=auto',
    `--audio-device=${selectedAudioDevice}`,
    `--mute=${muted ? 'yes' : 'no'}`,
    `--volume=${els.volume.value}`
  ];

  const command = Command.sidecar('binaries/mpv', args);

  command.on('close', () => {
    playerChild = null;
    playerScreen = null;
    els.outputStatus.classList.remove('live');
    els.outputStatus.innerHTML = '<span class="dot"></span> DIFFUSION ARRÊTÉE';
    setOutputState('ARRÊTÉE', 'Aucun', 'STOP', 'Prêt');
  });

  command.on('error', err => setMessage(`Erreur du moteur vidéo : ${err}`, true));

  playerChild = await command.spawn();
  playerScreen = screen;
  await waitForPlayer();
  await loadHolding();

  els.outputStatus.classList.add('live');
  els.outputStatus.innerHTML = `<span class="dot"></span> ÉCRAN ${screen + 1} PRÊT`;
  setOutputState('ACTIVE', `Écran ${screen + 1}`, 'ATTENTE', 'Prêt');
  setMessage(`Écran ${screen + 1} prêt pour la diffusion.`);
  startStatusPolling();
  refreshAudioDevices(false).catch(() => {});
}

async function loadHolding() {
  const holding = await ensureHoldingPath();
  await mpv({ command: ['set_property', 'loop-file', 'inf'] });
  await mpv({ command: ['set_property', 'background-color', '#0A101A'] });
  await mpv({ command: ['loadfile', holding, 'replace'] });
  await mpv({ command: ['set_property', 'pause', false] });
  programIndex = -1;
  isPaused = false;
  duration = 0;
  els.programTitle.textContent = 'Ankino Media Diffusion';
  els.timeText.textContent = '00:00 / 00:00';
  els.progress.value = '0';
  els.playBtn.textContent = '▶';
  els.qualityState.textContent = 'Prêt';
  handlingEof = false;
}

async function showHoldingOutput() {
  try {
    if (!playerChild) await startOutput();
    else await loadHolding();
    els.outputStatus.classList.add('live');
    els.outputStatus.innerHTML = `<span class="dot"></span> ÉCRAN ${playerScreen + 1} PRÊT`;
    setOutputState('ACTIVE', `Écran ${playerScreen + 1}`, 'ATTENTE', 'Prêt');
    setMessage('Écran d’attente Ankino affiché.');
  } catch (err) {
    setMessage(`Impossible d’afficher l’écran d’attente : ${err}`, true);
  }
}

async function stopOutput() {
  if (playerChild) {
    try { await playerChild.kill(); } catch {}
  }
  playerChild = null;
  playerScreen = null;
  programIndex = -1;
  duration = 0;
  els.programTitle.textContent = 'Diffusion arrêtée';
  els.timeText.textContent = '00:00 / 00:00';
  els.progress.value = '0';
  els.playBtn.textContent = '▶';
  els.qualityState.textContent = 'Prêt';
  handlingEof = false;
  els.outputStatus.classList.remove('live');
  els.outputStatus.innerHTML = '<span class="dot"></span> DIFFUSION ARRÊTÉE';
  setOutputState('ARRÊTÉE', 'Aucun', 'STOP', 'Prêt');
  setMessage('Diffusion arrêtée.');
}

async function stopAllOutputs() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  await stopOutput();
}

async function configureVideoMode() {
  await mpv({ command: ['set_property', 'osd-level', 0] });
  await mpv({ command: ['set_property', 'osd-msg3', ''] });
  await mpv({ command: ['set_property', 'audio-display', 'no'] });
}

async function configureAudioMode(path) {
  let background = audioBackgroundPath;
  if (background && !(await fileExists(background))) {
    audioBackgroundPath = '';
    localStorage.removeItem('ankino.audioBackgroundPath');
    updateAudioBackgroundLabel();
    background = '';
  }
  background = background || await ensureHoldingPath();
  await mpv({ command: ['set_property', 'audio-display', 'external-first'] });
  try {
    await mpv({ command: ['video-add', background, 'select+attached-picture', 'Ankino Media Diffusion'] });
  } catch (err) {
    setMessage(`Fond audio indisponible : ${err}`, true);
    await mpv({ command: ['set_property', 'audio-display', 'no'] });
  }
  await mpv({ command: ['set_property', 'osd-level', 0] });
}

async function projectIndex(index) {
  if (index < 0 || !playlist[index]) {
    setMessage('Ajoutez puis sélectionnez un média.', true);
    return;
  }

  const path = playlist[index];
  if (!(await fileExists(path))) {
    missingPaths.add(path);
    renderPlaylist();
    selectIndex(index);
    setMessage(`Fichier introuvable : ${fileName(path)}`, true);
    return false;
  }
  missingPaths.delete(path);

  try {
    await startOutput();

    const audio = isAudioPath(path);

    await configureVideoMode();
    await mpv({ command: ['set_property', 'loop-file', els.loopMode.value === 'media' ? 'inf' : 'no'] });
    await mpv({ command: ['loadfile', path, 'replace'] });

    if (audio) {
      await configureAudioMode(path);
    }

    await mpv({ command: ['set_property', 'pause', false] });

    programIndex = index;
    selectedIndex = index;
    isPaused = false;
    handlingEof = false;
    statusTick = 0;

    els.playBtn.textContent = '⏸';
    els.programTitle.textContent = audio ? `AUDIO · ${fileName(path)}` : fileName(path);
    els.outputStatus.classList.add('live');
    els.outputStatus.innerHTML = `<span class="dot"></span> ÉCRAN ${playerScreen + 1} EN DIFFUSION`;
    setOutputState('EN DIFFUSION', `Écran ${playerScreen + 1}`, audio ? 'AUDIO' : 'VIDÉO', audio ? 'Audio' : 'Analyse...');

    renderPlaylist();
    setMessage(`En diffusion ${audio ? 'audio' : 'vidéo'} : ${fileName(path)}`);
    return true;
  } catch (err) {
    setMessage(`Projection impossible : ${err}`, true);
    try { await showHoldingOutput(); } catch {}
    return false;
  }
}

async function blackOutput() {
  try {
    if (!playerChild) await startOutput();

    await mpv({ command: ['set_property', 'loop-file', 'no'] });
    await mpv({ command: ['set_property', 'background-color', '#000000'] });
    await mpv({ command: ['stop'] });
    await configureVideoMode();

    programIndex = -1;
    isPaused = false;
    duration = 0;

    els.programTitle.textContent = 'Écran noir';
    els.timeText.textContent = '00:00 / 00:00';
    els.progress.value = '0';
    els.playBtn.textContent = '▶';
    els.outputStatus.classList.add('live');
    els.outputStatus.innerHTML = `<span class="dot"></span> ÉCRAN ${playerScreen + 1} NOIR`;
    setOutputState('ACTIVE', `Écran ${playerScreen + 1}`, 'NOIR', 'Noir');

    setMessage('Écran noir actif.');
  } catch (err) {
    setMessage(`Impossible de passer au noir : ${err}`, true);
  }
}

async function togglePlay() {
  if (programIndex < 0) {
    if (selectedIndex >= 0) await projectIndex(selectedIndex);
    return;
  }

  try {
    isPaused = !isPaused;
    await mpv({ command: ['set_property', 'pause', isPaused] });
    els.playBtn.textContent = isPaused ? '▶' : '⏸';
  } catch (err) {
    setMessage(`Commande impossible : ${err}`, true);
  }
}

async function findPlayableIndex(start, step, wrap = true) {
  if (!playlist.length) return -1;
  for (let count = 0; count < playlist.length; count++) {
    let index = start + (count * step);
    if (wrap) index = ((index % playlist.length) + playlist.length) % playlist.length;
    else if (index < 0 || index >= playlist.length) return -1;
    if (await fileExists(playlist[index])) {
      missingPaths.delete(playlist[index]);
      return index;
    }
    missingPaths.add(playlist[index]);
  }
  renderPlaylist();
  return -1;
}

async function moveProgram(delta) {
  if (!playlist.length) return;
  const base = programIndex >= 0 ? programIndex + delta : Math.max(selectedIndex, 0);
  const next = await findPlayableIndex(base, delta >= 0 ? 1 : -1, true);
  if (next >= 0) await projectIndex(next);
  else setMessage('Aucun média disponible dans la playlist.', true);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;

  const s = Math.floor(seconds % 60).toString().padStart(2,'0');
  const m = Math.floor((seconds / 60) % 60).toString().padStart(2,'0');
  const h = Math.floor(seconds / 3600);

  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

async function refreshDiagnostics() {
  if (programIndex < 0 || isAudioPath(playlist[programIndex])) {
    els.qualityState.textContent = programIndex >= 0 ? 'Audio' : 'Prêt';
    return;
  }
  const params = await safeMpvProperty('video-params');
  const fps = Number(await safeMpvProperty('container-fps') || 0);
  const codec = await safeMpvProperty('video-codec');
  const hw = await safeMpvProperty('hwdec-current');
  const dropped = Number(await safeMpvProperty('vo-drop-frame-count') || 0);
  const size = params?.w && params?.h ? `${params.w}×${params.h}` : 'Vidéo';
  const fpsText = fps > 0 ? ` • ${fps.toFixed(fps >= 10 ? 0 : 1)} fps` : '';
  els.qualityState.textContent = `${size}${fpsText}`;
  els.qualityState.title = `${codec || 'Codec inconnu'} • ${hw || 'Décodage logiciel'} • pertes ${dropped}`;
}

async function handleEndOfFile() {
  if (handlingEof || programIndex < 0) return;
  handlingEof = true;
  try {
    const mode = els.loopMode.value;
    if (mode === 'media') {
      await projectIndex(programIndex);
      return;
    }
    if (mode === 'playlist') {
      const next = await findPlayableIndex(programIndex + 1, 1, true);
      if (next >= 0) await projectIndex(next);
      else await showHoldingOutput();
      return;
    }
    if (els.autoNext.checked) {
      const next = await findPlayableIndex(programIndex + 1, 1, false);
      if (next >= 0) await projectIndex(next);
      else await showHoldingOutput();
    } else {
      await showHoldingOutput();
    }
  } finally {
    handlingEof = false;
  }
}

async function pollStatus() {
  if (!playerChild || programIndex < 0) return;

  try {
    const time = Number(await safeMpvProperty('time-pos') || 0);
    duration = Number(await safeMpvProperty('duration') || 0);
    const eof = await safeMpvProperty('eof-reached');

    els.timeText.textContent = `${formatTime(time)} / ${formatTime(duration)}`;
    els.progress.value = duration > 0 ? String(Math.round((time / duration) * 1000)) : '0';

    statusTick += 1;
    if (statusTick % 5 === 0) refreshDiagnostics().catch(() => {});
    if (eof === true) await handleEndOfFile();
  } catch {}
}


function renderAudioDevices(devices = []) {
  const previous = selectedAudioDevice || 'auto';
  els.audioDeviceSelect.innerHTML = '';

  const autoOption = document.createElement('option');
  autoOption.value = 'auto';
  autoOption.textContent = 'Automatique • Windows';
  els.audioDeviceSelect.appendChild(autoOption);

  for (const device of devices) {
    if (!device?.name) continue;
    const option = document.createElement('option');
    option.value = device.name;
    option.textContent = device.description || device.name;
    els.audioDeviceSelect.appendChild(option);
  }

  const available = [...els.audioDeviceSelect.options].some(option => option.value === previous);
  selectedAudioDevice = available ? previous : 'auto';
  els.audioDeviceSelect.value = selectedAudioDevice;
}

async function refreshAudioDevices(startIfNeeded = true) {
  try {
    if (!playerChild && startIfNeeded) await startOutput();
    if (!playerChild) {
      renderAudioDevices();
      return;
    }

    const response = await mpv({ command: ['get_property', 'audio-device-list'] });
    renderAudioDevices(Array.isArray(response?.data) ? response.data : []);
    setMessage('Sorties audio actualisées.');
  } catch (err) {
    renderAudioDevices();
    setMessage(`Impossible de lire les sorties audio : ${err}`, true);
  }
}

async function setMuted(nextMuted) {
  muted = Boolean(nextMuted);
  els.muteBtn.classList.toggle('active', muted);
  els.muteBtn.querySelector('span').textContent = muted ? 'Son coupé' : 'Mute';

  if (playerChild) {
    try {
      await mpv({ command: ['set_property', 'mute', muted] });
    } catch (err) {
      setMessage(`Commande audio impossible : ${err}`, true);
    }
  }
}

function saveNamedPlaylist() {
  if (!playlist.length) {
    setMessage('La playlist est vide.', true);
    return;
  }
  const proposed = els.savedPlaylistSelect.value || 'Ma playlist';
  const name = window.prompt('Nom de la playlist', proposed)?.trim();
  if (!name) return;
  savedPlaylists[name] = [...playlist];
  localStorage.setItem(STORAGE.savedPlaylists, JSON.stringify(savedPlaylists));
  renderSavedPlaylists();
  els.savedPlaylistSelect.value = name;
  setMessage(`Playlist enregistrée : ${name}`);
}

async function loadNamedPlaylist() {
  const name = els.savedPlaylistSelect.value;
  if (!name || !savedPlaylists[name]) {
    setMessage('Choisissez une playlist enregistrée.', true);
    return;
  }
  playlist = [...savedPlaylists[name]];
  selectedIndex = playlist.length ? 0 : -1;
  saveCurrentPlaylist();
  await validatePlaylist();
  selectIndex(selectedIndex);
  setMessage(`Playlist ouverte : ${name}`);
}

function deleteNamedPlaylist() {
  const name = els.savedPlaylistSelect.value;
  if (!name || !savedPlaylists[name]) return;
  if (!window.confirm(`Supprimer la playlist « ${name} » ?`)) return;
  delete savedPlaylists[name];
  localStorage.setItem(STORAGE.savedPlaylists, JSON.stringify(savedPlaylists));
  renderSavedPlaylists();
  setMessage(`Playlist supprimée : ${name}`);
}

function openAbout() {
  els.aboutModal.hidden = false;
  requestAnimationFrame(() => els.aboutModal.classList.add('visible'));
}

function closeAbout() {
  els.aboutModal.classList.remove('visible');
  window.setTimeout(() => {
    els.aboutModal.hidden = true;
  }, 160);
}

function startStatusPolling() {
  if (statusTimer) return;
  statusTimer = setInterval(pollStatus, 1000);
}

els.addFilesBtn.addEventListener('click', async () => {
  const files = await open({
    multiple: true,
    directory: false,
    filters: [{
      name: 'Médias',
      extensions: ['mp4','mkv','mov','avi','webm','m4v','mp3','wav','m4a','flac','aac','ogg','opus','wma','ts','mts','m2ts']
    }]
  });

  if (!files) return;

  const added = Array.isArray(files) ? files : [files];
  await addMediaPaths(added, 'Ajout');
});

els.audioBgBtn.addEventListener('click', async () => {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'Image de fond audio', extensions: IMAGE_EXTENSIONS }]
  });

  if (!selected) return;

  audioBackgroundPath = Array.isArray(selected) ? selected[0] : selected;
  localStorage.setItem('ankino.audioBackgroundPath', audioBackgroundPath);
  updateAudioBackgroundLabel();
  setMessage(`Fond audio sélectionné : ${fileName(audioBackgroundPath)}`);
});

els.clearAudioBgBtn.addEventListener('click', () => {
  audioBackgroundPath = '';
  localStorage.removeItem('ankino.audioBackgroundPath');
  updateAudioBackgroundLabel();
  setMessage('Fond audio réinitialisé : thème Ankino par défaut.');
});

els.removeBtn.addEventListener('click', () => {
  if (selectedIndex < 0) return;

  playlist.splice(selectedIndex, 1);

  if (!playlist.length) selectedIndex = -1;
  else selectedIndex = Math.min(selectedIndex, playlist.length - 1);

  saveCurrentPlaylist();
  selectIndex(selectedIndex);
});

els.clearBtn.addEventListener('click', () => {
  playlist = [];
  missingPaths.clear();
  selectedIndex = -1;
  saveCurrentPlaylist();
  renderPlaylist();
  selectIndex(-1);
});

els.savePlaylistBtn.addEventListener('click', saveNamedPlaylist);
els.loadPlaylistBtn.addEventListener('click', loadNamedPlaylist);
els.deletePlaylistBtn.addEventListener('click', deleteNamedPlaylist);
els.refreshMonitorsBtn.addEventListener('click', refreshMonitors);
els.refreshAudioBtn.addEventListener('click', () => refreshAudioDevices(true));
els.audioDeviceSelect.addEventListener('change', async () => {
  selectedAudioDevice = els.audioDeviceSelect.value || 'auto';
  localStorage.setItem('ankino.audioDevice', selectedAudioDevice);

  if (playerChild) {
    try {
      await mpv({ command: ['set_property', 'audio-device', selectedAudioDevice] });
      setMessage('Sortie audio modifiée.');
    } catch (err) {
      setMessage(`Impossible de changer la sortie audio : ${err}`, true);
    }
  }
});
els.muteBtn.addEventListener('click', () => setMuted(!muted));
els.projectBtn.addEventListener('click', () => projectIndex(selectedIndex));
els.holdingBtn.addEventListener('click', showHoldingOutput);
els.blackBtn.addEventListener('click', blackOutput);
els.blackMuteBtn.addEventListener('click', async () => {
  await setMuted(true);
  await blackOutput();
});
els.stopBtn.addEventListener('click', showHoldingOutput);
els.stopOutputBtn.addEventListener('click', stopAllOutputs);
els.playBtn.addEventListener('click', togglePlay);
els.prevBtn.addEventListener('click', () => moveProgram(-1));
els.nextBtn.addEventListener('click', () => moveProgram(1));

els.volume.addEventListener('input', async () => {
  els.volumeValue.textContent = `${els.volume.value}%`;
  localStorage.setItem(STORAGE.volume, els.volume.value);

  if (playerChild) {
    try {
      await mpv({ command: ['set_property', 'volume', Number(els.volume.value)] });
    } catch {}
  }
});

els.progress.addEventListener('input', async () => {
  if (!playerChild || duration <= 0) return;

  const target = (Number(els.progress.value) / 1000) * duration;

  try {
    await mpv({ command: ['set_property', 'time-pos', target] });
  } catch {}
});

els.loopMode.addEventListener('change', async () => {
  persistSettings();
  if (playerChild && programIndex >= 0) {
    try { await mpv({ command: ['set_property', 'loop-file', els.loopMode.value === 'media' ? 'inf' : 'no'] }); } catch {}
  }
  const label = els.loopMode.options[els.loopMode.selectedIndex]?.textContent || 'Aucune';
  setMessage(`Boucle : ${label}`);
});
els.autoNext.addEventListener('change', persistSettings);
els.monitorSelect.addEventListener('change', () => {
  persistSettings();
  const selected = Number(els.monitorSelect.value || 0) + 1;
  if (playerChild) setMessage('Écran modifié. La sortie changera au prochain clic sur PROJETER.');
  else els.screenState.textContent = `Écran ${selected} sélectionné`;
});

els.aboutBtn.addEventListener('click', openAbout);
els.closeAboutBtn.addEventListener('click', closeAbout);
els.aboutModal.addEventListener('click', event => {
  if (event.target === els.aboutModal) closeAbout();
});
function isTypingTarget(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
}

async function handleShortcut(event) {
  if (!els.aboutModal.hidden && event.key === 'Escape') {
    closeAbout();
    return;
  }
  if (isTypingTarget(event.target) || !els.aboutModal.hidden) return;

  const key = event.key.toLowerCase();
  if (event.code === 'Space') { event.preventDefault(); await togglePlay(); }
  else if (event.key === 'Enter') { event.preventDefault(); await projectIndex(selectedIndex); }
  else if (key === 'b') { event.preventDefault(); await blackOutput(); }
  else if (key === 'a') { event.preventDefault(); await showHoldingOutput(); }
  else if (key === 'm') { event.preventDefault(); await setMuted(!muted); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); await moveProgram(-1); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); await moveProgram(1); }
}

window.addEventListener('keydown', event => { handleShortcut(event).catch(() => {}); });

async function initDragDrop() {
  await mainWebview.onDragDropEvent(event => {
    const payload = event.payload;
    if (payload.type === 'enter' || payload.type === 'over') {
      els.dropOverlay.classList.add('visible');
    } else if (payload.type === 'leave') {
      els.dropOverlay.classList.remove('visible');
    } else if (payload.type === 'drop') {
      els.dropOverlay.classList.remove('visible');
      addMediaPaths(payload.paths || [], 'Glisser-déposer').catch(() => {});
    }
  });
}

async function initApp() {
  await mainWindow.onCloseRequested(async event => {
    if (appClosing) return;
    event.preventDefault();
    appClosing = true;
    setMessage('Fermeture de toutes les sorties...');
    try {
      await stopAllOutputs();
    } finally {
      await mainWindow.destroy();
    }
  });

  const savedVolume = Math.max(0, Math.min(100, Number(localStorage.getItem(STORAGE.volume) || 80)));
  els.volume.value = String(savedVolume);
  els.volumeValue.textContent = `${savedVolume}%`;
  els.loopMode.value = localStorage.getItem(STORAGE.loopMode) || 'none';
  els.autoNext.checked = localStorage.getItem(STORAGE.autoNext) === '1';

  renderAudioDevices();
  updateAudioBackgroundLabel();
  renderSavedPlaylists();
  setOutputState('ARRÊTÉE', 'Aucun', 'STOP', 'Prêt');
  renderPlaylist();
  await validatePlaylist();
  selectIndex(selectedIndex);
  await refreshMonitors();
  await initDragDrop();
}

initApp().catch(err => {
  setMessage(`Initialisation impossible : ${err}`, true);
});
