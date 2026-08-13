export type ThemeMode = 'system' | 'light' | 'dark';

class Theme {
  mode = $state<ThemeMode>('system');

  constructor() {
    if (typeof window !== 'undefined') {
      // Migrate the legacy explicit light/dark toggle so an existing choice survives
      const legacy = localStorage.getItem('unkeep-dark-mode');
      if (legacy !== null) {
        localStorage.removeItem('unkeep-dark-mode');
        if (localStorage.getItem('unkeep-theme') === null) {
          localStorage.setItem('unkeep-theme', legacy === 'true' ? 'dark' : 'light');
        }
      }
      const stored = localStorage.getItem('unkeep-theme');
      if (stored === 'light' || stored === 'dark') this.mode = stored;
      this.apply();
    }
  }

  set(mode: ThemeMode) {
    this.mode = mode;
    if (mode === 'system') {
      localStorage.removeItem('unkeep-theme');
    } else {
      localStorage.setItem('unkeep-theme', mode);
    }
    this.apply();
  }

  private apply() {
    if (typeof document === 'undefined') return;
    // No class = follow the OS via the prefers-color-scheme rules in app.css
    document.documentElement.classList.toggle('dark', this.mode === 'dark');
    document.documentElement.classList.toggle('light', this.mode === 'light');
  }
}

export const theme = new Theme();
