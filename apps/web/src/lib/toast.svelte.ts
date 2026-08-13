export interface Toast {
  id: string;
  message: string;
  action?: { label: string; fn: () => void };
  timeout: number;
}

class ToastStore {
  toasts = $state<Toast[]>([]);

  show(message: string, options?: { action?: { label: string; fn: () => void }; timeout?: number }) {
    const id = crypto.randomUUID();
    const toast: Toast = {
      id,
      message,
      action: options?.action,
      timeout: options?.timeout ?? 3000,
    };
    this.toasts.push(toast);
    setTimeout(() => this.dismiss(id), toast.timeout);
    return id;
  }

  dismiss(id: string) {
    this.toasts = this.toasts.filter(t => t.id !== id);
  }
}

export const toastStore = new ToastStore();
