// Symphonia front-end powered by Nuvi Music backend

// Nuvi Music backend – change this to your real Nuvi JSON endpoint
// JSON format: { "tracks": [ { "title", "artist", "cover", "link" } ] } or just [ ... ]
const MUSIC_DB_URL = "music-db.json"; 
const MAX_HOME_TRACKS = 30; // max songs displayed on Home grid

const state = {
  tracks: [],          // normalized: {id,title,artist,cover,src,album}
  shuffledOrder: [],
  orderIndex: 0,
  currentTrackIndex: null,
  isPlaying: false,
  repeatMode: "off",   // off | one
  shuffleEnabled: true,
  playlists: {},       // id -> { id, name, trackIds: [] }
  activePlaylistId: null,
  notificationsPrompted: false
};

const els = {};
const PLAYLIST_STORAGE_KEY = "symphonia_nuvi_playlists_v1";
const THEME_STORAGE_KEY = "symphonia_nuvi_theme_v1";

// Visualizer audio context state
const visualizerState = {
  ctx: null,
  analyser: null,
  dataArray: null,
  bars: [],
  rafId: null
};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  initTheme();
  attachUIHandlers();
  loadPlaylistsFromStorage();
  fetchTracks();
  initMediaSession();
  registerServiceWorker();
});

function cacheElements() {
  els.trackGrid = document.getElementById("trackGrid");
  els.searchInput = document.getElementById("searchInput");
  els.playlistList = document.getElementById("playlistList");
  els.newPlaylistBtn = document.getElementById("newPlaylistBtn");

  els.upNextList = document.getElementById("upNextList");
  els.upNextSubtitle = document.getElementById("upNextSubtitle");

  els.audio = document.getElementById("audioElement");
  els.playerCover = document.getElementById("playerCover");
  els.playerTitle = document.getElementById("playerTitle");
  els.playerArtist = document.getElementById("playerArtist");

  els.btnPlayPause = document.getElementById("btnPlayPause");
  els.btnNext = document.getElementById("btnNext");
  els.btnPrev = document.getElementById("btnPrev");
  els.btnShuffle = document.getElementById("btnShuffle");
  els.btnRepeat = document.getElementById("btnRepeat");
  els.volumeSlider = document.getElementById("volumeSlider");
  els.progressBar = document.getElementById("progressBar");
  els.currentTimeLabel = document.getElementById("currentTime");
  els.totalTimeLabel = document.getElementById("totalTime");

  els.themeToggleBtn = document.getElementById("themeToggleBtn");
  els.visualizer = document.getElementById("visualizer");

  // Extra logging for audio errors (helps with debugging)
  if (els.audio) {
    els.audio.addEventListener("error", () => {
      const err = els.audio.error;
      console.error("HTMLMediaElement error:", {
        code: err && err.code,
        currentSrc: els.audio.currentSrc,
        audioSrcAttr: els.audio.getAttribute("src")
      });
    });
  }
}

/* ========== PWA: Service Worker Registration ========== */

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("service-worker.js")
      .catch((err) => console.log("Service worker registration failed:", err));
  }
}

/* ========== THEME ========== */

function initTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  const prefersLight =
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches;

  const initial = stored || (prefersLight ? "light" : "dark");
  setTheme(initial);

  if (els.themeToggleBtn) {
    els.themeToggleBtn.addEventListener("click", toggleTheme);
  }
}

function setTheme(theme) {
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  if (els.themeToggleBtn) {
    els.themeToggleBtn.textContent = theme === "dark" ? "🌙" : "☀️";
    els.themeToggleBtn.title =
      theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  }
}

function toggleTheme() {
  const current = document.body.getAttribute("data-theme") || "dark";
  setTheme(current === "dark" ? "light" : "dark");
}

/* ========== DATA FETCH & NORMALIZATION ========== */

async function fetchTracks() {
  try {
    const res = await fetch(MUSIC_DB_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const raw = data.tracks || data;

    const normalized = [];
    let skipped = 0;

    raw.forEach((t, idx) => {
      const url = (t.url || t.link || "").toString().trim();
      if (!url) {
        console.warn(`Track ${idx} skipped - no URL found`);
        skipped++;
        return; // ignore entries with no playable URL
      }

      const title = (t.title || "Untitled").toString();
      const artist = (t.artist || "Unknown artist").toString();
      const cover = (t.cover || "").toString().trim();
      const album = (t.album || "").toString();

      // Normalize into a consistent shape. Include `src`, `url`, and `link`
      // so other parts of the app (or older data) can read the audio URL.
      normalized.push({
        id: t.id || `t${idx + 1}`,
        title,
        artist,
        cover: cover || "",     // we handle empty string later with fallbacks
        album,
        src: url,                // canonical source property used by player
        url: url,                // preserve original field name if used elsewhere
        link: url                // legacy field name fallback
      });
    });

    state.tracks = normalized;

    console.log(
      `Symphonia loaded tracks from Nuvi: ${state.tracks.length} (skipped ${skipped} invalid entries)`
    );
    
    // Debug: log first track to verify src is set
    if (state.tracks.length > 0) {
      console.log("First track loaded:", state.tracks[0]);
    }

    if (!state.tracks.length) {
      if (els.trackGrid) {
        els.trackGrid.innerHTML = `
          <div style="color:#f88;font-size:0.9rem;">
            Nuvi database loaded but no valid tracks (missing "link" field).<br/>
            Check your JSON entries: each must have <code>link</code> with a valid audio URL.
          </div>
        `;
      }
      return;
    }

    buildInitialShuffleOrder();
    renderTrackGrid();
    renderUpNext();

    // Preload first track (no autoplay)
    loadTrackByIndex(state.shuffledOrder[0], false);
  } catch (err) {
    console.error("Error loading music db:", err);
    if (els.trackGrid) {
      els.trackGrid.innerHTML = `
        <div style="color:#f88;font-size:0.9rem;">
          Unable to load Nuvi music database.<br/>
          Check <code>MUSIC_DB_URL</code> and that you're serving Symphonia over <b>http://</b> or <b>https://</b>.
        </div>
      `;
    }
  }
}

function buildInitialShuffleOrder() {
  const indices = Array.from({ length: state.tracks.length }, (_, i) => i);
  state.shuffledOrder = shuffleArray(indices);
  state.orderIndex = 0;
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ========== RENDERING ========== */

function renderTrackGrid(filter = "") {
  const q = filter.trim().toLowerCase();
  els.trackGrid.innerHTML = "";

  const indices = state.shuffledOrder;
  let shown = 0;

  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    const track = state.tracks[i];
    if (!track) continue;

    const matches =
      !q ||
      track.title.toLowerCase().includes(q) ||
      track.artist.toLowerCase().includes(q) ||
      (track.album && track.album.toLowerCase().includes(q));

    if (!matches) continue;

    // Limit Home grid to MAX_HOME_TRACKS when not searching
    if (!q && shown >= MAX_HOME_TRACKS) break;

    const coverSrc =
      track.cover && track.cover !== "undefined"
        ? track.cover
        : "https://picsum.photos/seed/symphoniaplaceholder/400/400";

    const card = document.createElement("div");
    card.className = "track-card";
    card.dataset.index = i;

    card.innerHTML = `
      <div class="track-cover-wrapper">
        <img src="${coverSrc}" alt="${track.title}" class="track-cover" />
        <div class="track-hover-play">▶</div>
      </div>
      <div class="track-meta">
        <div class="track-title">${track.title}</div>
        <div class="track-artist">${track.artist}</div>
      </div>
      <div class="track-tags">
        <span>${track.album || ""}</span>
        <button class="add-to-playlist-btn" data-index="${i}">+ Playlist</button>
      </div>
    `;

    els.trackGrid.appendChild(card);
    shown++;
  }
}

/* Up Next queue */

function renderUpNext() {
  if (!els.upNextList || !state.tracks.length) return;

  const MAX_NEXT = 6;
  els.upNextList.innerHTML = "";

  const list = [];

  if (state.shuffleEnabled && state.shuffledOrder.length) {
    let start = state.orderIndex + 1;
    while (list.length < MAX_NEXT && state.shuffledOrder.length > 0) {
      const idx = state.shuffledOrder[start % state.shuffledOrder.length];
      if (!list.includes(idx)) list.push(idx);
      start++;
    }
  } else {
    let idx =
      state.currentTrackIndex == null ? 0 : (state.currentTrackIndex + 1) % state.tracks.length;
    while (list.length < Math.min(MAX_NEXT, state.tracks.length - 1)) {
      if (!list.includes(idx)) list.push(idx);
      idx = (idx + 1) % state.tracks.length;
    }
  }

  list.forEach((ti) => {
    const t = state.tracks[ti];
    if (!t) return;

    const coverSrc =
      t.cover && t.cover !== "undefined"
        ? t.cover
        : "https://picsum.photos/seed/symphoniaplaceholder/200/200";

    const item = document.createElement("div");
    item.className = "upnext-item";
    item.dataset.index = ti;
    item.innerHTML = `
      <div class="upnext-cover" style="background-image:url('${coverSrc}')"></div>
      <div class="upnext-meta">
        <div class="upnext-title">${t.title}</div>
        <div class="upnext-artist">${t.artist}</div>
      </div>
    `;
    item.addEventListener("click", () => {
      playTrackFromIndex(ti);
    });
    els.upNextList.appendChild(item);
  });

  if (els.upNextSubtitle) {
    els.upNextSubtitle.textContent =
      list.length > 0
        ? `Next ${list.length} in queue`
        : "Queue will appear when you start playing";
  }
}

/* ========== UI HANDLERS ========== */

function attachUIHandlers() {
  // Search
  els.searchInput.addEventListener("input", (e) => {
    renderTrackGrid(e.target.value);
  });

  // Track click & add to playlist
  els.trackGrid.addEventListener("click", (e) => {
    const addBtn = e.target.closest(".add-to-playlist-btn");
    if (addBtn) {
      const idx = parseInt(addBtn.dataset.index, 10);
      handleAddTrackToPlaylist(idx);
      e.stopPropagation();
      return;
    }

    const card = e.target.closest(".track-card");
    if (!card) return;
    const index = parseInt(card.dataset.index, 10);
    playTrackFromIndex(index);
  });

  // Player controls
  els.btnPlayPause.addEventListener("click", togglePlayPause);
  els.btnNext.addEventListener("click", () => skipTrack(1));
  els.btnPrev.addEventListener("click", () => skipTrack(-1));
  els.btnShuffle.addEventListener("click", toggleShuffle);
  els.btnRepeat.addEventListener("click", toggleRepeat);

  els.volumeSlider.addEventListener("input", () => {
    els.audio.volume = parseFloat(els.volumeSlider.value);
  });

  // Audio events
  els.audio.addEventListener("timeupdate", updateProgress);
  els.audio.addEventListener("loadedmetadata", updateDurationLabel);
  els.audio.addEventListener("ended", handleTrackEnded);

  els.progressBar.addEventListener("input", handleSeek);

  // Playlists
  els.newPlaylistBtn.addEventListener("click", createNewPlaylist);
}

/* ========== NOTIFICATIONS ========== */

async function ensureNotificationPermission() {
  if (!("Notification" in window)) return false;

  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;

  const result = await Notification.requestPermission();
  return result === "granted";
}

function notifyNowPlaying(track) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  new Notification("Symphonia – Now playing", {
    body: `${track.title} — ${track.artist}`,
    icon: track.cover || undefined,
    tag: "symphonia-now-playing"
  });
}

/* ========== PLAYBACK LOGIC ========== */

function togglePlayPause() {
  if (!state.tracks.length) return;

  if (state.isPlaying) {
    els.audio.pause();
    stopVisualizerLoop();
  } else {
    // Ask for notification permission once, on user gesture
    if (!state.notificationsPrompted) {
      state.notificationsPrompted = true;
      ensureNotificationPermission();
    }

    initVisualizer();
    els.audio.play().catch((err) => {
      console.error("audio.play() failed:", err);
    });
    startVisualizerLoop();
  }
}

function playTrackFromIndex(index) {
  const track = state.tracks[index];
  if (!track) {
    console.warn("playTrackFromIndex: no track at index", index);
    return;
  }

  if (!state.shuffledOrder.includes(index)) {
    buildInitialShuffleOrder();
  }

  state.currentTrackIndex = index;

  const idxInOrder = state.shuffledOrder.indexOf(index);
  if (idxInOrder !== -1) {
    state.orderIndex = idxInOrder;
  }

  loadTrackByIndex(index, true);
}

function loadTrackByIndex(index, autoplay = true) {
  // Validate index
  const idx = Number.parseInt(index, 10);
  if (!Number.isFinite(idx) || idx < 0 || idx >= state.tracks.length) {
    console.error("loadTrackByIndex: invalid index", index);
    return;
  }

  const track = state.tracks[idx];
  if (!track) {
    console.warn("loadTrackByIndex: no track at index", idx);
    return;
  }

  console.log("=== DEBUG: loadTrackByIndex called ===");
  console.log("Index:", idx);
  console.log("Track keys:", Object.keys(track));

  // Get the src - check multiple possible field names
  let src = track.src || track.url || track.link || "";
  src = String(src).trim();

  if (!src || src === "undefined") {
    console.error("loadTrackByIndex: track has no valid src/url/link", track);
    return; // avoid setting audio to undefined
  }

  console.log("✓ Using source URL:", src);

  state.currentTrackIndex = idx;

  // Safely set the audio source
  try {
    els.audio.src = src;
    console.log("Audio src set to:", els.audio.src);
  } catch (e) {
    console.error("Error setting audio src:", e);
    return;
  }

  els.audio.load();
  console.log("Audio loaded. currentSrc:", els.audio.currentSrc);

  els.playerTitle.textContent = track.title || "Unknown title";
  els.playerArtist.textContent = track.artist || "Unknown artist";

  if (track.cover && track.cover !== "undefined") {
    els.playerCover.style.backgroundImage = `url('${track.cover}')`;
  } else {
    els.playerCover.style.backgroundImage =
      "url('https://picsum.photos/seed/symphoniaplayer/300/300')";
  }

  updateMediaSessionMetadata(track);
  renderUpNext();

  if (autoplay) {
    notifyNowPlaying(track);
    initVisualizer();
    els.audio.play().catch((err) => {
      console.error("audio.play() failed:", err);
    });
    startVisualizerLoop();
  }
}

function updateProgress() {
  const current = els.audio.currentTime || 0;
  const total = els.audio.duration || 0;

  if (total > 0) {
    const percent = (current / total) * 100;
    els.progressBar.value = percent;
  } else {
    els.progressBar.value = 0;
  }

  els.currentTimeLabel.textContent = formatTime(current);

  if (els.audio.paused) {
    state.isPlaying = false;
    els.btnPlayPause.textContent = "▶";
    updateMediaSessionPlaybackState("paused");
    stopVisualizerLoop();
  } else {
    state.isPlaying = true;
    els.btnPlayPause.textContent = "⏸";
    updateMediaSessionPlaybackState("playing");
  }
}

function updateDurationLabel() {
  const total = els.audio.duration || 0;
  els.totalTimeLabel.textContent = formatTime(total);
}

function handleSeek() {
  const total = els.audio.duration || 0;
  const percent = parseFloat(els.progressBar.value);
  if (total > 0) {
    els.audio.currentTime = (percent / 100) * total;
  }
}

function handleTrackEnded() {
  if (state.repeatMode === "one") {
    els.audio.currentTime = 0;
    els.audio.play().catch((err) =>
      console.error("audio.play() failed after repeat:", err)
    );
    return;
  }
  skipTrack(1);
}

function skipTrack(direction) {
  if (!state.tracks.length) return;

  if (state.shuffleEnabled && state.shuffledOrder.length) {
    state.orderIndex += direction;

    if (
      state.orderIndex < 0 ||
      state.orderIndex >= state.shuffledOrder.length
    ) {
      buildInitialShuffleOrder();
    }

    const idx = state.shuffledOrder[state.orderIndex];
    loadTrackByIndex(idx, true);
  } else {
    let newIndex =
      (state.currentTrackIndex ?? 0) + direction;

    if (newIndex < 0) newIndex = state.tracks.length - 1;
    if (newIndex >= state.tracks.length) newIndex = 0;

    loadTrackByIndex(newIndex, true);
  }
}

function toggleShuffle() {
  state.shuffleEnabled = !state.shuffleEnabled;
  els.btnShuffle.style.background = state.shuffleEnabled
    ? "rgba(255, 79, 154, 0.65)"
    : "rgba(24, 30, 58, 0.9)";

  if (state.shuffleEnabled) {
    buildInitialShuffleOrder();
  }
  renderUpNext();
}

function toggleRepeat() {
  if (state.repeatMode === "off") {
    state.repeatMode = "one";
    els.btnRepeat.title = "Repeat (one)";
    els.btnRepeat.style.background = "rgba(255, 79, 154, 0.65)";
  } else {
    state.repeatMode = "off";
    els.btnRepeat.title = "Repeat (off)";
    els.btnRepeat.style.background = "rgba(24, 30, 58, 0.9)";
  }
}

function formatTime(sec) {
  sec = Math.floor(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/* ========== PLAYLISTS ========== */

function loadPlaylistsFromStorage() {
  try {
    const raw = localStorage.getItem(PLAYLIST_STORAGE_KEY);
    if (!raw) {
      const favId = generateId();
      state.playlists[favId] = {
        id: favId,
        name: "Favorites",
        trackIds: []
      };
      state.activePlaylistId = favId;
      renderPlaylistSidebar();
      return;
    }
    const parsed = JSON.parse(raw);
    state.playlists = parsed.playlists || {};
    state.activePlaylistId =
      parsed.activePlaylistId || Object.keys(state.playlists)[0];
    renderPlaylistSidebar();
  } catch (e) {
    console.warn("Error reading playlists from storage:", e);
  }
}

function savePlaylistsToStorage() {
  try {
    const payload = {
      playlists: state.playlists,
      activePlaylistId: state.activePlaylistId
    };
    localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("Error saving playlists to storage:", e);
  }
}

function renderPlaylistSidebar() {
  els.playlistList.innerHTML = "";

  Object.values(state.playlists).forEach((pl) => {
    const li = document.createElement("li");
    li.className =
      "playlist-item" +
      (pl.id === state.activePlaylistId ? " active" : "");
    li.dataset.id = pl.id;

    li.innerHTML = `
      <span class="playlist-name">${pl.name}</span>
      <span class="playlist-count">${pl.trackIds.length} tracks</span>
    `;

    li.addEventListener("click", () => {
      state.activePlaylistId = pl.id;
      savePlaylistsToStorage();
      renderPlaylistSidebar();
      renderPlaylistView(pl);
    });

    els.playlistList.appendChild(li);
  });
}

function renderPlaylistView(playlist) {
  const indices = shuffleArray(playlist.trackIds);
  els.trackGrid.innerHTML = "";
  indices.forEach((i) => {
    const track = state.tracks[i];
    if (!track) return;

    const coverSrc =
      track.cover && track.cover !== "undefined"
        ? track.cover
        : "https://picsum.photos/seed/symphoniaplaceholder/400/400";

    const card = document.createElement("div");
    card.className = "track-card";
    card.dataset.index = i;

    card.innerHTML = `
      <div class="track-cover-wrapper">
        <img src="${coverSrc}" alt="${track.title}" class="track-cover" />
        <div class="track-hover-play">▶</div>
      </div>
      <div class="track-meta">
        <div class="track-title">${track.title}</div>
        <div class="track-artist">${track.artist}</div>
      </div>
      <div class="track-tags">
        <span>${track.album || ""}</span>
        <button class="add-to-playlist-btn" data-index="${i}">+ Playlist</button>
      </div>
    `;

    els.trackGrid.appendChild(card);
  });
}

function createNewPlaylist() {
  const name = prompt("Playlist name:");
  if (!name) return;

  const id = generateId();
  state.playlists[id] = {
    id,
    name: name.trim(),
    trackIds: []
  };
  state.activePlaylistId = id;
  savePlaylistsToStorage();
  renderPlaylistSidebar();
}

function handleAddTrackToPlaylist(trackIndex) {
  let targetId = state.activePlaylistId;

  if (!targetId) {
    const ids = Object.keys(state.playlists);
    if (!ids.length) {
      const favId = generateId();
      state.playlists[favId] = {
        id: favId,
        name: "Favorites",
        trackIds: []
      };
      targetId = favId;
      state.activePlaylistId = favId;
    } else {
      targetId = ids[0];
      state.activePlaylistId = targetId;
    }
  }

  const pl = state.playlists[targetId];
  if (!pl.trackIds.includes(trackIndex)) {
    pl.trackIds.push(trackIndex);
  }

  savePlaylistsToStorage();
  renderPlaylistSidebar();
}

function generateId() {
  return Math.random().toString(36).slice(2, 9);
}

/* ========== MEDIA SESSION API ========== */

function initMediaSession() {
  if (!("mediaSession" in navigator)) return;

  const ms = navigator.mediaSession;

  ms.setActionHandler("play", () => {
    initVisualizer();
    els.audio.play().catch((err) =>
      console.error("mediaSession play failed:", err)
    );
    startVisualizerLoop();
  });
  ms.setActionHandler("pause", () => {
    els.audio.pause();
    stopVisualizerLoop();
  });
  ms.setActionHandler("previoustrack", () => {
    skipTrack(-1);
  });
  ms.setActionHandler("nexttrack", () => {
    skipTrack(1);
  });
  ms.setActionHandler("seekbackward", (details) => {
    const skip = details.seekOffset || 10;
    els.audio.currentTime = Math.max(els.audio.currentTime - skip, 0);
  });
  ms.setActionHandler("seekforward", (details) => {
    const skip = details.seekOffset || 10;
    els.audio.currentTime = Math.min(
      els.audio.currentTime + skip,
      els.audio.duration || Infinity
    );
  });
}

function updateMediaSessionMetadata(track) {
  if (!("mediaSession" in navigator)) return;

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album || "",
      artwork: track.cover
        ? [
            { src: track.cover, sizes: "96x96", type: "image/jpeg" },
            { src: track.cover, sizes: "256x256", type: "image/jpeg" },
            { src: track.cover, sizes: "512x512", type: "image/jpeg" }
          ]
        : []
    });
  } catch (e) {
    console.warn("Error updating Media Session metadata:", e);
  }
}

function updateMediaSessionPlaybackState(stateStr) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.playbackState = stateStr;
  } catch (e) {
    // ignore
  }
}

/* ========== VISUALIZER (WEB AUDIO API) ========== */

function initVisualizer() {
  if (!els.visualizer) return;
  if (visualizerState.ctx) return; // already initialized

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;

  const ctx = new AudioCtx();
  const source = ctx.createMediaElementSource(els.audio);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 64;

  source.connect(analyser);
  analyser.connect(ctx.destination);

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  visualizerState.ctx = ctx;
  visualizerState.analyser = analyser;
  visualizerState.dataArray = dataArray;

  const barCount = 24;
  els.visualizer.innerHTML = "";
  visualizerState.bars = [];

  for (let i = 0; i < barCount; i++) {
    const bar = document.createElement("div");
    bar.className = "visualizer-bar";
    els.visualizer.appendChild(bar);
    visualizerState.bars.push(bar);
  }
}

function startVisualizerLoop() {
  if (!visualizerState.analyser || !visualizerState.bars.length) return;

  if (visualizerState.ctx && visualizerState.ctx.state === "suspended") {
    visualizerState.ctx.resume();
  }

  if (visualizerState.rafId) {
    cancelAnimationFrame(visualizerState.rafId);
  }

  const render = () => {
    visualizerState.analyser.getByteFrequencyData(visualizerState.dataArray);

    const step = Math.max(
      1,
      Math.floor(
        visualizerState.dataArray.length / visualizerState.bars.length
      )
    );

    visualizerState.bars.forEach((bar, i) => {
      const value = visualizerState.dataArray[i * step] || 0;
      const height = 8 + (value / 255) * 40;
      bar.style.setProperty("--bar-height", `${height}px`);
      bar.style.opacity = els.audio.paused ? "0.25" : "0.7";
    });

    visualizerState.rafId = requestAnimationFrame(render);
  };

  render();
}

function stopVisualizerLoop() {
  if (visualizerState.rafId) {
    cancelAnimationFrame(visualizerState.rafId);
    visualizerState.rafId = null;
  }
  visualizerState.bars.forEach((bar) => {
    bar.style.setProperty("--bar-height", "8px");
    bar.style.opacity = "0.3";
  });
}
 