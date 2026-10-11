import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const FAVORITES_KEY = "tvvibe:favorites";
const HISTORY_KEY = "tvvibe:history";
const INTRO_SOUND_KEY = "jugaadtv:intro-sound";
const DEVICE_SESSION_KEY = "jugaadtv:device-session-id";
const LEGACY_GUEST_SESSION_KEY = "jugaadtv:guest-session-id";
const HISTORY_LIMIT = 12;
const PLAYER_INTRO_DURATION_MS = 5200;
const PLAYER_INTRO_STORY = [
  { end: 650, visual: "departure" },
  { end: 2800, visual: "approach" },
  { end: 3350, visual: "shutter" },
  { end: PLAYER_INTRO_DURATION_MS, visual: "finale" }
];
const HOT_CHANNEL_PRESETS = [
  { startsWith: "colors (576p)", badge: "576p · ENTERTAINMENT", tagline: "Entertainment • Colors", art: "colors" },
  { startsWith: "cnd film discovery channel (576p)", badge: "576p · DISCOVERY", tagline: "Documentary • Discovery", art: "discovery" },
  { startsWith: "colors cineplex (576p)", badge: "576p · MOVIES", tagline: "Movies • Colors Cineplex", art: "cineplex" },
  { startsWith: "sony max 2 (576p)", badge: "576p · MOVIES", tagline: "Movies • Sony Max 2", art: "sony" },
  { startsWith: "zee cinema (576p)", badge: "576p · MOVIES", tagline: "Movies • Zee Cinema", art: "zee" },
  { startsWith: "b4u movies (576p)", badge: "576p · MOVIES", tagline: "Movies • B4U", art: "gold" }
];
const guestMemoryStorage = new Map();
let storageFallbackWarned = false;

function warnStorageFallback(error) {
  if (storageFallbackWarned) return;
  storageFallbackWarned = true;
  console.warn("Persistent device storage is unavailable; preferences may only last for this browser session.", error);
}

function createDeviceSessionId() {
  const sessionToken = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 10);
  return `device-${sessionToken.slice(0, 8)}`;
}

function getOrCreateDeviceSession() {
  let deviceSessionId;
  try {
    deviceSessionId = localStorage.getItem(DEVICE_SESSION_KEY);
    if (!deviceSessionId) {
      deviceSessionId = createDeviceSessionId();
      localStorage.setItem(DEVICE_SESSION_KEY, deviceSessionId);
    }

    try {
      const legacyGuestSessionId = sessionStorage.getItem(LEGACY_GUEST_SESSION_KEY);
      for (const key of [FAVORITES_KEY, HISTORY_KEY, INTRO_SOUND_KEY]) {
        const deviceStorageKey = `${key}:${deviceSessionId}`;
        const currentValue = localStorage.getItem(deviceStorageKey);
        const tabValue = legacyGuestSessionId
          ? sessionStorage.getItem(`${key}:${legacyGuestSessionId}`)
          : null;
        const legacyValue = tabValue ?? localStorage.getItem(key);
        if (legacyValue === null) continue;
        if (currentValue === null) {
          localStorage.setItem(deviceStorageKey, legacyValue);
        } else if (key !== INTRO_SOUND_KEY) {
          const currentItems = JSON.parse(currentValue);
          const legacyItems = JSON.parse(legacyValue);
          if (Array.isArray(currentItems) && Array.isArray(legacyItems)) {
            const identity = (item) => key === FAVORITES_KEY ? item : item.id;
            const currentIds = new Set(currentItems.map(identity));
            const merged = [...currentItems, ...legacyItems.filter((item) =>
              !currentIds.has(identity(item))
            )];
            localStorage.setItem(
              deviceStorageKey,
              JSON.stringify(key === HISTORY_KEY ? merged.slice(0, HISTORY_LIMIT) : merged)
            );
          }
        }
      }
    } catch (error) {
      console.warn("Could not migrate saved guest preferences to this device.", error);
    }
    return deviceSessionId;
  } catch (error) {
    warnStorageFallback(error);
    try {
      const legacyGuestSessionId = sessionStorage.getItem(LEGACY_GUEST_SESSION_KEY);
      deviceSessionId = sessionStorage.getItem(DEVICE_SESSION_KEY) ||
        (legacyGuestSessionId ? `device-${legacyGuestSessionId}` : createDeviceSessionId());
      sessionStorage.setItem(DEVICE_SESSION_KEY, deviceSessionId);
      if (legacyGuestSessionId) {
        for (const key of [FAVORITES_KEY, HISTORY_KEY, INTRO_SOUND_KEY]) {
          const legacyValue = sessionStorage.getItem(`${key}:${legacyGuestSessionId}`);
          if (legacyValue !== null && sessionStorage.getItem(`${key}:${deviceSessionId}`) === null) {
            sessionStorage.setItem(`${key}:${deviceSessionId}`, legacyValue);
          }
        }
      }
      return deviceSessionId;
    } catch {
      return createDeviceSessionId();
    }
  }
}

function readDeviceStorage(key, deviceSessionId, fallback) {
  const storageKey = `${key}:${deviceSessionId}`;
  try {
    const value = localStorage.getItem(storageKey);
    if (value !== null) return JSON.parse(value);
  } catch (error) {
    warnStorageFallback(error);
  }
  try {
    const value = sessionStorage.getItem(storageKey);
    if (value !== null) return JSON.parse(value);
  } catch (error) {
    warnStorageFallback(error);
  }
  const value = guestMemoryStorage.get(storageKey);
  return value === undefined ? fallback : value;
}

function writeDeviceStorage(key, deviceSessionId, value) {
  const storageKey = `${key}:${deviceSessionId}`;
  guestMemoryStorage.set(storageKey, value);
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch (error) {
    warnStorageFallback(error);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(value));
    } catch (fallbackError) {
      warnStorageFallback(fallbackError);
    }
  }
}

function playbackStartError(video) {
  return video?.error?.code === 4
    ? "This browser cannot decode the stream audio/video format."
    : "Press play to start";
}

async function playIntroMusic(audioContextRef) {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) {
    console.warn("Web Audio is unavailable; starting the channel without the intro music.");
    return () => {};
  }

  try {
    const context = audioContextRef.current?.state !== "closed"
      ? audioContextRef.current
      : null;
    audioContextRef.current = context || new AudioContextConstructor();
    const audioContext = audioContextRef.current;
    if (audioContext.state === "suspended") await audioContext.resume();

    const startAt = audioContext.currentTime + 0.025;
    const duration = PLAYER_INTRO_DURATION_MS / 1000;
    const stopAtTime = startAt + duration;
    const trackGain = audioContext.createGain();
    trackGain.gain.value = 0.55;
    trackGain.connect(audioContext.destination);
    const activeNodes = new Set();
    const playTone = (frequency, time, noteDuration, volume, wave = "sine", endFrequency = frequency) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = wave;
      oscillator.frequency.setValueAtTime(frequency, time);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(endFrequency, 1), time + noteDuration);
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(volume, time + Math.min(0.025, noteDuration * 0.16));
      gain.gain.exponentialRampToValueAtTime(0.0001, time + noteDuration);
      oscillator.connect(gain);
      gain.connect(trackGain);
      activeNodes.add(oscillator);
      oscillator.onended = () => {
        activeNodes.delete(oscillator);
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(time);
      oscillator.stop(time + noteDuration + 0.015);
    };

    const steamDuration = 0.75;
    const steamBuffer = audioContext.createBuffer(1, Math.ceil(audioContext.sampleRate * steamDuration), audioContext.sampleRate);
    const steamSamples = steamBuffer.getChannelData(0);
    for (let index = 0; index < steamSamples.length; index += 1) steamSamples[index] = Math.random() * 2 - 1;
    const steam = audioContext.createBufferSource();
    const steamFilter = audioContext.createBiquadFilter();
    const steamGain = audioContext.createGain();
    steam.buffer = steamBuffer;
    steamFilter.type = "lowpass";
    steamFilter.frequency.setValueAtTime(180, startAt);
    steamFilter.frequency.exponentialRampToValueAtTime(1200, startAt + 0.48);
    steamGain.gain.setValueAtTime(0.0001, startAt);
    steamGain.gain.exponentialRampToValueAtTime(0.12, startAt + 0.25);
    steamGain.gain.exponentialRampToValueAtTime(0.0001, startAt + steamDuration);
    steam.connect(steamFilter);
    steamFilter.connect(steamGain);
    steamGain.connect(trackGain);
    activeNodes.add(steam);
    steam.onended = () => {
      activeNodes.delete(steam);
      steam.disconnect();
      steamFilter.disconnect();
      steamGain.disconnect();
    };
    steam.start(startAt);
    steam.stop(startAt + steamDuration);

    playTone(58, startAt, 0.7, 0.18, "sine", 36);
    playTone(880, startAt + 0.35, 0.75, 0.055, "triangle", 440);
    playTone(660, startAt + 0.58, 0.65, 0.035, "sine", 392);

    const shutterDuration = 0.018;
    const shutterBuffer = audioContext.createBuffer(1, Math.ceil(audioContext.sampleRate * shutterDuration), audioContext.sampleRate);
    const shutterSamples = shutterBuffer.getChannelData(0);
    for (let index = 0; index < shutterSamples.length; index += 1) shutterSamples[index] = Math.random() * 2 - 1;
    const shutterTimes = [0.68, 0.78, 0.89, 1, 1.12, 1.25, 1.38, 1.52, 1.67, 1.83, 2, 2.18, 2.36, 2.53, 2.69, 2.86, 3.04];
    shutterTimes.forEach((offset, index) => {
      const time = startAt + offset;
      const click = audioContext.createBufferSource();
      const filter = audioContext.createBiquadFilter();
      const gain = audioContext.createGain();
      click.buffer = shutterBuffer;
      filter.type = "bandpass";
      filter.frequency.value = index % 2 === 0 ? 1450 : 920;
      gain.gain.setValueAtTime(0.075, time);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + shutterDuration);
      click.connect(filter);
      filter.connect(gain);
      gain.connect(trackGain);
      activeNodes.add(click);
      click.onended = () => {
        activeNodes.delete(click);
        click.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
      click.start(time);
      click.stop(time + shutterDuration);
    });

    [0.12, 0.38, 0.64, 0.9, 1.16, 1.42, 1.68, 1.94, 2.2].forEach((offset, index) => {
      playTone(index % 2 === 0 ? 72 : 62, startAt + offset, 0.07, 0.045, "triangle", index % 2 === 0 ? 1.1 : 0.9);
    });
    [523, 659, 784, 988].forEach((frequency, index) => {
      playTone(frequency, startAt + 3.45 + index * 0.2, 0.28, 0.028, "sine");
    });

    let stopTimer = null;
    let stopped = false;
    const stopMusic = () => {
      if (stopped) return;
      stopped = true;
      if (stopTimer !== null) window.clearTimeout(stopTimer);
      stopTimer = null;
      const stopAt = audioContext.currentTime;
      trackGain.gain.cancelScheduledValues(stopAt);
      trackGain.gain.setTargetAtTime(0, stopAt, 0.04);
      activeNodes.forEach((node) => {
        node.stop(stopAt + 0.15);
      });
      activeNodes.clear();
      window.setTimeout(() => trackGain.disconnect(), 250);
    };
    stopTimer = window.setTimeout(stopMusic, Math.max(0, (stopAtTime - audioContext.currentTime) * 1000) + 100);
    return stopMusic;
  } catch (cause) {
    console.error("Could not play the JUGAADTV intro music:", cause);
    return () => {};
  }
}

function ChannelMark({ channel, className = "" }) {
  const [failed, setFailed] = useState(false);
  const logoUrl = channel.logo && /^https?:\/\//i.test(channel.logo) ? channel.logo : "";
  return logoUrl && !failed ? (
    <img className={`channel-mark ${className}`} src={logoUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
  ) : (
    <span className={`channel-mark channel-mark-fallback ${className}`} aria-hidden="true">
      {(channel.name || "TV").slice(0, 2).toUpperCase()}
    </span>
  );
}

function AdminDashboard() {
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/session").then((response) => response.json()),
      fetch("/api/health").then((response) => response.json())
    ]).then(([session, status]) => {
      setAuthenticated(session.authenticated === true);
      setHealth(status);
    }).catch(() => setMessage("Could not connect to the server."));
  }, []);

  async function signIn(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Admin sign in failed.");
      setAuthenticated(true);
      setPassword("");
      setMessage("Admin session is active.");
    } catch (cause) {
      setMessage(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function refreshPlaylist() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/refresh", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Refresh failed.");
      setMessage(`Playlist refreshed successfully: ${data.total.toLocaleString()} channels.`);
    } catch (cause) {
      setMessage(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await fetch("/api/admin/logout", { method: "POST" }).catch(() => {});
    setAuthenticated(false);
    setMessage("Signed out.");
  }

  return (
    <main className="admin-page">
      <header className="admin-topbar">
        <a className="brand" href="/" aria-label="Return to JUGAADTV"><span className="brand-icon">J</span><span>JUGAAD<span className="brand-accent">TV</span></span></a>
        <a className="secondary-button" href="/">← User player</a>
      </header>
      <section className="admin-dashboard">
        <div className="modal-mark">V</div>
        <p className="section-kicker">PRIVATE CONTROL PANEL</p>
        <h1>Admin dashboard</h1>
        <p className="modal-copy">Manage the shared channel catalogue. User watch lists and history stay in each user's browser.</p>
        <div className="admin-stats">
          <div><span>Service</span><strong>{health?.ok ? "Online" : "…"}</strong></div>
          <div><span>Admin password</span><strong>{health?.adminConfigured ? "Enabled" : "Disabled"}</strong></div>
        </div>
        {!authenticated ? (
          <form onSubmit={signIn} className="admin-form">
            <label htmlFor="admin-password">Admin password</label>
            <input id="admin-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
            <button className="primary-button full-button" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
            {!health?.adminConfigured && <p className="admin-hint">Set <code>ADMIN_PASSWORD</code> in the server environment, then restart the app.</p>}
          </form>
        ) : (
          <div className="admin-actions">
            <button className="primary-button full-button" onClick={refreshPlaylist} disabled={busy}>{busy ? "Refreshing…" : "↻ Refresh public playlist"}</button>
            <button className="secondary-button full-button" onClick={signOut}>Sign out</button>
          </div>
        )}
        {message && <p className="admin-message" role="status">{message}</p>}
      </section>
      <footer className="footer admin-footer"><span><span className="brand-mini">J</span> JUGAADTV</span><span>Admin controls are separate from the user player.</span></footer>
    </main>
  );
}

function App() {
  const [deviceSessionId] = useState(getOrCreateDeviceSession);
  const videoRef = useRef(null);
  const audioContextRef = useRef(null);
  const hlsRef = useRef(null);
  const selectedRef = useRef(null);
  const recoveryTimerRef = useRef(null);
  const recoveryCountRef = useRef(0);
  const failoverCountRef = useRef(0);
  const mediaRecoveryRef = useRef(false);
  const qualityRef = useRef(-1);
  const introSequenceRef = useRef(0);
  const introContinuationRef = useRef(null);
  const introMusicStopRef = useRef(null);
  const bypassPlayerIntroRef = useRef(false);
  const startupPlaybackStartedRef = useRef(false);
  const [channels, setChannels] = useState([]);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");
  const [country, setCountry] = useState("all");
  const [category, setCategory] = useState("all");
  const [tab, setTab] = useState(() => {
    const recent = readDeviceStorage(HISTORY_KEY, deviceSessionId, []);
    return Array.isArray(recent) && recent.length > 0 ? "recent" : "all";
  });
  const [favorites, setFavorites] = useState(() => readDeviceStorage(FAVORITES_KEY, deviceSessionId, []));
  const [history, setHistory] = useState(() => readDeviceStorage(HISTORY_KEY, deviceSessionId, []));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [playerStatus, setPlayerStatus] = useState("Choose a channel");
  const [isPlaying, setIsPlaying] = useState(false);
  const [qualityLevels, setQualityLevels] = useState([]);
  const [quality, setQuality] = useState(-1);
  const [toast, setToast] = useState("");
  const [showAbout, setShowAbout] = useState(false);
  const [showPlayerIntro, setShowPlayerIntro] = useState(false);
  const [playerIntroElapsed, setPlayerIntroElapsed] = useState(0);
  const [playerIntroRun, setPlayerIntroRun] = useState(0);
  const [introSoundEnabled, setIntroSoundEnabled] = useState(() => readDeviceStorage(INTRO_SOUND_KEY, deviceSessionId, true));

  useEffect(() => writeDeviceStorage(FAVORITES_KEY, deviceSessionId, favorites), [favorites, deviceSessionId]);
  useEffect(() => writeDeviceStorage(HISTORY_KEY, deviceSessionId, history), [history, deviceSessionId]);
  useEffect(() => writeDeviceStorage(INTRO_SOUND_KEY, deviceSessionId, introSoundEnabled), [introSoundEnabled, deviceSessionId]);
  useEffect(() => {
    if (introSoundEnabled) return;
    introMusicStopRef.current?.();
    introMusicStopRef.current = null;
  }, [introSoundEnabled]);

  useEffect(() => {
    if (!showPlayerIntro) return undefined;
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      setPlayerIntroElapsed(Math.min(PLAYER_INTRO_DURATION_MS, performance.now() - startedAt));
    }, 250);
    return () => window.clearInterval(timer);
  }, [showPlayerIntro, playerIntroRun]);

  useEffect(() => {
    if (!showAbout) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setShowAbout(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showAbout]);

  const loadChannels = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/channels");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Channel list could not be loaded.");
      setChannels(data.channels);
    } catch (cause) {
      setError(`${cause.message} Please check your connection and refresh the page.`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  const countries = useMemo(() => [...new Set(channels.map((item) => item.country).filter(Boolean))].sort(), [channels]);
  const categories = useMemo(() => [...new Set(channels.map((item) => item.category).filter(Boolean))].sort(), [channels]);
  const visibleChannels = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return channels.filter((channel) => {
      const matchesSearch = !query || [channel.name, channel.country, channel.category, channel.language]
        .some((value) => value?.toLocaleLowerCase().includes(query));
      const matchesCountry = country === "all" || channel.country === country;
      const matchesCategory = category === "all" || channel.category === category;
      const matchesTab = tab === "all" ||
        (tab === "favorites" && favorites.includes(channel.id)) ||
        (tab === "recent" && history.some((item) => item.id === channel.id));
      return matchesSearch && matchesCountry && matchesCategory && matchesTab;
    });
  }, [channels, search, country, category, tab, favorites, history]);
  const hotChannels = useMemo(() => {
    const usedIds = new Set();
    return HOT_CHANNEL_PRESETS.flatMap((preset) => {
      const channel = channels.find((item) =>
        item.name?.toLocaleLowerCase().startsWith(preset.startsWith) &&
        !/\[geo-blocked\]/i.test(item.name)
      );
      if (!channel || usedIds.has(channel.id)) return [];
      usedIds.add(channel.id);
      return [{ ...preset, channel }];
    });
  }, [channels]);

  const notify = (message) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };

  const playChannelRef = useRef(null);
  const failoverToNext = useCallback((channel, reason) => {
    if (selectedRef.current?.id !== channel.id) return;
    const currentIndex = channels.findIndex((item) => item.id === channel.id);
    const nextChannel = channels.slice(Math.max(currentIndex + 1, 0)).find((item) => item.id !== channel.id);
    if (nextChannel && failoverCountRef.current < 3) {
      failoverCountRef.current += 1;
      recoveryCountRef.current = 0;
      setPlayerStatus(`${reason} Trying ${nextChannel.name}…`);
      playChannelRef.current?.(nextChannel, true);
    } else {
      setIsPlaying(false);
      setPlayerStatus("Stream is unavailable. Choose another channel.");
    }
  }, [channels]);

  const scheduleRecovery = useCallback((channel, delay = 15000, forceFailover = false) => {
    if (recoveryTimerRef.current !== null) {
      if (!forceFailover) return;
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    recoveryTimerRef.current = window.setTimeout(() => {
      recoveryTimerRef.current = null;
      if (selectedRef.current?.id !== channel.id) return;
      if (forceFailover) {
        failoverToNext(channel, "Stream unavailable.");
        return;
      }
      if (recoveryCountRef.current < 1) {
        recoveryCountRef.current += 1;
        if (hlsRef.current) {
          const levels = hlsRef.current.levels;
          if (qualityRef.current === -1 && levels.length > 1) {
            const lowestLevel = levels.reduce((bestIndex, level, index, allLevels) => {
              const score = (item) => item.height || item.bitrate;
              return score(level) < score(allLevels[bestIndex]) ? index : bestIndex;
            }, 0);
            qualityRef.current = lowestLevel;
            setQuality(lowestLevel);
            const height = levels[lowestLevel].height;
            setPlayerStatus(`Weak connection — switching to ${height ? `${height}p` : "lower"} quality…`);
            hlsRef.current.currentLevel = lowestLevel;
          } else {
            setPlayerStatus("Reconnecting stream…");
            hlsRef.current.startLoad(-1);
          }
        } else if (videoRef.current) {
          setPlayerStatus("Reconnecting stream…");
          videoRef.current.load();
          bypassPlayerIntroRef.current = true;
          videoRef.current.play().catch(() => {});
        }
        scheduleRecovery(channel);
        return;
      }

      setIsPlaying(false);
      setPlayerStatus("Still buffering. Keep waiting or choose another channel.");
    }, delay);
  }, [failoverToNext]);

  const runPlayerIntro = useCallback(async (continuePlayback) => {
    const sequence = introSequenceRef.current + 1;
    introSequenceRef.current = sequence;
    introMusicStopRef.current?.();
    introMusicStopRef.current = null;
    introContinuationRef.current = continuePlayback;
    videoRef.current?.pause();
    setIsPlaying(false);
    setPlayerStatus("JUGAADTV Studios presents…");
    setPlayerIntroElapsed(0);
    setPlayerIntroRun((run) => run + 1);
    setShowPlayerIntro(true);

    const startedAt = performance.now();
    if (introSoundEnabled) {
      const stopMusic = await playIntroMusic(audioContextRef);
      if (sequence !== introSequenceRef.current) {
        stopMusic();
        return;
      }
      introMusicStopRef.current = stopMusic;
    }
    const remaining = Math.max(0, PLAYER_INTRO_DURATION_MS - (performance.now() - startedAt));
    if (remaining) await new Promise((resolve) => window.setTimeout(resolve, remaining));
    if (sequence !== introSequenceRef.current) return;

    introMusicStopRef.current?.();
    introMusicStopRef.current = null;
    introContinuationRef.current = null;
    setShowPlayerIntro(false);
    bypassPlayerIntroRef.current = true;
    continuePlayback();
  }, [introSoundEnabled]);

  const skipPlayerIntro = useCallback(() => {
    const continuePlayback = introContinuationRef.current;
    if (!continuePlayback) return;
    introSequenceRef.current += 1;
    introContinuationRef.current = null;
    introMusicStopRef.current?.();
    introMusicStopRef.current = null;
    setShowPlayerIntro(false);
    bypassPlayerIntroRef.current = true;
    continuePlayback();
  }, []);

  const activeIntroStory = PLAYER_INTRO_STORY.find(({ end }) => playerIntroElapsed < end) || PLAYER_INTRO_STORY.at(-1);
  const playerIntroProgress = Math.min(100, playerIntroElapsed / PLAYER_INTRO_DURATION_MS * 100);

  const playChannel = useCallback((channel, automaticFailover = false, usingRelay = false) => {
    const video = videoRef.current;
    if (!video || !channel) return;
    const streamUrl = usingRelay
      ? `/api/stream-handler?channelId=${encodeURIComponent(channel.id)}`
      : channel.url;
    window.clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = null;
    if (!automaticFailover) {
      recoveryCountRef.current = 0;
      failoverCountRef.current = 0;
    }
    mediaRecoveryRef.current = false;
    selectedRef.current = channel;
    setSelected(channel);
    setPlayerStatus("Connecting…");
    setIsPlaying(false);
    qualityRef.current = -1;
    setQualityLevels([]);
    setQuality(-1);
    setHistory((current) => [channel, ...current.filter((item) => item.id !== channel.id)].slice(0, HISTORY_LIMIT));
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    video.pause();
    video.removeAttribute("src");
    video.load();
    const onPlaying = () => {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
      recoveryCountRef.current = 0;
      failoverCountRef.current = 0;
      setIsPlaying(true);
      setPlayerStatus("On air");
    };
    const onWaiting = () => {
      const selectedLevel = hlsRef.current?.levels[qualityRef.current];
      setPlayerStatus(selectedLevel?.height ? `Buffering at ${selectedLevel.height}p…` : "Buffering…");
      scheduleRecovery(channel);
    };
    const onError = () => {
      setIsPlaying(false);
      if (hlsRef.current) {
        setPlayerStatus("Recovering playback…");
        return;
      }
      if (!usingRelay && video.error?.code !== 4) {
        setPlayerStatus("Direct stream failed; retrying through the player relay…");
        playChannelRef.current?.(channel, true, true);
        return;
      }
      setPlayerStatus("Stream unavailable");
      scheduleRecovery(channel);
    };
    const onCanPlay = () => {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
      if (!video.paused) setPlayerStatus("On air");
    };
    const onPlay = () => {
      if (bypassPlayerIntroRef.current) {
        bypassPlayerIntroRef.current = false;
        return;
      }
      video.pause();
      runPlayerIntro(() => {
        video.play().catch(() => {
          bypassPlayerIntroRef.current = false;
          setPlayerStatus(playbackStartError(video));
        });
      });
    };
    video.onplay = onPlay;
    video.onplaying = onPlaying;
    video.onwaiting = onWaiting;
    video.onerror = onError;
    video.onstalled = onWaiting;
    video.oncanplay = onCanPlay;

    const isDirectMediaFile = /\.(?:mp4|m4v|webm|mov|mp3|aac|ogg|opus|wav|flac)(?:$|[?#])/i.test(channel.url);
    const isHls = !isDirectMediaFile;
    scheduleRecovery(channel);
    if (isHls) {
      import("hls.js").then(({ default: Hls }) => {
        if (selectedRef.current?.id !== channel.id) return;
        if (!Hls.isSupported()) {
          if (video.canPlayType("application/vnd.apple.mpegurl")) {
            setQualityLevels([]);
            video.src = streamUrl;
            video.play().catch(() => setPlayerStatus(playbackStartError(video)));
            return;
          }
          setPlayerStatus("HLS not supported by this browser");
          return;
        }
        const hls = new Hls({ enableWorker: true });
        hlsRef.current = hls;
        const updateQualityLevels = (levels = []) => {
          const availableLevels = levels
            .map((level, index) => ({ index, height: level.height || 0, bitrate: level.bitrate || 0 }))
            .sort((a, b) => a.height - b.height || a.bitrate - b.bitrate);
          setQualityLevels(availableLevels);
          setQuality(-1);
        };
        hls.on(Hls.Events.ERROR, (_event, data) => {
          const statusCode = data.response?.code;
          const isLoadError = typeof data.details === "string" &&
            /(?:manifest|level|frag).*loaderror/i.test(data.details);
          const shouldTryRelay = !usingRelay && (
            [0, 403, 404, 410].includes(statusCode) ||
            (data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR) ||
            (statusCode === 0 && isLoadError)
          );
          if (shouldTryRelay) {
            setPlayerStatus(statusCode && statusCode !== 0
              ? `Direct stream rejected (HTTP ${statusCode}); retrying through relay…`
              : "Direct stream unavailable in browser; retrying through relay…");
            hls.destroy();
            if (hlsRef.current === hls) hlsRef.current = null;
            playChannelRef.current?.(channel, true, true);
            return;
          }
          if ([403, 404, 410].includes(statusCode)) {
            setPlayerStatus(`Stream rejected (HTTP ${statusCode}); trying another channel…`);
            hls.destroy();
            if (hlsRef.current === hls) hlsRef.current = null;
            scheduleRecovery(channel, 900, true);
            return;
          }
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            if (!mediaRecoveryRef.current) {
              mediaRecoveryRef.current = true;
              window.clearTimeout(recoveryTimerRef.current);
              recoveryTimerRef.current = null;
              setPlayerStatus("Recovering video decoder…");
              hls.recoverMediaError();
            } else {
              window.clearTimeout(recoveryTimerRef.current);
              recoveryTimerRef.current = null;
              setIsPlaying(false);
              setPlayerStatus("This browser cannot decode this stream's audio. Try another device or channel.");
              hls.stopLoad();
            }
            return;
          }
          setPlayerStatus("Stream failed; switching channel…");
          hls.destroy();
          if (hlsRef.current === hls) hlsRef.current = null;
          scheduleRecovery(channel, 900, true);
        });
        hls.on(Hls.Events.MANIFEST_LOADED, (_event, data) => {
          updateQualityLevels(data.levels);
        });
        hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
          updateQualityLevels(data.levels);
          setPlayerStatus("Stream ready");
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => setPlayerStatus(playbackStartError(video)));
        });
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
      }).catch((cause) => {
        console.error("Could not load HLS playback support:", cause);
        setPlayerStatus("Could not load HLS playback support");
      });
      return;
    }
    video.src = streamUrl;
    video.play().catch(() => setPlayerStatus(playbackStartError(video)));
  }, [runPlayerIntro, scheduleRecovery]);

  useEffect(() => {
    playChannelRef.current = playChannel;
  }, [playChannel]);

  const startChannel = useCallback(async (channel) => {
    if (!channel) return;
    runPlayerIntro(() => playChannel(channel));
  }, [playChannel, runPlayerIntro]);

  useEffect(() => {
    if (loading || startupPlaybackStartedRef.current || channels.length === 0) return;
    const recentChannel = history
      .map((recent) => channels.find((channel) => channel.id === recent.id))
      .find(Boolean);
    const defaultChannel = recentChannel ||
      hotChannels.find(({ channel }) => channel.name?.toLocaleLowerCase().startsWith("colors (576p)"))?.channel;
    if (!defaultChannel) return;
    startupPlaybackStartedRef.current = true;
    setTab("recent");
    startChannel(defaultChannel);
  }, [channels, history, hotChannels, loading, startChannel]);

  const resumePlayback = useCallback(() => {
    runPlayerIntro(() => videoRef.current?.play().catch(() => setPlayerStatus(playbackStartError(videoRef.current))));
  }, [runPlayerIntro]);

  useEffect(() => () => {
    window.clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = null;
    introSequenceRef.current += 1;
    introContinuationRef.current = null;
    introMusicStopRef.current?.();
    introMusicStopRef.current = null;
    hlsRef.current?.destroy();
    audioContextRef.current?.close();
  }, []);

  function changeQuality(value) {
    const level = Number(value);
    qualityRef.current = level;
    setQuality(level);
    if (hlsRef.current) {
      const retrying = mediaRecoveryRef.current;
      hlsRef.current.currentLevel = level;
      if (retrying) {
        hlsRef.current.recoverMediaError();
        hlsRef.current.startLoad(-1);
      }
      mediaRecoveryRef.current = false;
      if (level < 0) hlsRef.current.autoLevelCapping = -1;
      const height = qualityLevels.find((item) => item.index === level)?.height;
      setPlayerStatus(retrying
        ? level < 0 ? "Retrying in Auto quality…" : `Retrying at ${height || "selected"}p…`
        : level < 0 ? "Auto quality" : `${height || "Selected"}p`);
    }
  }

  const toggleFavorite = (channel) => {
    const alreadySaved = favorites.includes(channel.id);
    setFavorites((items) => alreadySaved ? items.filter((id) => id !== channel.id) : [channel.id, ...items]);
    notify(alreadySaved ? "Removed from My List" : "Added to My List");
  };

  if (window.location.pathname === "/admin") return <AdminDashboard />;

  return (
    <>
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="JUGAADTV home">
          <span className="brand-icon">J</span><span>JUGAAD<span className="brand-accent">TV</span></span>
        </a>
        <nav className="main-nav" aria-label="Main navigation">
          <button className={`nav-link ${tab === "all" ? "active" : ""}`} onClick={() => setTab("all")}>Discover</button>
          <button className={`nav-link ${tab === "recent" ? "active" : ""}`} onClick={() => setTab("recent")}>Recently watched</button>
          <button className={`nav-link ${tab === "favorites" ? "active" : ""}`} onClick={() => setTab("favorites")}>My list <span className="nav-count">{favorites.length}</span></button>
          <button className={`nav-link ${tab === "creator" ? "active" : ""}`} onClick={() => setTab("creator")}>Creator</button>
        </nav>
        <div className="top-actions">
          <button className="icon-button sound-toggle" onClick={() => setIntroSoundEnabled((enabled) => !enabled)} aria-label={introSoundEnabled ? "Mute JUGAADTV intro sound" : "Enable JUGAADTV intro sound"} aria-pressed={introSoundEnabled} title={introSoundEnabled ? "Intro sound on" : "Intro sound off"}>
            {introSoundEnabled ? "♫" : "×"}
          </button>
          <div className="profile-button" aria-label={`Device session ${deviceSessionId}; preferences are private to this browser on this device`} title={`Device session ${deviceSessionId}`}>
            <span className="profile-avatar">D</span><span className="profile-label">Device · {deviceSessionId.slice(-4)}</span>
          </div>
        </div>
      </header>

      <section className="hero">
        <div className="hero-glow" />
        <div className="hero-content">
          <div className="eyebrow"><span className="live-dot" /> YOUR SCREEN. YOUR CHANNELS.</div>
          <h1>Live TV, <span>your way.</span></h1>
          <p>Explore free-to-air streams from around the world. Channels load automatically.</p>
          <div className="hero-actions">
            <button className="primary-button" onClick={() => selected ? !isPlaying && resumePlayback() : startChannel(visibleChannels[0])}>
              <span className="button-play">{isPlaying ? "Ⅱ" : "▶"}</span>{isPlaying ? "Now playing" : "Watch live"}
            </button>
            <button className={`secondary-button ${selected && favorites.includes(selected.id) ? "saved" : ""}`} onClick={() => selected && toggleFavorite(selected)}>
              <span>{selected && favorites.includes(selected.id) ? "✓" : "+"}</span> My list
            </button>
          </div>
          {selected && <div className="hero-current"><span className="hero-current-label">NOW PLAYING</span><strong>{selected.name}</strong><span className="current-status"><i />{playerStatus}</span></div>}
        </div>
        <div className="hero-player-wrap">
          <div className="player-frame">
            <video ref={videoRef} controls playsInline poster="" aria-label="Live TV player" />
            {showPlayerIntro && (
              <div className={`player-intro-overlay stage-${activeIntroStory.visual}`} role="status" aria-label="JUGAADTV cinematic train intro">
                <div className="story-sky">
                  <span className="story-moon" />
                  <div className="story-stars" />
                  <div className="journey-mountains journey-mountains-back" />
                  <div className="journey-mountains journey-mountains-front" />
                  <div className="journey-city" />
                  <div className="story-platform" />
                  <div className="story-camera-rails" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div>
                  <svg className="story-train" viewBox="0 0 1120 250" role="presentation" aria-hidden="true">
                    <defs>
                      <linearGradient id="trainBody" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0" stopColor="#f4dfe0" />
                        <stop offset=".19" stopColor="#a7202b" />
                        <stop offset="1" stopColor="#4c1119" />
                      </linearGradient>
                      <linearGradient id="trainWindow" x1="0" x2="1" y1="0" y2="1">
                        <stop offset="0" stopColor="#fff3cc" />
                        <stop offset="1" stopColor="#de6260" />
                      </linearGradient>
                    </defs>
                    <g className="train-coach">
                      <path d="M15 54 Q15 33 40 33 H242 Q267 33 267 58 V166 H15 Z" fill="url(#trainBody)" stroke="#f6b5a2" strokeWidth="3" />
                      <path d="M15 135 H267 V166 H15 Z" fill="#271116" />
                      <path d="M34 48 H248 V58 H34 Z" fill="#f4dfe0" opacity=".9" />
                      <rect x="35" y="70" width="45" height="51" rx="7" fill="url(#trainWindow)" />
                      <rect x="93" y="70" width="45" height="51" rx="7" fill="url(#trainWindow)" />
                      <rect x="151" y="70" width="45" height="51" rx="7" fill="url(#trainWindow)" />
                      <rect x="209" y="70" width="39" height="51" rx="7" fill="url(#trainWindow)" />
                      <path d="M267 100 H283 V163 H267" fill="#291116" stroke="#bd4c50" strokeWidth="4" />
                    </g>
                    <g className="train-coach train-coach-two" transform="translate(282)">
                      <path d="M15 54 Q15 33 40 33 H242 Q267 33 267 58 V166 H15 Z" fill="url(#trainBody)" stroke="#f6b5a2" strokeWidth="3" />
                      <path d="M15 135 H267 V166 H15 Z" fill="#271116" />
                      <path d="M34 48 H248 V58 H34 Z" fill="#f4dfe0" opacity=".9" />
                      <rect x="35" y="70" width="45" height="51" rx="7" fill="url(#trainWindow)" />
                      <rect x="93" y="70" width="45" height="51" rx="7" fill="url(#trainWindow)" />
                      <rect x="151" y="70" width="45" height="51" rx="7" fill="url(#trainWindow)" />
                      <rect x="209" y="70" width="39" height="51" rx="7" fill="url(#trainWindow)" />
                      <path d="M267 100 H283 V163 H267" fill="#291116" stroke="#bd4c50" strokeWidth="4" />
                    </g>
                    <g className="train-coach train-coach-three" transform="translate(564)">
                      <path d="M15 54 Q15 33 40 33 H242 Q267 33 267 58 V166 H15 Z" fill="url(#trainBody)" stroke="#f6b5a2" strokeWidth="3" />
                      <path d="M15 135 H267 V166 H15 Z" fill="#271116" />
                      <path d="M34 48 H248 V58 H34 Z" fill="#f4dfe0" opacity=".9" />
                      <rect x="35" y="70" width="45" height="51" rx="7" fill="url(#trainWindow)" />
                      <rect x="93" y="70" width="45" height="51" rx="7" fill="url(#trainWindow)" />
                      <rect x="151" y="70" width="45" height="51" rx="7" fill="url(#trainWindow)" />
                      <rect x="209" y="70" width="39" height="51" rx="7" fill="url(#trainWindow)" />
                      <path d="M267 100 H283 V163 H267" fill="#291116" stroke="#bd4c50" strokeWidth="4" />
                    </g>
                    <g className="train-engine" transform="translate(846)">
                      <path d="M12 166 V89 Q12 30 72 30 H190 Q224 30 254 81 L290 113 V166 Z" fill="url(#trainBody)" stroke="#ffc6aa" strokeWidth="3" />
                      <path d="M99 47 H185 Q205 47 224 82 H99 Z" fill="url(#trainWindow)" />
                      <path d="M12 132 H290 V166 H12 Z" fill="#261116" />
                      <path d="M34 149 H265" stroke="#e9b7a0" strokeWidth="4" />
                      <path d="M71 30 Q78 8 104 8 H143 L158 30" fill="#7b1721" stroke="#ffc6aa" strokeWidth="3" />
                      <circle cx="274" cy="112" r="11" fill="#fff0c4" className="train-headlight" />
                      <path d="M286 166 H314 L293 190 H263 Z" fill="#b82d38" />
                    </g>
                    <g>
                      {[65, 220, 347, 502, 629, 784, 932, 1080].map((x) => (
                        <g key={x} transform={`translate(${x} 172)`}>
                          <g className="train-wheel-spin">
                            <circle r="19" fill="#151115" stroke="#df9a86" strokeWidth="4" />
                            <path d="M-12 0 H12 M0 -12 V12" stroke="#c35d58" strokeWidth="3" />
                            <circle r="5" fill="#e6a08b" />
                          </g>
                        </g>
                      ))}
                    </g>
                  </svg>
                  <div className="story-rail" />
                  <div className="story-rail-glow" />
                  <div className="story-film-frame" aria-hidden="true" />
                  <div className="story-shutter" aria-hidden="true" />
                </div>
                {activeIntroStory.visual === "finale" && (
                  <div className="story-final-card" key={playerIntroRun}>
                    <span className="story-final-eyebrow">JUGAADTV ORIGINAL</span>
                    <strong className="story-wordmark" aria-label="JUGAADTV">{Array.from("JUGAADTV", (letter, index) => <span key={index} className={index > 5 ? "story-wordmark-accent" : ""} style={{ "--letter-index": index }}>{letter}</span>)}</strong>
                    <i className="story-final-tagline">LIVE TV. APNE TAREEKE SE.</i>
                  </div>
                )}
                <div className="story-music-visualizer" aria-hidden="true">{Array.from({ length: 32 }, (_, index) => <i key={index} style={{ height: `${16 + (index * 29 % 71)}%`, animationDelay: `${index % 8 * -0.13}s` }} />)}</div>
                <div className="story-progress" role="progressbar" aria-label="Intro progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(playerIntroProgress)}>
                  <i style={{ transform: `scaleX(${playerIntroProgress / 100})` }} />
                </div>
                <span className="story-time">{Math.ceil((PLAYER_INTRO_DURATION_MS - playerIntroElapsed) / 1000)} SEC</span>
                <button className="player-intro-skip" onClick={skipPlayerIntro}>Skip intro <span aria-hidden="true">→</span></button>
              </div>
            )}
            {!selected && <div className="player-placeholder"><span className="placeholder-play">▶</span><span>Choose a channel to start watching</span></div>}
            {selected && playerStatus === "Press play to start" && <button className="play-overlay" onClick={resumePlayback}>▶ Play stream</button>}
            {selected && !isPlaying && (playerStatus.startsWith("This stream’s") || playerStatus.startsWith("This browser") || playerStatus.startsWith("Stream unavailable")) && <button className="play-overlay" onClick={() => startChannel(selected)}>↻ Retry {selected.name}</button>}
            {selected && <div className="player-label"><span className="live-dot" /> LIVE</div>}
            {qualityLevels.length > 0 && <label className="quality-control" aria-label="Stream quality"><span>QUALITY</span><select value={quality} onChange={(event) => changeQuality(event.target.value)}><option value={-1}>Auto</option>{qualityLevels.map((level) => <option key={level.index} value={level.index}>{level.height ? `${level.height}p` : `${Math.round(level.bitrate / 1000)} kbps`}</option>)}</select></label>}
          </div>
          <div className="player-caption"><span className="equalizer"><i /><i /><i /><i /></span><span>{selected?.name || "JUGAADTV Player"}</span><span className="caption-status">{playerStatus}</span></div>
        </div>
      </section>

      {tab === "all" && !search && country === "all" && category === "all" && hotChannels.length > 0 && (
        <section className="hot-section" aria-labelledby="hot-heading">
          <div className="hot-heading">
            <div>
              <p className="section-kicker"><span className="hot-flame">✦</span> HAND-PICKED FOR YOU</p>
              <h2 id="hot-heading">Hot on JUGAADTV</h2>
              <p>Movie nights, reality favorites and worlds worth exploring.</p>
            </div>
            <span className="hot-heading-mark" aria-hidden="true">J<span>TV</span></span>
          </div>
          <div className="hot-posters">
            {hotChannels.map(({ channel, badge, tagline, art }, index) => (
              <button
                key={channel.id}
                className={`hot-poster hot-poster-${art} ${selected?.id === channel.id ? "hot-poster-selected" : ""}`}
                onClick={() => startChannel(channel)}
                aria-label={`Play ${channel.name}, ${badge}`}
                style={{ "--poster-index": index }}
              >
                <span className="hot-poster-art">
                  <span className="hot-poster-orbit" aria-hidden="true" />
                  <ChannelMark channel={channel} className="hot-poster-logo" />
                  <span className="hot-poster-badge">{badge}</span>
                  <span className="hot-poster-play" aria-hidden="true">▶</span>
                  <span className="hot-poster-vignette" aria-hidden="true" />
                </span>
                <span className="hot-poster-info">
                  <strong title={channel.name}>{channel.name}</strong>
                  <small>{tagline}</small>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {tab === "creator" && (
        <section className="creator-section" aria-labelledby="creator-heading">
          <div className="creator-profile">
            <div className="creator-photo-frame">
              <img src="/images/farman-haider.png" alt="Farman Haider, creator of JUGAADTV" />
              <span className="creator-photo-glow" aria-hidden="true" />
              <span className="creator-photo-label"><i /> JUGAADTV CREATOR</span>
            </div>
            <div className="creator-profile-copy">
              <p className="section-kicker"><span className="live-dot" /> MEET THE CREATOR</p>
              <h2 id="creator-heading">Hi, I’m <span>Farman Haider.</span></h2>
              <p className="creator-lede">The person behind JUGAADTV.</p>
              <p className="creator-description">I built JUGAADTV to make discovering live channels feel simple, enjoyable, and personal. Thanks for being part of the journey.</p>
              <div className="creator-actions">
                <a className="primary-button" href="https://www.linkedin.com/in/farman-haider-6a771933b/" target="_blank" rel="noreferrer">View my portfolio <span aria-hidden="true">↗</span></a>
                <a className="secondary-button" href="https://www.linkedin.com/in/farman-haider-6a771933b/" target="_blank" rel="noreferrer"><span aria-hidden="true">✉</span> Get support</a>
              </div>
              <div className="creator-signoff"><span>J</span><i /> Made with jugaad, for your screen.</div>
            </div>
          </div>
          <div className="creator-bottom-line"><span>ABOUT THE CREATOR</span><span>Portfolio, questions, or feedback? Connect on LinkedIn.</span></div>
        </section>
      )}

      {tab !== "creator" && <section className="browse-section">
        <div className="browse-heading">
          <div>
            <p className="section-kicker">THE WORLD IS ON</p>
            <h2>{tab === "favorites" ? "Your list" : tab === "recent" ? "Pick up where you left off" : "Find your next channel"}</h2>
            <p className="section-subtitle">{loading ? "Loading channels…" : `${visibleChannels.length.toLocaleString()} channels${channels.length ? ` · ${channels.length.toLocaleString()} total` : ""}`}</p>
          </div>
          <div className="filter-controls">
            <label className="search-box"><span>⌕</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search channels" aria-label="Search channels" /><kbd>⌘ K</kbd></label>
            <select value={country} onChange={(event) => setCountry(event.target.value)} aria-label="Filter by country">
              <option value="all">All countries</option>{countries.map((item) => <option key={item}>{item}</option>)}
            </select>
            <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filter by category">
              <option value="all">All categories</option>{categories.map((item) => <option key={item}>{item}</option>)}
            </select>
          </div>
        </div>

        {error && <div className="notice"><span>!</span><div>{error}</div><button onClick={() => setError("")} aria-label="Dismiss">×</button></div>}
        {loading ? (
          <div className="channel-grid loading-grid">{Array.from({ length: 8 }, (_, index) => <div className="skeleton-card" key={index} />)}</div>
        ) : visibleChannels.length ? (
          <div className="channel-grid">
            {visibleChannels.slice(0, 180).map((channel) => (
              <article key={channel.id} className={`channel-card ${selected?.id === channel.id ? "selected" : ""}`}>
                <button className="channel-select" onClick={() => startChannel(channel)} aria-label={`Play ${channel.name}`}>
                  <ChannelMark channel={channel} />
                  <span className="channel-copy"><strong title={channel.name}>{channel.name}</strong><small>{channel.country} <i>·</i> {channel.category}</small></span>
                  <span className="card-play">▶</span>
                </button>
                <button className={`favorite-button ${favorites.includes(channel.id) ? "favorited" : ""}`} onClick={() => toggleFavorite(channel)} aria-label={favorites.includes(channel.id) ? "Remove from My List" : "Add to My List"}>
                  {favorites.includes(channel.id) ? "♥" : "♡"}
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-results"><span>{tab === "favorites" ? "♡" : "⌕"}</span><strong>{tab === "favorites" ? "Your list is waiting" : tab === "recent" ? "Nothing watched yet" : "No channels found"}</strong><p>{tab === "favorites" ? "Tap the heart on any channel to save it here." : tab === "recent" ? "Pick a channel and it will show up here." : "Try another search or country/category filter."}</p></div>
        )}

        {visibleChannels.length > 180 && <p className="result-limit">Showing the first 180 results. Narrow your search to find more.</p>}
      </section>}

      <footer className="footer"><span><span className="brand-mini">J</span> JUGAADTV</span><span>Streams are third-party links and can vary by region, quality, or availability.</span><button className="footer-about-link" onClick={() => setShowAbout(true)}>About me</button><a href="/admin">Admin</a></footer>

      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
    {showAbout && (
      <div className="modal-backdrop about-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setShowAbout(false);
      }}>
        <section className="about-modal" role="dialog" aria-modal="true" aria-labelledby="about-title">
          <button className="modal-close" onClick={() => setShowAbout(false)} aria-label="Close About Me">×</button>
          <div className="about-portrait-wrap"><img className="about-portrait" src="/images/farman-haider.png" alt="Farman Haider" /></div>
          <div className="about-copy">
            <p className="section-kicker">THE CREATOR BEHIND JUGAADTV</p>
            <h2 id="about-title">Hi, I’m Farman Haider.</h2>
            <p className="about-description">I built JUGAADTV to make discovering live channels feel simple, enjoyable, and personal. Thanks for being here and watching.</p>
            <div className="about-actions">
              <a className="primary-button" href="https://www.linkedin.com/in/farman-haider-6a771933b/" target="_blank" rel="noreferrer">View my portfolio <span aria-hidden="true">↗</span></a>
              <a className="secondary-button about-support" href="https://www.linkedin.com/in/farman-haider-6a771933b/" target="_blank" rel="noreferrer"><span aria-hidden="true">✉</span> Contact & support</a>
            </div>
            <p className="about-support-note">Need help or have feedback? Reach out through LinkedIn.</p>
          </div>
        </section>
      </div>
    )}
    </>
  );
}

createRoot(document.getElementById("root")).render(<App />);
