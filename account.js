(function () {
  const tasteContent = document.getElementById('taste-analysis-content');
  const tasteRefreshBtn = document.getElementById('taste-refresh-btn');
  const tasteStatus = document.getElementById('taste-analysis-status');

  function esc(text) {
    return window.MovieDisplay?.escapeHtml(text) || String(text);
  }

  async function loadTasteAnalysis() {
    if (!tasteContent) return;

    tasteContent.innerHTML = window.LoadingUI.ai(window.t ? window.t('account.analyzingTaste') : 'Анализирую ваш вкус...', { tag: 'p', wrapClass: '' });
    if (tasteStatus) tasteStatus.textContent = '';

    try {
      const response = await fetch('/api/taste-analysis', { headers: window.authHeaders() });
      const data = await response.json();

      if (!response.ok) {
        tasteContent.innerHTML = `<p class="rec-empty">${esc(data.error || 'Не удалось загрузить анализ')}</p>`;
        return;
      }

      const insights = data.insights || [];
      if (!insights.length) {
        tasteContent.innerHTML = '<p class="rec-empty">Пока недостаточно данных для анализа.</p>';
        return;
      }

      tasteContent.innerHTML = `
        <ul class="taste-insights-list">
          ${insights.map((item) => `<li>${esc(item)}</li>`).join('')}
        </ul>`;
    } catch (error) {
      tasteContent.innerHTML = '<p class="rec-empty">Сервер недоступен</p>';
    }
  }

  async function refreshAccountPage() {
    await window.refreshProfilePage?.();
    await window.refreshStats?.();
    await window.refreshViewingHistoryProfile?.();
    await loadTasteAnalysis();
  }

  tasteRefreshBtn?.addEventListener('click', loadTasteAnalysis);

  window.refreshAccountPage = refreshAccountPage;
})();
