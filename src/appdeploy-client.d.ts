declare module '@appdeploy/client' {
  export interface AuthUser {
    userId: string;
    email?: string;
    name?: string;
    picture?: string;
    scope: string;
  }

  export const auth: {
    signIn(options?: { scope?: string }): Promise<{ user: AuthUser; accessToken: string; expiresIn: number }>;
    signOut(): Promise<void>;
    getUser(): Promise<AuthUser | null>;
    getAccessToken(): Promise<string | null>;
    isSignedIn(): boolean;
  };

  export const api: {
    get(url: string, config?: unknown): Promise<{ data: any }>;
    post(url: string, data?: unknown, config?: unknown): Promise<{ data: any }>;
    put(url: string, data?: unknown, config?: unknown): Promise<{ data: any }>;
    delete(url: string, config?: unknown): Promise<{ data: any }>;
  };
}
