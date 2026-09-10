(function () {
  'use strict';

  let moviePlyr = null;
  let onQualityChangeCb = null;
  let fullscreenChangeHandler = null;

  function qualityNumber(label) {
    if (/ultra|2160|4k/i.test(String(label))) return 2160;
    const m = String(label).match(/(\d{3,4})/);
    return m ? Number(m[1]) : 0;
  }

  function qualityLabelFromPlyr(plyrQ, qualities) {
    const exact = (qualities || []).find((q) => qualityNumber(q.label) === plyrQ);
    if (exact) return exact.label;
    return (qualities || []).find((q) => String(q.label).includes(String(plyrQ)))?.label || null;
  }

  function buildQualityConfig(qualities, activeQuality) {
    const nums = [...new Set((qualities || []).map((q) => qualityNumber(q.label)).filter(Boolean))]
      .sort((a, b) => b - a);
    if (nums.length <= 1) return null;
    const active = qualityNumber(activeQuality) || nums[0];
    return {
      default: nums.includes(active) ? active : nums[0],
      options: nums,
      forced: true,
      onChange: (q) => {
        if (typeof onQualityChangeCb === 'function') onQualityChangeCb(q);
      }
    };
  }

  function buildSettings(hasCaptions, hasQuality) {
    const settings = ['speed'];
    if (hasCaptions) settings.unshift('captions');
    if (hasQuality) settings.unshift('quality');
    return settings;
  }

  function setPlayerFullscreenMode(active) {
    window.MobileShell?.setPlayerFullscreen?.(Boolean(active));
  }

  function bindFullscreenOrientation(plyr, videoEl) {
    const onEnter = () => setPlayerFullscreenMode(true);
    const onExit = () => setPlayerFullscreenMode(false);

    plyr.on('enterfullscreen', onEnter);
    plyr.on('exitfullscreen', onExit);

    videoEl.addEventListener('webkitbeginfullscreen', onEnter);
    videoEl.addEventListener('webkitendfullscreen', onExit);

    if (fullscreenChangeHandler) {
      document.removeEventListener('fullscreenchange', fullscreenChangeHandler);
    }
    fullscreenChangeHandler = function () {
      if (!moviePlyr) return;
      const root = videoEl.closest('.plyr');
      const inDomFs = Boolean(
        document.fullscreenElement === root ||
        document.fullscreenElement === videoEl ||
        document.fullscreenElement?.contains?.(videoEl)
      );
      setPlayerFullscreenMode(inDomFs || moviePlyr.fullscreen?.active);
    };
    document.addEventListener('fullscreenchange', fullscreenChangeHandler);
  }

  function destroyMoviePlyr() {
    if (fullscreenChangeHandler) {
      document.removeEventListener('fullscreenchange', fullscreenChangeHandler);
      fullscreenChangeHandler = null;
    }
    if (moviePlyr) {
      setPlayerFullscreenMode(false);
      try { moviePlyr.destroy(); } catch { /* already gone */ }
      moviePlyr = null;
    }
    onQualityChangeCb = null;
  }

  function initMoviePlyr(videoEl, options = {}) {
    if (!videoEl || typeof window.Plyr !== 'function') return null;

    destroyMoviePlyr();

    const qualities = options.qualities || [];
    const hasCaptions = Boolean(videoEl.querySelector('track'));
    const qualityConfig = buildQualityConfig(qualities, options.activeQuality);
    const hasQuality = Boolean(qualityConfig);
    onQualityChangeCb = options.onQualityChange || null;

    moviePlyr = new window.Plyr(videoEl, {
      controls: [
        'play-large',
        'rewind',
        'play',
        'fast-forward',
        'progress',
        'current-time',
        'duration',
        'mute',
        'volume',
        'captions',
        'settings',
        'fullscreen'
      ],
      seekTime: 5,
      settings: buildSettings(hasCaptions, hasQuality),
      speed: {
        selected: 1,
        options: options.speedOptions || [0.5, 0.75, 1, 1.25, 1.5, 2]
      },
      captions: {
        active: false,
        update: true,
        language: options.captionLanguage || 'ru'
      },
      quality: qualityConfig || undefined,
      fullscreen: { enabled: true, fallback: true, iosNative: true },
      hideControls: true,
      clickToPlay: true,
      keyboard: { focused: true, global: false }
    });

    bindFullscreenOrientation(moviePlyr, videoEl);

    return moviePlyr;
  }

  window.MoviePlyr = {
    init: initMoviePlyr,
    destroy: destroyMoviePlyr,
    getInstance: () => moviePlyr,
    qualityNumber,
    qualityLabelFromPlyr
  };
})();
