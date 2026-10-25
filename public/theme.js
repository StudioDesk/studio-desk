// Applies the director's saved appearance before the dashboard renders. "system" follows the OS setting.
(() => {
  try {
    const theme = localStorage.getItem('studio-theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch {}
})();
