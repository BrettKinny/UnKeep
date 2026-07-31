/**
 * OAuth 2.0 PKCE popup flow manager for UnKeep.
 *
 * Handles:
 * - Opening an authorization popup window
 * - PKCE code verifier/challenge generation
 * - Exchanging authorization codes for tokens
 * - Refreshing expired access tokens
 * - Storing/retrieving OAuth token metadata alongside adapter config
 */

import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  type OAuthProviderConfig,
  type OAuthTokens,
} from '@unkeep/core/experimental';

const TOKEN_STORAGE_KEY = 'unkeep-oauth-tokens';
const PKCE_STORAGE_KEY = 'unkeep-oauth-pkce';

// ── Token persistence ───────────────────────────────────────────────

export interface StoredTokens extends OAuthTokens {
  adapterId: string;
}

export function getSavedTokens(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveTokens(adapterId: string, tokens: OAuthTokens): void {
  const stored: StoredTokens = { adapterId, ...tokens };
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(stored));
}

export function clearTokens(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(PKCE_STORAGE_KEY);
}

// ── PKCE state persistence (survives popup redirect) ────────────────

interface PkceState {
  verifier: string;
  state: string;
}

function savePkceState(pkce: PkceState): void {
  localStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify(pkce));
}

export function getSavedPkceState(): PkceState | null {
  try {
    const raw = localStorage.getItem(PKCE_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearPkceState(): void {
  localStorage.removeItem(PKCE_STORAGE_KEY);
}

// ── OAuth popup flow ────────────────────────────────────────────────

export interface OAuthFlowParams {
  oauthConfig: OAuthProviderConfig;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

/**
 * Start the OAuth authorization flow in a popup window.
 * Returns a promise that resolves with the authorization code.
 */
export async function startOAuthPopup(params: OAuthFlowParams): Promise<string> {
  const { oauthConfig, clientId, redirectUri } = params;

  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = generateState();

  // Persist PKCE state so the callback page can read it
  savePkceState({ verifier, state });

  // Build authorization URL
  const url = new URL(oauthConfig.authUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  if (oauthConfig.scopes.length > 0) {
    url.searchParams.set('scope', oauthConfig.scopes.join(' '));
  }

  if (oauthConfig.extraAuthParams) {
    for (const [k, v] of Object.entries(oauthConfig.extraAuthParams)) {
      url.searchParams.set(k, v);
    }
  }

  // Open popup
  const width = 600;
  const height = 700;
  const left = window.screenX + (window.innerWidth - width) / 2;
  const top = window.screenY + (window.innerHeight - height) / 2;
  const popup = window.open(
    url.toString(),
    'unkeep-oauth',
    `width=${width},height=${height},left=${left},top=${top},popup=yes`
  );

  if (!popup) {
    throw new Error('Popup blocked. Please allow popups for this site.');
  }

  // Wait for the callback page to post a message back
  return new Promise<string>((resolve, reject) => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'unkeep-oauth-callback') return;

      window.removeEventListener('message', handleMessage);
      clearInterval(pollTimer);

      if (event.data.error) {
        reject(new Error(event.data.error));
        return;
      }

      if (event.data.state !== state) {
        reject(new Error('OAuth state mismatch — possible CSRF attack.'));
        return;
      }

      resolve(event.data.code as string);
    };

    window.addEventListener('message', handleMessage);

    // Poll in case the popup is closed without completing
    const pollTimer = setInterval(() => {
      if (popup.closed) {
        clearInterval(pollTimer);
        window.removeEventListener('message', handleMessage);
        reject(new Error('Authorization cancelled — popup was closed.'));
      }
    }, 500);
  });
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
export async function exchangeCodeForTokens(
  params: OAuthFlowParams,
  code: string,
): Promise<OAuthTokens> {
  const { oauthConfig, clientId, clientSecret, redirectUri } = params;

  const pkce = getSavedPkceState();
  if (!pkce) throw new Error('Missing PKCE state — cannot exchange code.');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: pkce.verifier,
  });

  if (oauthConfig.requiresSecret && clientSecret) {
    body.set('client_secret', clientSecret);
  }

  if (oauthConfig.extraTokenParams) {
    for (const [k, v] of Object.entries(oauthConfig.extraTokenParams)) {
      body.set(k, v);
    }
  }

  const res = await fetch(oauthConfig.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  clearPkceState();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in
      ? Date.now() + data.expires_in * 1000
      : undefined,
  };
}

/**
 * Refresh an expired access token using a refresh token.
 */
export async function refreshAccessToken(
  oauthConfig: OAuthProviderConfig,
  clientId: string,
  refreshToken: string,
  clientSecret?: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });

  if (oauthConfig.requiresSecret && clientSecret) {
    body.set('client_secret', clientSecret);
  }

  const res = await fetch(oauthConfig.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: data.expires_in
      ? Date.now() + data.expires_in * 1000
      : undefined,
  };
}

/** Returns true if the stored tokens are expired (or will expire within 60s). */
export function isTokenExpired(tokens: OAuthTokens): boolean {
  if (!tokens.expiresAt) return false;
  return Date.now() > tokens.expiresAt - 60_000;
}

/** Build the redirect URI for the current origin. */
export function getRedirectUri(): string {
  return `${window.location.origin}/oauth/callback`;
}
