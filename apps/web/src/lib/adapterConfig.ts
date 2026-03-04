const STORAGE_KEY = 'unkeep-adapter-config';

export interface SavedConfig {
  adapterId: string;
  config: Record<string, unknown>;
}

export function getSavedConfig(): SavedConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveConfig(adapterId: string, config: Record<string, unknown>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ adapterId, config }));
}

export function clearConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
}
