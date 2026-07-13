import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ACCOUNT_SWITCHED_EVENT, api, clearSessionToken, getActiveAccount, getActiveAccountId, getSessionToken, listAccounts, removeAccount, type StoredAccount, switchAccount } from "@/lib/api";

export type Palette = "geist" | "uet" | "vnu";
export type Mode = "light" | "dark";

export type HyeboardState = ReturnType<typeof useHyeboardState>;
const HyeboardContext = createContext<HyeboardState | null>(null);

export function useHyeboard() {
  const state = useContext(HyeboardContext);
  if (!state) throw new Error("useHyeboard must be used inside HyeboardProvider");
  return state;
}

export function HyeboardProvider({ children }: { children: ReactNode }) {
  return <HyeboardContext.Provider value={useHyeboardState()}>{children}</HyeboardContext.Provider>;
}

function stored<T extends string>(key: string, fallback: T): T {
  return (localStorage.getItem(key) as T | null) ?? fallback;
}

export const RELOGIN_KEYS = {
  uetCanvasToken: "hyeboard.relogin.uet.canvasToken",
  vnuUsername: "hyeboard.relogin.vnu.username",
  vnuPassword: "hyeboard.relogin.vnu.password",
} as const;

export function sessionStored(key: string): string {
  return sessionStorage.getItem(key) ?? "";
}

export function setSessionStored(key: string, value: string): void {
  if (value) sessionStorage.setItem(key, value);
  else sessionStorage.removeItem(key);
}

function clearReloginSecrets(): void {
  for (const key of Object.values(RELOGIN_KEYS)) sessionStorage.removeItem(key);
}

const THEME_OVERRIDE_PROPS = ["--primary", "--primary-foreground", "--accent", "--accent-foreground", "--ring", "--sidebar"] as const;

function applyAccentHue(hue: number, dark: boolean): void {
  const root = document.documentElement.style;
  root.setProperty("--primary", `${hue} 88% ${dark ? 68 : 28}%`);
  root.setProperty("--primary-foreground", dark ? `${hue} 45% 10%` : "0 0% 100%");
  root.setProperty("--accent", dark ? `${hue} 45% 15%` : `${hue} 55% 96%`);
  root.setProperty("--accent-foreground", dark ? `${hue} 85% 78%` : `${hue} 80% 26%`);
  root.setProperty("--ring", dark ? `${hue} 85% 68%` : `${hue} 70% 40%`);
  root.setProperty("--sidebar", dark ? `${hue} 30% 7%` : `${hue} 35% 99%`);
}

function clearAccentOverride(): void {
  const root = document.documentElement.style;
  for (const prop of THEME_OVERRIDE_PROPS) root.removeProperty(prop);
}

function useHyeboardState() {
  const queryClient = useQueryClient();
  const [universityId, setUniversityId] = useState<string>(() => stored("hyeboard.universityId", "uet"));
  const [palette, setPalette] = useState<Palette>(() => stored("hyeboard.palette", "uet"));
  const [mode, setMode] = useState<Mode>(() => stored("hyeboard.mode", "light"));
  const [themeHue, setThemeHue] = useState<number>(() => Number(stored("hyeboard.themeHue", "209")) || 209);
  const [termCode, setTermCode] = useState<string | undefined>();
  const [sessionNonce, setSessionNonce] = useState(0);
  const [accounts, setAccounts] = useState<StoredAccount[]>(() => listAccounts());
  const [activeAccountId, setActiveAccountId] = useState<string | null>(() => getActiveAccountId());

  // Fires on every account switch/add/remove (see ACCOUNT_SWITCHED_EVENT in
  // lib/api.ts) - re-syncs universityId/palette to whichever account is now
  // active and refetches all feature data for it.
  useEffect(() => {
    const syncActiveAccount = () => {
      setAccounts(listAccounts());
      setActiveAccountId(getActiveAccountId());
      const account = getActiveAccount();
      if (account) {
        setUniversityId(account.universityId);
        setPalette(account.universityId === "uet" || account.universityId === "vnu" ? (account.universityId as Palette) : "geist");
      }
      setSessionNonce((value) => value + 1);
      void queryClient.invalidateQueries();
    };
    window.addEventListener(ACCOUNT_SWITCHED_EVENT, syncActiveAccount);
    return () => window.removeEventListener(ACCOUNT_SWITCHED_EVENT, syncActiveAccount);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = palette;
    document.documentElement.dataset.mode = mode;
    localStorage.setItem("hyeboard.palette", palette);
    localStorage.setItem("hyeboard.mode", mode);
    localStorage.setItem("hyeboard.universityId", universityId);
    localStorage.setItem("hyeboard.themeHue", String(themeHue));
    if (palette === "uet" || palette === "vnu") applyAccentHue(themeHue, mode === "dark");
    else clearAccentOverride();
  }, [mode, palette, universityId, themeHue]);

  const universities = useQuery({ queryKey: ["universities"], queryFn: api.universities });

  const ensureSession = async () => {
    if (getSessionToken()) return;
    throw new Error("Sign in to continue.");
  };

  const dashboard = useQuery({
    queryKey: ["dashboard", universityId, termCode, sessionNonce],
    queryFn: async () => {
      await ensureSession();
      return api.dashboard(universityId, termCode);
    },
  });

  useEffect(() => {
    if (!termCode && dashboard.data?.currentTerm?.code) {
      setTermCode(dashboard.data.currentTerm.code);
    }
  }, [dashboard.data, termCode]);

  const selectUniversity = (nextUniversityId: string, options: { clearSession?: boolean } = {}) => {
    if (options.clearSession ?? true) clearSessionToken();
    setSessionNonce((value) => value + 1);
    setUniversityId(nextUniversityId);
    setPalette(nextUniversityId === "uet" || nextUniversityId === "vnu" ? (nextUniversityId as Palette) : "geist");
  };

  const refreshSession = () => {
    setSessionNonce((value) => value + 1);
    void queryClient.invalidateQueries();
  };

  const logout = () => {
    // Best-effort server-side revocation while the Authorization header still carries a
    // valid token - this is what actually invalidates any persisted uetGoogleCredential.
    // api.logout() never throws, so this fire-and-forget call never blocks local sign-out.
    void api.logout(universityId);
    clearReloginSecrets();
    clearSessionToken();
    setSessionNonce((value) => value + 1);
    void queryClient.invalidateQueries();
  };

  return { universityId, selectUniversity, palette, setPalette, mode, setMode, themeHue, setThemeHue, termCode, setTermCode, universities, dashboard, ensureSession, refreshSession, logout, sessionNonce, accounts, activeAccountId, switchToAccount: switchAccount, removeStoredAccount: removeAccount };
}

export function useFeatureQuery<T>(name: string, queryFn: () => Promise<T>, options: { enabled?: boolean } = {}) {
  const state = useHyeboard();
  return useQuery({
    queryKey: [name, state.universityId, state.termCode, state.sessionNonce],
    queryFn: async () => {
      await state.ensureSession();
      return queryFn();
    },
    enabled: options.enabled ?? true,
  });
}
