import { Injectable, computed, signal } from '@angular/core';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly client: SupabaseClient = createClient(
    environment.supabaseUrl,
    environment.supabaseAnonKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    }
  );

  private readonly _session = signal<Session | null>(null);
  private readonly _ready = signal(false);

  readonly session = this._session.asReadonly();
  readonly ready = this._ready.asReadonly();
  readonly isAuthenticated = computed(() => !!this._session());
  readonly user = computed(() => this._session()?.user ?? null);

  constructor() {
    void this.client.auth.getSession().then(({ data }) => {
      this._session.set(data.session);
      this._ready.set(true);
    });
    this.client.auth.onAuthStateChange((_event, session) => {
      this._session.set(session);
    });
  }

  /**
   * Resolves once the initial getSession() call has completed. Used by the
   * route guard so the first navigation doesn't bounce to /login while the
   * session is still loading from localStorage.
   */
  async waitUntilReady(): Promise<void> {
    if (this._ready()) return;
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (this._ready()) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });
  }

  async signIn(email: string, password: string): Promise<void> {
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut();
  }

  /**
   * Returns a fresh access token (auto-refreshes if expired). Null when the
   * user isn't signed in.
   */
  async getAccessToken(): Promise<string | null> {
    const { data } = await this.client.auth.getSession();
    return data.session?.access_token ?? null;
  }
}
