import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * The company's own name and logo, used for the app shell, the sign-in screen,
 * the browser tab title and the tab icon.
 *
 * Fetched from a public endpoint so the sign-in screen is branded before
 * anyone has signed in.
 */
interface Branding {
  organizationName: string;
  logoUrl: string | null;
}

interface BrandingState extends Branding {
  /** Re-reads branding after it is changed in Settings. */
  refresh: () => Promise<void>;
}

const FALLBACK: Branding = { organizationName: 'Escalation Pro', logoUrl: null };

const BrandingContext = createContext<BrandingState | null>(null);

export function useBranding(): BrandingState {
  const context = useContext(BrandingContext);
  if (!context) throw new Error('useBranding must be used inside <BrandingProvider>');
  return context;
}

/**
 * Points the tab icon at the company logo.
 *
 * Replaces the link element rather than mutating its href: some browsers skip
 * a refetch when only the attribute changes on an already-loaded icon.
 */
function applyFavicon(logoUrl: string | null) {
  const head = document.head;
  const existing = head.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const link = document.createElement('link');
  link.rel = 'icon';
  if (logoUrl) {
    link.href = logoUrl;
  } else {
    link.href = '/favicon.svg';
    link.type = 'image/svg+xml';
  }
  existing?.remove();
  head.appendChild(link);
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState<Branding>(FALLBACK);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/branding', { credentials: 'same-origin' });
      if (!response.ok) return;
      const data = (await response.json()) as Partial<Branding>;
      setBranding({
        organizationName: data.organizationName?.trim() || FALLBACK.organizationName,
        logoUrl: data.logoUrl ?? null,
      });
    } catch {
      // Branding is cosmetic; the app is perfectly usable with the defaults.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    applyFavicon(branding.logoUrl);
  }, [branding.logoUrl]);

  const value = useMemo(() => ({ ...branding, refresh }), [branding, refresh]);
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

/**
 * Sets the browser tab title to "<page> · <company>", falling back to the
 * company name alone on the top-level view.
 *
 * Called from a page rather than a router table so each page names itself.
 */
export function useDocumentTitle(page?: string) {
  const { organizationName } = useBranding();
  useEffect(() => {
    document.title = page ? `${page} · ${organizationName}` : organizationName;
  }, [page, organizationName]);
}
