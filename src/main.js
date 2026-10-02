import { open } from '@tauri-apps/plugin-dialog';
import { Command } from '@tauri-apps/plugin-shell';
import { invoke } from '@tauri-apps/api/core';
import { availableMonitors } from '@tauri-apps/api/window';

const els = Object.fromEntries([
  'addFilesBtn','removeBtn','clearBtn','playlist','selectedTitle','selectedPath','programTitle','timeText','progress',
  'prevBtn','playBtn','stopBtn','nextBtn','monitorSelect','refreshMonitorsBtn','volume','volumeValue','autoNext',
  'blackBtn','projectBtn','message','outputStatus'
].map(id => [id, document.getElementById(id)]));

let playlist = [];
let selectedIndex = -1;
let programIndex = -1;
let playerChild = null;
let playerScreen = null;
let isPaused = false;
let duration = 0;
let statusTimer = null;

function fileName(path) {
  return path.split(/[\\/]/).pop() || path;
}

function setMessage(text, error = false) {
  els.message.textContent = text;
  els.message.classList.toggle('error', error);
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
    const item = document.createElement('div');
    item.className = `playlist-item ${index === selectedIndex ? 'selected' : ''}`;
    item.innerHTML = `<div class="item-index">${String(index + 1).padStart(2,'0')}</div><div><div class="item-name"></div><div class="item-path"></div></div>`;
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
  els.selectedTitle.textContent = path ? fileName(path) : 'Sélectionnez une vidéo';
  els.selectedPath.textContent = path || 'La vidéo choisie sera envoyée vers l’écran de diffusion.';
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
      option.textContent = `Écran ${index + 1}${m.name ? ` — ${m.name}` : ''} (${m.size.width}×${m.size.height})`;
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
    '--no-config', '--idle=yes', '--force-window=yes', '--keep-open=yes', '--fullscreen',
    `--screen=${screen}`, `--fs-screen=${screen}`, '--osc=no', '--input-default-bindings=no',
    '--cursor-autohide=always', '--terminal=no', '--input-ipc-server=ankino-diffusion-mpv',
    '--background-color=#000000', '--video-aspect-override=-1', '--hwdec=auto-safe',
    `--volume=${els.volume.value}`
  ];

  const command = Command.sidecar('binaries/mpv', args);
  command.on('close', () => {
    playerChild = null;
    playerScreen = null;
    els.outputStatus.classList.remove('live');
    els.outputStatus.innerHTML = '<span class="dot"></span> SORTIE FERMÉE';
  });
  command.on('error', err => setMessage(`Erreur du moteur vidéo : ${err}`, true));
  playerChild = await command.spawn();
  playerScreen = screen;
  await waitForPlayer();
  els.outputStatus.classList.add('live');
  els.outputStatus.innerHTML = `<span class="dot"></span> SORTIE ÉCRAN ${screen + 1}`;
  setMessage(`Sortie ouverte en plein écran sur l’écran ${screen + 1}.`);
  startStatusPolling();
}

async function projectIndex(index) {
  if (index < 0 || !playlist[index]) {
    setMessage('Ajoutez puis sélectionnez une vidéo.', true);
    return;
  }
  try {
    await startOutput();
    const path = playlist[index];
    await mpv({ command: ['loadfile', path, 'replace'] });
    await mpv({ command: ['set_property', 'pause', false] });
    programIndex = index;
    selectedIndex = index;
    isPaused = false;
    els.playBtn.textContent = '⏸';
    els.programTitle.textContent = fileName(path);
    renderPlaylist();
    setMessage(`En diffusion : ${fileName(path)}`);
  } catch (err) {
    setMessage(`Projection impossible : ${err}`, true);
  }
}

async function blackOutput() {
  try {
    if (!playerChild) await startOutput();
    await mpv({ command: ['stop'] });
    programIndex = -1;
    isPaused = false;
    duration = 0;
    els.programTitle.textContent = 'Écran noir';
    els.timeText.textContent = '00:00 / 00:00';
    els.progress.value = '0';
    els.playBtn.textContent = '▶';
    setMessage('Sortie maintenue en noir.');
  } catch (err) { setMessage(`Impossible de passer au noir : ${err}`, true); }
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
  } catch (err) { setMessage(`Commande impossible : ${err}`, true); }
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
        programIndex = -1;
        els.programTitle.textContent = 'Écran noir';
        els.playBtn.textContent = '▶';
      }
    }
  } catch {}
}

function startStatusPolling() {
  if (statusTimer) return;
  statusTimer = setInterval(pollStatus, 700);
}

els.addFilesBtn.addEventListener('click', async () => {
  const files = await open({
    multiple: true,
    directory: false,
    filters: [{ name: 'Médias', extensions: ['mp4','mkv','mov','avi','webm','m4v','mp3','wav','m4a','flac','aac','ts','mts','m2ts'] }]
  });
  if (!files) return;
  const added = Array.isArray(files) ? files : [files];
  playlist.push(...added.filter(p => !playlist.includes(p)));
  if (selectedIndex < 0 && playlist.length) selectIndex(0); else renderPlaylist();
  setMessage(`${added.length} fichier(s) ajouté(s).`);
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
els.projectBtn.addEventListener('click', () => projectIndex(selectedIndex));
els.blackBtn.addEventListener('click', blackOutput);
els.stopBtn.addEventListener('click', blackOutput);
els.playBtn.addEventListener('click', togglePlay);
els.prevBtn.addEventListener('click', () => moveProgram(-1));
els.nextBtn.addEventListener('click', () => moveProgram(1));

els.volume.addEventListener('input', async () => {
  els.volumeValue.textContent = `${els.volume.value}%`;
  if (playerChild) {
    try { await mpv({ command: ['set_property', 'volume', Number(els.volume.value)] }); } catch {}
  }
});

els.progress.addEventListener('input', async () => {
  if (!playerChild || duration <= 0) return;
  const target = (Number(els.progress.value) / 1000) * duration;
  try { await mpv({ command: ['set_property', 'time-pos', target] }); } catch {}
});

els.monitorSelect.addEventListener('change', () => {
  if (playerChild) setMessage('L’écran a changé. La sortie sera relancée au prochain clic sur PROJETER.');
});

refreshMonitors();
renderPlaylist();
