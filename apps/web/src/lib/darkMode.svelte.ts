class DarkMode {
  enabled = $state(false);

  constructor() {
    if (typeof window !== 'undefined') {
      // Check localStorage first, then system preference
      const stored = localStorage.getItem('unkeep-dark-mode');
      if (stored !== null) {
        this.enabled = stored === 'true';
      } else {
        this.enabled = window.matchMedia('(prefers-color-scheme: dark)').matches;
      }
      this.apply();
    }
  }

  toggle() {
    this.enabled = !this.enabled;
    localStorage.setItem('unkeep-dark-mode', String(this.enabled));
    this.apply();
  }

  private apply() {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', this.enabled);
      document.documentElement.classList.toggle('light', !this.enabled);
    }
  }
}

export const darkMode = new DarkMode();
