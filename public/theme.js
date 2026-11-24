// Runs before first paint so the saved or system theme applies without a flash.
(() => {
  const root = document.documentElement;
  const media = matchMedia('(prefers-color-scheme: dark)');
  const saved = () => {
    try {
      const value = localStorage.getItem('theme');
      return value === 'light' || value === 'dark' ? value : null;
    } catch {
      return null;
    }
  };
  const apply = () => {
    root.dataset.theme = saved() ?? (media.matches ? 'dark' : 'light');
  };
  apply();

  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('theme-toggle');
    if (!button) return;
    const label = () => {
      const text = root.dataset.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
      button.setAttribute('aria-label', text);
      button.title = text;
    };
    label();
    button.addEventListener('click', () => {
      try {
        localStorage.setItem('theme', root.dataset.theme === 'dark' ? 'light' : 'dark');
      } catch {
        root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
        label();
        return;
      }
      apply();
      label();
    });
    media.addEventListener('change', () => {
      apply();
      label();
    });
  });
})();
