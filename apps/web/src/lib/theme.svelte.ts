export type ThemeMode = 'system' | 'light' | 'dark';

class Theme {
  mode = $state<ThemeMode>('system');

  constructor() {
    if (typeof window !== 'undefined') {
      // Legacy explicit light/dark toggle — cleared so everyone defaults to system
      localStorage.removeItem('unkeep-dark-mode');
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
