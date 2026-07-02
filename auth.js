const loginOverlay = document.getElementById('login-overlay');
const appContent = document.getElementById('app-content');
const authForm = document.getElementById('auth-form');
const authLogin = document.getElementById('auth-login');
const authPassword = document.getElementById('auth-password');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const authModeToggle = document.getElementById('auth-mode-toggle');
const authError = document.getElementById('auth-error');
const authGuestBtn = document.getElementById('auth-guest-btn');

let authMode = 'login';

function getDeviceId() {
  let id = localStorage.getItem('mf_device_id');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    localStorage.setItem('mf_device_id', id);
  }
  return id;
}
const userGreeting = document.getElementById('user-greeting');
const logoutBtn = document.getElementById('logout-btn');
const loginCloseBtn = document.getElementById('login-close');
const guestLoginBtn = document.getElementById('guest-login-btn');
const guestBanner = document.getElementById('guest-banner');

function getToken() {
  return sessionStorage.getItem('token');
}

function authHeaders() {
  const token = getToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (window.I18N?.apiHeaders) Object.assign(headers, window.I18N.apiHeaders());
  return headers;
}

window.authHeaders = authHeaders;

function isLoggedIn() {
  return Boolean(getToken() && sessionStorage.getItem('username'));
}
window.isLoggedIn = isLoggedIn;

window.requireLogin = function requireLogin(message) {
  const fallback = window.t ? window.t('notify.loginRequiredGeneric') : 'Войдите, чтобы пользоваться этой функцией.';
  openLoginModal(message || fallback);
  return false;
};

function getConnectionErrorMessage() {
  const T = (k, f) => (window.t ? window.t(k) : f);
  if (window.location.protocol === 'file:') {
    return T('errors.fileProtocol', 'Вы открыли файл напрямую. Запустите сервер и откройте http://localhost:3000');
  }
  return T('errors.serverDown', 'Не удалось связаться с сервером. Проверьте, что в cmd запущен: node server.js');
}

function showFileProtocolWarning() {
  if (window.location.protocol !== 'file:') return;

  const warning = document.getElementById('open-via-server-hint');
  if (warning) {
    warning.classList.remove('hidden');
    warning.textContent = window.t ? window.t('errors.openViaServer') : 'Откройте сайт через http://localhost:3000 (не двойным кликом по index.html)';
  }
}

function openLoginModal(message = '') {
  loginOverlay.classList.remove('hidden');
  if (message && authError) {
    authError.textContent = message;
  }
}

function closeLoginModal() {
  loginOverlay.classList.add('hidden');
  if (authError) authError.textContent = '';
}

function resetAuthForm() {
  authForm?.reset();
  if (authError) authError.textContent = '';
}

function displayNameFrom(username) {
  if (!username) return '';
  const value = String(username);
  if (value.startsWith('+') || /^\d{7,}$/.test(value)) return value;
  const local = value.split('@')[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : username;
}
window.displayNameFrom = displayNameFrom;

function applyAuthState(username) {
  const authed = Boolean(username);
  document.body.dataset.auth = authed ? 'user' : 'guest';

  if (userGreeting) {
    const name = displayNameFrom(username);
    userGreeting.textContent = authed
      ? (window.t ? window.t('home.greeting', { name }) : `Привет, ${name}`)
      : '';
    userGreeting.dataset.authName = authed ? username : '';
  }
  if (guestLoginBtn) guestLoginBtn.hidden = authed;
  if (guestBanner) guestBanner.hidden = authed;
  const avatar = document.getElementById('header-avatar');
  if (avatar) avatar.hidden = !authed;
}

function updateAuthModeUI() {
  const isRegister = authMode === 'register';
  if (authPassword) {
    authPassword.autocomplete = isRegister ? 'new-password' : 'current-password';
  }
  if (authSubmitBtn) {
    authSubmitBtn.textContent = window.t
      ? window.t(isRegister ? 'auth.submitRegister' : 'auth.submitLogin')
      : (isRegister ? 'Зарегистрироваться' : 'Войти');
  }
  if (authModeToggle) {
    authModeToggle.textContent = window.t
      ? window.t(isRegister ? 'auth.switchToLogin' : 'auth.switchToRegister')
      : (isRegister ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться');
  }
}

function setAuthMode(mode) {
  authMode = mode === 'register' ? 'register' : 'login';
  if (authError) authError.textContent = '';
  updateAuthModeUI();
}

document.addEventListener('i18n:change', function () {
  const name = userGreeting && userGreeting.dataset.authName;
  if (userGreeting && name) {
    userGreeting.textContent = window.t
      ? window.t('home.greeting', { name: displayNameFrom(name) })
      : `Привет, ${displayNameFrom(name)}`;
  }
  updateAuthModeUI();
});

window.handleAuthExpired = function handleAuthExpired(message) {
  sessionStorage.removeItem('token');
  sessionStorage.removeItem('username');
  applyAuthState(null);
  openLoginModal(message || 'Сессия истекла. Войдите снова.');
};

function showApp(username) {
  loginOverlay.classList.add('hidden');
  appContent.classList.remove('hidden');
  applyAuthState(username);
  window.initHeaderNav?.(username || 'Гость');
}

if (loginCloseBtn) loginCloseBtn.addEventListener('click', closeLoginModal);
if (guestLoginBtn) guestLoginBtn.addEventListener('click', () => openLoginModal());
if (authModeToggle) {
  authModeToggle.addEventListener('click', () => {
    setAuthMode(authMode === 'login' ? 'register' : 'login');
  });
}

const listGuestLoginBtn = document.getElementById('list-guest-login-btn');
if (listGuestLoginBtn) {
  listGuestLoginBtn.addEventListener('click', () => {
    const msg = window.t ? window.t('list.guestLoginPrompt') : 'Войдите, чтобы пользоваться своим списком фильмов.';
    openLoginModal(msg);
  });
}
if (loginOverlay) {
  loginOverlay.addEventListener('click', (event) => {
    if (event.target === loginOverlay) closeLoginModal();
  });
}

if (authGuestBtn) {
  authGuestBtn.addEventListener('click', () => {
    const page = document.body.dataset.page || 'home';
    if (page === 'home') closeLoginModal();
    else window.location.href = '/';
  });
}

if (authForm) {
  authForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (authError) authError.textContent = '';

    const username = authLogin.value.trim();
    const password = authPassword.value;
    const isRegister = authMode === 'register';
    const endpoint = isRegister ? '/api/register' : '/api/login';
    const originalLabel = authSubmitBtn ? authSubmitBtn.textContent : '';

    if (authSubmitBtn) {
      authSubmitBtn.disabled = true;
      authSubmitBtn.textContent = window.t
        ? window.t(isRegister ? 'auth.registering' : 'auth.loggingIn')
        : (isRegister ? 'Регистрация…' : 'Входим…');
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, deviceId: getDeviceId() })
      });

      const data = await response.json();
      if (!response.ok) {
        if (authError) {
          if (response.status === 409) {
            authError.textContent = window.t ? window.t('auth.loginTaken') : (data.error || 'Логин уже занят');
          } else {
            authError.textContent = data.error || (isRegister ? 'Не удалось зарегистрироваться' : 'Не удалось войти');
          }
        }
        return;
      }

      sessionStorage.setItem('token', data.token);
      sessionStorage.setItem('username', data.username);
      localStorage.removeItem('mf_logged_out');
      await window.GuestStore?.merge?.();
      await window.syncGuestSwipeActionsToAccount?.();
      await startApp(data.username);
    } catch (error) {
      if (authError) authError.textContent = getConnectionErrorMessage();
    } finally {
      if (authSubmitBtn) {
        authSubmitBtn.disabled = false;
        authSubmitBtn.textContent = originalLabel;
      }
    }
  });
}

async function handleLogout() {
  try {
    await fetch('/api/logout', {
      method: 'POST',
      headers: authHeaders()
    });
  } catch (error) {
    // ignore
  }

  sessionStorage.removeItem('token');
  sessionStorage.removeItem('username');
  localStorage.setItem('mf_logged_out', '1');
  resetAuthForm();

  if (document.body.dataset.page === 'account') {
    window.location.href = '/';
    return;
  }
  startGuest();
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', handleLogout);
}

async function startApp(username) {
  showApp(username);
  closeLoginModal();
  await window.ViewingHistory?.merge?.();
  await window.ViewingHistory?.reload?.();
  await window.MovieApp.init();

  const page = document.body.dataset.page || 'home';
  if (page === 'home') {
    window.refreshExtendedFeatures?.();
    window.BattleUI?.refresh?.();
    window.PsychTest?.refresh?.();
    window.VisualTest?.refresh?.();
    window.ShortVisualTest?.refresh?.();
    window.DiscoverPWA?.refresh?.();
  } else if (page === 'account') {
    window.refreshAccountPage?.();
  } else if (page === 'battle') {
    window.BattleUI?.refresh?.();
  }
}

function startGuest() {
  const page = document.body.dataset.page || 'home';

  if (page === 'account') {
    window.location.href = '/';
    return;
  }

  showApp(null);

  window.ViewingHistory?.reload?.().then?.(() => {
    window.refreshContinueWatching?.();
  });

  if (page === 'home') {
    window.MovieApp?.init?.().catch?.(() => {});
    window.refreshExtendedFeatures?.();
    window.PsychTest?.refresh?.();
    window.VisualTest?.refresh?.();
    window.ShortVisualTest?.refresh?.();
    window.DiscoverPWA?.refresh?.();
  } else if (page === 'battle') {
    openLoginModal(window.t ? window.t('battle.loginIntro') : 'Войдите, чтобы устроить битву из своих фильмов.');
  }
}

async function tryDeviceLogin() {
  if (localStorage.getItem('mf_logged_out') === '1') return false;
  try {
    const response = await fetch('/api/auth-device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: getDeviceId() })
    });
    if (!response.ok) return false;
    const data = await response.json();
    sessionStorage.setItem('token', data.token);
    sessionStorage.setItem('username', data.username);
    await window.GuestStore?.merge?.();
    await window.syncGuestSwipeActionsToAccount?.();
    await startApp(data.username);
    return true;
  } catch (error) {
    return false;
  }
}

async function tryAutoLogin() {
  const token = getToken();
  const username = sessionStorage.getItem('username');

  if (token && username) {
    try {
      const response = await fetch('/api/movies', { headers: authHeaders() });
      if (response.ok) {
        await startApp(username);
        return;
      }
      sessionStorage.clear();
    } catch (error) {
      startGuest();
      return;
    }
  }

  if (await tryDeviceLogin()) return;
  startGuest();
}

updateAuthModeUI();
tryAutoLogin();
showFileProtocolWarning();
