# Ankino Diffusion v0.1

Régie de diffusion vidéo Windows : playlist sur l'écran principal, sortie vidéo plein écran sur un écran secondaire.

## Architecture

- **Tauri 2 + Vite + HTML/CSS/JS** : interface de régie.
- **mpv** : moteur de lecture vidéo natif lancé comme sidecar.
- **IPC JSON mpv** : commandes lecture/pause/stop/volume/position.
- **GitHub Actions** : compilation Windows en `.exe` (NSIS) et `.msi`.

## Fonctions de cette v0.1

- Ajouter plusieurs fichiers vidéo/audio à la playlist.
- Sélectionner un écran de diffusion détecté par Tauri.
- Cliquer sur **PROJETER** pour ouvrir/maintenir la sortie mpv plein écran et lancer le média sélectionné.
- Lecture / Pause / Précédent / Suivant.
- Écran noir immédiat sans fermer la sortie.
- Volume.
- Barre de progression avec déplacement dans la vidéo.
- Option lecture automatique de la vidéo suivante.

## Compilation sur GitHub

1. Ouvrez l'onglet **Actions** du dépôt.
2. Lancez **Build Windows** (ou poussez sur `main`).
3. À la fin du workflow, téléchargez l'artifact `ankino-diffusion-windows`.

Le workflow télécharge automatiquement une build Windows x64 de mpv, la prépare comme sidecar Tauri, puis génère les installateurs Windows.

## Test à deux écrans

Dans Windows, choisissez **Étendre ces affichages**, et non **Dupliquer**. Lancez Ankino Diffusion, ajoutez une vidéo, choisissez l'écran du vidéoprojecteur dans la liste, puis cliquez sur **PROJETER**.

## Important pour la v0.1

Cette première version vise à verrouiller le cœur de diffusion. Les étapes suivantes prévues sont : aperçu vidéo natif dans la régie, sauvegarde des playlists, transitions/fondus, image/logo d'attente, raccourcis clavier, journal d'incident, reprise après crash, et packaging/signature améliorés.

## Licence et composants tiers

Tauri et mpv ont leurs propres licences. Avant une redistribution commerciale publique, conservez les notices des composants tiers et vérifiez les obligations de la build mpv utilisée par le projet.
