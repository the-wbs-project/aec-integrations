import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription, fromEvent, timer } from 'rxjs';

const VERSION_URL = '/version.json';
const POLL_INTERVAL_MS = 30_000;

interface VersionPayload {
  version: string;
  builtAt?: string;
}

@Injectable({ providedIn: 'root' })
export class VersionCheckService {
  private readonly destroyRef = inject(DestroyRef);

  private readonly _updateAvailable = signal(false);
  readonly updateAvailable = this._updateAvailable.asReadonly();

  private currentVersion: string | null = null;
  private pollSub: Subscription | null = null;

  constructor() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    void this.baselineThenStart();

    fromEvent(document, 'visibilitychange')
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.syncPollingToVisibility());

    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  private async baselineThenStart(): Promise<void> {
    const v = await this.fetchVersion();
    if (v) {
      this.currentVersion = v;
      this.syncPollingToVisibility();
    }
  }

  private syncPollingToVisibility(): void {
    if (this._updateAvailable()) {
      this.stopPolling();
      return;
    }
    if (document.visibilityState === 'visible') {
      this.startPolling();
    } else {
      this.stopPolling();
    }
  }

  private startPolling(): void {
    if (this.pollSub) return;

    console.log('startPolling');
    console.log('POLL_INTERVAL_MS', POLL_INTERVAL_MS);

    this.pollSub = timer(POLL_INTERVAL_MS, POLL_INTERVAL_MS)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => void this.checkOnce());
  }

  private stopPolling(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = null;
  }

  private async checkOnce(): Promise<void> {
    const v = await this.fetchVersion();
    if (!v || !this.currentVersion) return;
    if (v !== this.currentVersion) {
      this._updateAvailable.set(true);
      this.stopPolling();
    }
  }

  private async fetchVersion(): Promise<string | null> {
    try {
      const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return null;
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('json')) return null;
      const body = (await res.json()) as Partial<VersionPayload>;
      return typeof body.version === 'string' && body.version ? body.version : null;
    } catch {
      return null;
    }
  }
}
