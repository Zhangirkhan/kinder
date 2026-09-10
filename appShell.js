/* ===================================================================
   appShell.js — единый «приложение-режим» для всех устройств.

   Идея: class="app-mode" на <body> включается ВСЕГДА — и на ПК,
   и на телефоне. Появляется нижняя панель вкладок и контент
   показывается по одному «экрану» за раз — как в мобильном
   приложении. Единый дизайн везде, чтобы не путаться.

   Реализация безопасная и аддитивная: исходные секции остаются в DOM,
   мы лишь переключаем их inline-видимость. Существующий JS не меняется.

   Откат: удалить подключение этого файла (и appShell.css) из *.html.
   =================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'appShellScreen';
  var FORCE_KEY = 'appShellForce'; // '1' — всегда вкл, '0' — всегда выкл (для теста на ПК)

  // Вкладки нижней панели (порядок = порядок в панели)
  var ICONS = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5"/><path d="M9.5 21v-6h5v6"/></svg>',
    catalog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    tests: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6"/><path d="M10 3v6.2L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3L14 9.2V3"/><path d="M7.5 14h9"/></svg>',
    discover: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12.6 12 20l-7.5-7.4a4.7 4.7 0 0 1 0-6.7 4.7 4.7 0 0 1 6.7 0l.8.8.8-.8a4.7 4.7 0 0 1 6.7 0 4.7 4.7 0 0 1 0 6.7Z"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h12"/><path d="M8 12h12"/><path d="M8 18h12"/><circle cx="3.5" cy="6" r="1.2"/><circle cx="3.5" cy="12" r="1.2"/><circle cx="3.5" cy="18" r="1.2"/></svg>'
  };

  function tt(key, fallback) {
    return (typeof window !== 'undefined' && window.t) ? window.t(key) : fallback;
  }

  var TABS = [
    { id: 'home',     icon: ICONS.home,     labelKey: 'nav.home',     label: 'Главная',  href: '/#home' },
    { id: 'catalog',  icon: ICONS.catalog,  labelKey: 'nav.catalog',  label: 'Каталог',  href: '/#catalog' },
    { id: 'discover', icon: ICONS.discover, labelKey: 'nav.swipe',    label: 'Свайп',    href: '/#discover' },
    { id: 'tests',    icon: ICONS.tests,    labelKey: 'nav.tests',    label: 'Тесты',    href: '/#tests' },
    { id: 'list',     icon: ICONS.list,     labelKey: 'nav.listShort', label: 'Список',   href: '/#list' }
  ];

  // Экраны, между которыми переключаемся на главной странице
  var SCREENS = ['home', 'catalog', 'tests', 'discover', 'list'];
  var CONTINUE_WATCHING_SCREENS = ['home', 'catalog'];

  // Привязка секций главной страницы к экранам (селектор → экран).
  var SECTION_MAP = [
    ['#premiere-ribbon-section', 'home'],
    ['#movies-stat-banner', 'home'],
    ['.hero-section', 'home'],
    ['#battle-section', 'home'],
    ['#home-collections', 'home'],

    ['#catalog-section', 'catalog'],

    ['#tests-ribbon-wrap', 'tests'],

    ['#discover-section', 'discover'],

    ['#list-guest-prompt', 'list'],

    ['.movie-list-section', 'list'],
    ['.blacklist-section', 'list'],
    ['.import-section', 'list']
  ];

  var page = (document.body && document.body.dataset.page) || 'home';
  var isHomePage = page === 'home';
  var sectionEntries = [];   // [{ el, screen }]
  var tabbarEl = null;
  var active = false;
  var continueWatchingEl = null;
  var continueWatchingHomeAnchor = null;
  var currentAppScreen = 'home';

  // ── Определение режима ─────────────────────────────────────────
  function readForce() {
    var qs = new URLSearchParams(window.location.search);
    if (qs.get('app') === '1') { safeStore(FORCE_KEY, '1'); }
    if (qs.get('app') === '0') { safeStore(FORCE_KEY, '0'); }
    try { return localStorage.getItem(FORCE_KEY); } catch (e) { return null; }
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
  }

  function isMobileLike() {
    return window.matchMedia('(max-width: 900px), (pointer: coarse)').matches;
  }

  function shouldBeApp() {
    // Единый дизайн: app-режим включён всегда — и на ПК, и на телефоне,
    // независимо от ширины окна и standalone-режима.
    return true;
  }

  function safeStore(key, val) {
    try { localStorage.setItem(key, val); } catch (e) {}
  }
  function safeRead(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  // ── Сбор секций главной страницы ───────────────────────────────
  function collectSections() {
    sectionEntries = [];
    SECTION_MAP.forEach(function (pair) {
      var el = document.querySelector(pair[0]);
      if (el) sectionEntries.push({ el: el, screen: pair[1] });
    });
    continueWatchingEl = document.getElementById('continue-watching-section');
    continueWatchingHomeAnchor = document.getElementById('movies-stat-banner');
  }

  function syncContinueWatchingPlacement(screen) {
    if (!continueWatchingEl) return;
    var allowed = CONTINUE_WATCHING_SCREENS.indexOf(screen) !== -1;
    var hasItems = !continueWatchingEl.hidden;
    if (!allowed || !hasItems) {
      continueWatchingEl.style.display = 'none';
      continueWatchingEl.classList.remove('continue-watching-section--catalog');
      return;
    }

    continueWatchingEl.style.display = '';
    var catalog = document.getElementById('catalog-section');
    if (screen === 'catalog' && catalog) {
      continueWatchingEl.classList.add('continue-watching-section--catalog');
      if (continueWatchingEl.parentElement !== catalog) {
        catalog.insertBefore(continueWatchingEl, catalog.firstChild);
      }
      return;
    }

    continueWatchingEl.classList.remove('continue-watching-section--catalog');
    if (continueWatchingHomeAnchor && continueWatchingEl.previousElementSibling !== continueWatchingHomeAnchor) {
      continueWatchingHomeAnchor.insertAdjacentElement('afterend', continueWatchingEl);
    }
  }

  window.appShellSyncContinueWatching = function () {
    syncContinueWatchingPlacement(currentAppScreen);
  };

  // ── Нижняя панель вкладок ──────────────────────────────────────
  function buildTabbar() {
    if (tabbarEl) return tabbarEl;

    // Старую мобильную панель из pwa.js убираем, чтобы не дублировать
    var oldNav = document.getElementById('mobile-app-nav');
    if (oldNav && oldNav.parentNode) oldNav.parentNode.removeChild(oldNav);

    var nav = document.createElement('nav');
    nav.id = 'app-tabbar';
    nav.className = 'app-tabbar';
    nav.setAttribute('aria-label', tt('nav.tabsAria', 'Вкладки приложения'));

    TABS.forEach(function (tab) {
      var a = document.createElement('a');
      a.className = 'app-tab';
      a.href = tab.href;
      a.dataset.tab = tab.id;
      a.innerHTML =
        '<span class="app-tab__icon" aria-hidden="true">' + tab.icon + '</span>' +
        '<span class="app-tab__label">' + tt(tab.labelKey, tab.label) + '</span>';

      if (isHomePage && !tab.link) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          showScreen(tab.id, true);
        });
      }
      nav.appendChild(a);
    });

    // Кладём внутрь #app-content, чтобы панель автоматически скрывалась
    // на экране входа (когда #app-content имеет класс .hidden).
    var host = document.getElementById('app-content') || document.body;
    host.appendChild(nav);
    tabbarEl = nav;
    return nav;
  }

  // Перевод подписей вкладок при смене языка.
  function relabelTabs() {
    if (!tabbarEl) return;
    tabbarEl.setAttribute('aria-label', tt('nav.tabsAria', 'Вкладки приложения'));
    var items = tabbarEl.querySelectorAll('.app-tab');
    for (var i = 0; i < items.length; i++) {
      var labelEl = items[i].querySelector('.app-tab__label');
      var id = items[i].dataset.tab;
      var tab = TABS.filter(function (t) { return t.id === id; })[0];
      if (labelEl && tab) labelEl.textContent = tt(tab.labelKey, tab.label);
    }
  }
  document.addEventListener('i18n:change', relabelTabs);

  function setActiveTab(id) {
    if (!tabbarEl) return;
    var items = tabbarEl.querySelectorAll('.app-tab');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('app-tab--active', items[i].dataset.tab === id);
    }
  }

  // ── Переключение экранов (только на главной) ───────────────────
  function showScreen(screen, updateHash) {
    if (SCREENS.indexOf(screen) === -1) screen = 'home';
    currentAppScreen = screen;
    document.body.dataset.appScreen = screen;

    sectionEntries.forEach(function (entry) {
      entry.el.style.display = (entry.screen === screen) ? '' : 'none';
    });

    syncContinueWatchingPlacement(screen);

    setActiveTab(screen);
    safeStore(STORAGE_KEY, screen);

    if (updateHash) {
      if (('#' + screen) !== window.location.hash) {
        history.replaceState(null, '', '#' + screen);
      }
      window.scrollTo(0, 0);
    }

    onScreenShown(screen);
  }

  // После показа экрана компоненты снова видимы — даём им пересчитать
  // размеры (карусели/верстка, которые мерили 0 пока были скрыты) и
  // подгружаем свайп-ленту, если она ещё пустая.
  function onScreenShown(screen) {
    window.requestAnimationFrame(function () {
      try { window.dispatchEvent(new Event('resize')); } catch (e) {}
      if (screen === 'discover') ensureDiscoverLoaded();
      if (screen === 'catalog' && window.CatalogUI && typeof window.CatalogUI.refresh === 'function') {
        window.CatalogUI.refresh();
      }
      if (screen === 'home' && window.HomeCollections && typeof window.HomeCollections.refresh === 'function') {
        window.HomeCollections.refresh();
      }
    });
  }

  function ensureDiscoverLoaded() {
    var stack = document.getElementById('discover-stack');
    if (!stack) return;
    var hasCard = stack.querySelector('.discover-card');
    if (hasCard) return;
    if (window.DiscoverPWA && typeof window.DiscoverPWA.refresh === 'function') {
      window.DiscoverPWA.refresh();
    }
  }

  function initialScreen() {
    // Уважаем явный hash в URL (deep-link), но при обычном запуске всегда
    // открываемся на «Главной», а не на последнем посещённом экране.
    var hash = (window.location.hash || '').replace('#', '');
    if (SCREENS.indexOf(hash) !== -1) return hash;
    return 'home';
  }

  // ── Вкл / выкл режима ──────────────────────────────────────────
  function enterAppMode() {
    if (active) return;
    active = true;
    document.body.classList.add('app-mode');
    buildTabbar();

    if (isHomePage) {
      collectSections();
      showScreen(initialScreen(), false);
    } else if (page === 'account') {
      setActiveTab('profile');
    } else {
      setActiveTab(null);
    }
  }

  function exitAppMode() {
    if (!active) return;
    active = false;
    document.body.classList.remove('app-mode');
    delete document.body.dataset.appScreen;

    // Возвращаем секции в исходное состояние (десктоп без изменений)
    sectionEntries.forEach(function (entry) {
      entry.el.style.display = '';
    });
    if (continueWatchingEl && continueWatchingHomeAnchor) {
      continueWatchingHomeAnchor.insertAdjacentElement('afterend', continueWatchingEl);
      continueWatchingEl.style.display = '';
      continueWatchingEl.classList.remove('continue-watching-section--catalog');
    }
  }

  function sync() {
    if (shouldBeApp()) enterAppMode();
    else exitAppMode();
  }

  // ── Слушатели изменения режима ─────────────────────────────────
  function bindMediaListeners() {
    var mqs = [
      window.matchMedia('(display-mode: standalone)'),
      window.matchMedia('(max-width: 900px)'),
      window.matchMedia('(pointer: coarse)')
    ];
    mqs.forEach(function (mq) {
      if (mq.addEventListener) mq.addEventListener('change', sync);
      else if (mq.addListener) mq.addListener(sync);
    });

    window.addEventListener('hashchange', function () {
      if (active && isHomePage) {
        var hash = (window.location.hash || '').replace('#', '');
        if (SCREENS.indexOf(hash) !== -1) showScreen(hash, false);
      }
    });
  }

  function start() {
    bindMediaListeners();
    sync();
    // экспортируем мини-API на случай ручного переключения
    window.appShell = {
      show: function (s) { if (active && isHomePage) showScreen(s, true); },
      enable: function () { safeStore(FORCE_KEY, '1'); sync(); },
      disable: function () { safeStore(FORCE_KEY, '0'); sync(); },
      auto: function () { try { localStorage.removeItem(FORCE_KEY); } catch (e) {} sync(); }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
