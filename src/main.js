import '@fontsource/montserrat/400.css';
import '@fontsource/montserrat/500.css';
import '@fontsource/montserrat/600.css';
import { open } from '@tauri-apps/plugin-dialog';
import { Command } from '@tauri-apps/plugin-shell';
import { invoke } from '@tauri-apps/api/core';
import { availableMonitors, getCurrentWindow } from '@tauri-apps/api/window';
import { resolveResource } from '@tauri-apps/api/path';

const AUDIO_EXTENSIONS = new Set(['mp3','wav','m4a','flac','aac','ogg','opus','wma']);
const IMAGE_EXTENSIONS = ['png','jpg','jpeg','webp','bmp'];

const els = Object.fromEntries([
  'addFilesBtn','removeBtn','clearBtn','playlist','selectedTitle','selectedPath','previewIcon','programTitle','timeText','progress',
  'prevBtn','playBtn','stopBtn','nextBtn','monitorSelect','refreshMonitorsBtn','volume','volumeValue','autoNext',
  'audioBgBtn','clearAudioBgBtn','audioBgName','audioDeviceSelect','refreshAudioBtn','muteBtn','blackBtn','blackMuteBtn','projectBtn','message','outputStatus','aboutBtn','aboutModal','closeAboutBtn',
  'diffusionState','screenState','modeState','stopOutputBtn','holdingBtn'
].map(id => [id, document.getElementById(id)]));

let playlist = [];
let selectedIndex = -1;
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
const mainWindow = getCurrentWindow();

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

function mediaType(path) {
  return isAudioPath(path) ? 'AUDIO' : 'VIDÉO';
}

function setMessage(text, error = false) {
  els.message.textContent = text;
  els.message.classList.toggle('error', error);
}

function setOutputState(diffusion, screen, mode) {
  els.diffusionState.textContent = diffusion;
  els.screenState.textContent = screen;
  els.modeState.textContent = mode;
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
    els.playlist.textContent = 'Aucun média ajouté.';
    return;
  }

  els.playlist.className = 'playlist';
  els.playlist.innerHTML = '';

  playlist.forEach((path, index) => {
    const audio = isAudioPath(path);
    const item = document.createElement('div');
    item.className = `playlist-item ${index === selectedIndex ? 'selected' : ''}`;
    item.innerHTML = `
      <div class="item-index">${String(index + 1).padStart(2,'0')}</div>
      <div>
        <div class="item-mainline">
          <div class="item-name"></div>
          <span class="item-type ${audio ? 'audio' : ''}">${audio ? 'AUDIO' : 'VIDÉO'}</span>
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
  els.previewIcon.textContent = audio ? '♫' : '▶';
  els.previewIcon.classList.toggle('audio', audio);
  els.selectedTitle.textContent = fileName(path);
  els.selectedPath.textContent = `${audio ? 'Audio' : 'Vidéo'} · ${path}`;
  renderPlaylist();
}

async function refreshMonitors() {
  try {
    const monitors = await availableMonitors();
    const previous = Number(els.monitorSelect.value || 0);
    els.monitorSelect.innerHTML = '';

    monitors.forEach((m, index) => {
      const option = document.createElement('option');
      option.value = index;
      option.textContent = `Écran ${index + 1}${m.name ? ` • ${m.name}` : ''} (${m.size.width}×${m.size.height})`;
      els.monitorSelect.appendChild(option);
    });

    if (monitors.length > 1) els.monitorSelect.value = String(Math.min(previous || 1, monitors.length - 1));
    else els.monitorSelect.value = '0';

    setMessage(`${monitors.length} écran(s) détecté(s).`);
  } catch (err) {
    setMessage(`Impossible de détecter les écrans : ${err}`, true);
  }
}

async function mpv(request) {
  return await invoke('mpv_ipc', { request });
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
    setOutputState('ARRÊTÉE', 'Aucun', 'STOP');
  });

  command.on('error', err => setMessage(`Erreur du moteur vidéo : ${err}`, true));

  playerChild = await command.spawn();
  playerScreen = screen;
  await waitForPlayer();
  await loadHolding();

  els.outputStatus.classList.add('live');
  els.outputStatus.innerHTML = `<span class="dot"></span> ÉCRAN ${screen + 1} PRÊT`;
  setOutputState('ACTIVE', `Écran ${screen + 1}`, 'ATTENTE');
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
}

async function showHoldingOutput() {
  try {
    if (!playerChild) await startOutput();
    else await loadHolding();
    els.outputStatus.classList.add('live');
    els.outputStatus.innerHTML = `<span class="dot"></span> ÉCRAN ${playerScreen + 1} PRÊT`;
    setOutputState('ACTIVE', `Écran ${playerScreen + 1}`, 'ATTENTE');
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
  els.outputStatus.classList.remove('live');
  els.outputStatus.innerHTML = '<span class="dot"></span> DIFFUSION ARRÊTÉE';
  setOutputState('ARRÊTÉE', 'Aucun', 'STOP');
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
  const background = audioBackgroundPath || await ensureHoldingPath();
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

  try {
    await startOutput();

    const path = playlist[index];
    const audio = isAudioPath(path);

    await configureVideoMode();
    await mpv({ command: ['set_property', 'loop-file', 'no'] });
    await mpv({ command: ['loadfile', path, 'replace'] });

    if (audio) {
      await configureAudioMode(path);
    }

    await mpv({ command: ['set_property', 'pause', false] });

    programIndex = index;
    selectedIndex = index;
    isPaused = false;

    els.playBtn.textContent = '⏸';
    els.programTitle.textContent = audio ? `AUDIO · ${fileName(path)}` : fileName(path);
    els.outputStatus.classList.add('live');
    els.outputStatus.innerHTML = `<span class="dot"></span> ÉCRAN ${playerScreen + 1} EN DIFFUSION`;
    setOutputState('EN DIFFUSION', `Écran ${playerScreen + 1}`, audio ? 'AUDIO' : 'VIDÉO');

    renderPlaylist();
    setMessage(`En diffusion ${audio ? 'audio' : 'vidéo'} : ${fileName(path)}`);
  } catch (err) {
    setMessage(`Projection impossible : ${err}`, true);
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
    setOutputState('ACTIVE', `Écran ${playerScreen + 1}`, 'NOIR');

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

async function moveProgram(delta) {
  if (!playlist.length) return;

  let next = programIndex >= 0 ? programIndex + delta : selectedIndex;
  if (next < 0) next = playlist.length - 1;
  if (next >= playlist.length) next = 0;

  await projectIndex(next);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;

  const s = Math.floor(seconds % 60).toString().padStart(2,'0');
  const m = Math.floor((seconds / 60) % 60).toString().padStart(2,'0');
  const h = Math.floor(seconds / 3600);

  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

async function pollStatus() {
  if (!playerChild || programIndex < 0) return;

  try {
    const t = await mpv({ command: ['get_property', 'time-pos'] });
    const d = await mpv({ command: ['get_property', 'duration'] });
    const eof = await mpv({ command: ['get_property', 'eof-reached'] });

    const time = Number(t?.data ?? 0);
    duration = Number(d?.data ?? 0);

    els.timeText.textContent = `${formatTime(time)} / ${formatTime(duration)}`;
    els.progress.value = duration > 0 ? String(Math.round((time / duration) * 1000)) : '0';

    if (eof?.data === true && programIndex >= 0) {
      if (els.autoNext.checked && playlist.length > 1) {
        const next = (programIndex + 1) % playlist.length;
        await projectIndex(next);
      } else {
        await showHoldingOutput();
      }
    }
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
  playlist.push(...added.filter(p => !playlist.includes(p)));

  if (selectedIndex < 0 && playlist.length) selectIndex(0);
  else renderPlaylist();

  setMessage(`${added.length} fichier(s) ajouté(s).`);
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

  selectIndex(selectedIndex);
});

els.clearBtn.addEventListener('click', () => {
  playlist = [];
  selectedIndex = -1;
  renderPlaylist();
  selectIndex(-1);
});

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

els.monitorSelect.addEventListener('change', () => {
  const selected = Number(els.monitorSelect.value || 0) + 1;
  if (playerChild) setMessage('L’écran a changé. La sortie sera relancée au prochain clic sur PROJETER.');
  else els.screenState.textContent = `Écran ${selected} sélectionné`;
});

els.aboutBtn.addEventListener('click', openAbout);
els.closeAboutBtn.addEventListener('click', closeAbout);
els.aboutModal.addEventListener('click', event => {
  if (event.target === els.aboutModal) closeAbout();
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !els.aboutModal.hidden) closeAbout();
});

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

  renderAudioDevices();
  updateAudioBackgroundLabel();
  setOutputState('ARRÊTÉE', 'Aucun', 'STOP');
  await refreshMonitors();
  renderPlaylist();
}

initApp().catch(err => {
  setMessage(`Initialisation impossible : ${err}`, true);
});
