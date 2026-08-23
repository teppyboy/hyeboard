import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ACCOUNT_SWITCHED_EVENT,
  api,
  clearSessionToken,
  getActiveAccount,
  getActiveAccountId,
  getSessionToken,
  listAccounts,
  revokeAndRemoveAccount,
  shouldInvalidateVnuRefreshQuery,
  type StoredAccount,
  switchAccount,
  VNU_REFRESH_COMMITTED_EVENT,
  VNU_REFRESH_STATUS_EVENT,
} from "@/lib/api";
import { useLocale } from "@/lib/i18n";
import { UET_REAUTH_CREDENTIAL_KEYS } from "@/lib/reauth";
import {
  operationMayClearOwner,
  operationOwnsFailure,
  operationOwnsPendingEntry,
  type AccountActionOperation,
  type AccountActionSource,
} from "@/lib/account-action-state";
import { shouldInvalidateAccountQuery } from "@/lib/query-scope";

export type Palette = "geist" | "uet" | "vnu";
export type Mode = "light" | "dark";
export type { AccountActionSource } from "@/lib/account-action-state";

export type HyeboardState = ReturnType<typeof useHyeboardState>;
const HyeboardContext = createContext<HyeboardState | null>(null);

export function useHyeboard() {
  const state = useContext(HyeboardContext);
  if (!state)
    throw new Error("useHyeboard must be used inside HyeboardProvider");
  return state;
}

export function HyeboardProvider({ children }: { children: ReactNode }) {
  return (
    <HyeboardContext.Provider value={useHyeboardState()}>
      {children}
    </HyeboardContext.Provider>
  );
}

function stored<T extends string>(key: string, fallback: T): T {
  return (localStorage.getItem(key) as T | null) ?? fallback;
}

export const RELOGIN_KEYS = {
  uetCanvasToken: "hyeboard.relogin.uet.canvasToken",
  // UET sign-in credentials captured on successful login so an expired
  // session can be re-authenticated inline (see components/reauth.tsx).
  uetGoogleEmail: UET_REAUTH_CREDENTIAL_KEYS.email,
  uetGooglePassword: UET_REAUTH_CREDENTIAL_KEYS.password,
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

const THEME_OVERRIDE_PROPS = [
  "--primary",
  "--primary-foreground",
  "--accent",
  "--accent-foreground",
  "--ring",
  "--sidebar",
] as const;

function applyAccentHue(hue: number, dark: boolean): void {
  const root = document.documentElement.style;
  root.setProperty("--primary", `${hue} 88% ${dark ? 68 : 28}%`);
  root.setProperty(
    "--primary-foreground",
    dark ? `${hue} 45% 10%` : "0 0% 100%",
  );
  root.setProperty("--accent", dark ? `${hue} 45% 15%` : `${hue} 55% 96%`);
  root.setProperty(
    "--accent-foreground",
    dark ? `${hue} 85% 78%` : `${hue} 80% 26%`,
  );
  root.setProperty("--ring", dark ? `${hue} 85% 68%` : `${hue} 70% 40%`);
  root.setProperty("--sidebar", dark ? `${hue} 30% 7%` : `${hue} 35% 99%`);
}

function clearAccentOverride(): void {
  const root = document.documentElement.style;
  for (const prop of THEME_OVERRIDE_PROPS) root.removeProperty(prop);
}

function useHyeboardState() {
  const queryClient = useQueryClient();
  const { t } = useLocale();
  const [universityId, setUniversityId] = useState<string>(() =>
    stored("hyeboard.universityId", "uet"),
  );
  const [palette, setPalette] = useState<Palette>(() =>
    stored("hyeboard.palette", "uet"),
  );
  const [mode, setMode] = useState<Mode>(() =>
    stored("hyeboard.mode", "light"),
  );
  const [themeHue, setThemeHue] = useState<number>(
    () => Number(stored("hyeboard.themeHue", "209")) || 209,
  );
  const [termCode, setTermCode] = useState<string | undefined>();
  const [sessionNonce, setSessionNonce] = useState(0);
  const [accounts, setAccounts] = useState<StoredAccount[]>(() =>
    listAccounts(),
  );
  const [activeAccountId, setActiveAccountId] = useState<string | null>(() =>
    getActiveAccountId(),
  );
  const [removingAccountIds, setRemovingAccountIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [accountActionError, setAccountActionError] = useState<string>();
  const [accountActionErrorAccountId, setAccountActionErrorAccountId] =
    useState<string>();
  const [accountActionErrorSource, setAccountActionErrorSource] =
    useState<AccountActionSource>();
  const accountActionErrorSourceRef = useRef<AccountActionSource | undefined>(
    undefined,
  );
  const currentAccountActionRef = useRef<AccountActionOperation | undefined>(
    undefined,
  );
  const pendingAccountActionsRef = useRef(new Map<string, symbol>());
  const [vnuReconnectState, setVnuReconnectState] = useState<
    "idle" | "reconnecting" | "retryable"
  >("idle");

  const clearAccountActionError = (source?: AccountActionSource): void => {
    const currentSource =
      currentAccountActionRef.current?.source ??
      accountActionErrorSourceRef.current;
    if (source && currentSource !== source) return;
    currentAccountActionRef.current = undefined;
    accountActionErrorSourceRef.current = undefined;
    setAccountActionError(undefined);
    setAccountActionErrorAccountId(undefined);
    setAccountActionErrorSource(undefined);
  };

  // Fires on every account switch/add/remove (see ACCOUNT_SWITCHED_EVENT in
  // lib/api.ts) - re-syncs universityId/palette to whichever account is now
  // active and refetches all feature data for it.
  useEffect(() => {
    const syncActiveAccount = () => {
      setAccounts(listAccounts());
      setActiveAccountId(getActiveAccountId());
      setVnuReconnectState("idle");
      clearAccountActionError();
      const account = getActiveAccount();
      if (account) {
        setUniversityId(account.universityId);
        setPalette(
          account.universityId === "uet" || account.universityId === "vnu"
            ? (account.universityId as Palette)
            : "geist",
        );
      }
      setSessionNonce((value) => value + 1);
      void queryClient.invalidateQueries({
        predicate: shouldInvalidateAccountQuery,
        refetchType: "active",
      });
    };
    window.addEventListener(ACCOUNT_SWITCHED_EVENT, syncActiveAccount);
    return () =>
      window.removeEventListener(ACCOUNT_SWITCHED_EVENT, syncActiveAccount);
  }, []);

  useEffect(() => {
    const readDetail = (
      event: Event,
    ):
      | { accountId: string; state?: "idle" | "reconnecting" | "retryable" }
      | undefined => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object") return undefined;
      const candidate = detail as { accountId?: unknown; state?: unknown };
      if (typeof candidate.accountId !== "string") return undefined;
      if (
        candidate.state !== undefined &&
        candidate.state !== "idle" &&
        candidate.state !== "reconnecting" &&
        candidate.state !== "retryable"
      )
        return undefined;
      return { accountId: candidate.accountId, state: candidate.state };
    };
    const handleRefreshStatus = (event: Event) => {
      const detail = readDetail(event);
      const active = getActiveAccount();
      if (
        !detail?.state ||
        !active ||
        active.id !== detail.accountId ||
        active.universityId !== "vnu"
      )
        return;
      setVnuReconnectState(detail.state);
    };
    const handleRefreshCommitted = (event: Event) => {
      const detail = readDetail(event);
      const activeId = getActiveAccountId();
      const active = getActiveAccount();
      if (
        !detail ||
        detail.accountId !== activeId ||
        active?.universityId !== "vnu"
      )
        return;
      setVnuReconnectState("idle");
      setSessionNonce((value) => value + 1);
      void queryClient.invalidateQueries({
        predicate: (query) =>
          shouldInvalidateVnuRefreshQuery(query, detail.accountId, activeId),
        refetchType: "none",
      });
    };
    window.addEventListener(VNU_REFRESH_STATUS_EVENT, handleRefreshStatus);
    window.addEventListener(
      VNU_REFRESH_COMMITTED_EVENT,
      handleRefreshCommitted,
    );
    return () => {
      window.removeEventListener(VNU_REFRESH_STATUS_EVENT, handleRefreshStatus);
      window.removeEventListener(
        VNU_REFRESH_COMMITTED_EVENT,
        handleRefreshCommitted,
      );
    };
  }, [queryClient]);

  useEffect(() => {
    document.documentElement.dataset.theme = palette;
    document.documentElement.dataset.mode = mode;
    localStorage.setItem("hyeboard.palette", palette);
    localStorage.setItem("hyeboard.mode", mode);
    localStorage.setItem("hyeboard.universityId", universityId);
    localStorage.setItem("hyeboard.themeHue", String(themeHue));
    if (palette === "uet" || palette === "vnu")
      applyAccentHue(themeHue, mode === "dark");
    else clearAccentOverride();
  }, [mode, palette, universityId, themeHue]);

  const universities = useQuery({
    queryKey: ["universities"],
    queryFn: api.universities,
    refetchOnWindowFocus: false,
  });

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

  const selectUniversity = (
    nextUniversityId: string,
    options: { clearSession?: boolean } = {},
  ) => {
    if (options.clearSession ?? true) clearSessionToken();
    setSessionNonce((value) => value + 1);
    setUniversityId(nextUniversityId);
    setPalette(
      nextUniversityId === "uet" || nextUniversityId === "vnu"
        ? (nextUniversityId as Palette)
        : "geist",
    );
  };

  const refreshSession = () => {
    setSessionNonce((value) => value + 1);
    void queryClient.invalidateQueries({
      predicate: shouldInvalidateAccountQuery,
      refetchType: "active",
    });
  };

  const removeStoredAccount = async (
    accountId: string,
    source: AccountActionSource = "account-menu",
  ): Promise<void> => {
    if (pendingAccountActionsRef.current.has(accountId)) return;
    const origin = listAccounts().find((account) => account.id === accountId);
    if (!origin) return;
    const operation: AccountActionOperation = {
      generation: Symbol(`account-action:${accountId}`),
      accountId,
      accountToken: origin.token,
      source,
    };
    currentAccountActionRef.current = operation;
    accountActionErrorSourceRef.current = source;
    pendingAccountActionsRef.current.set(accountId, operation.generation);
    setAccountActionError(undefined);
    setAccountActionErrorAccountId(undefined);
    setAccountActionErrorSource(source);
    setRemovingAccountIds((ids) => new Set(ids).add(accountId));
    let publishedError = false;
    try {
      await revokeAndRemoveAccount(accountId);
      setAccounts(listAccounts());
      setActiveAccountId(getActiveAccountId());
    } catch (error) {
      const account = listAccounts().find(
        (candidate) => candidate.id === accountId,
      );
      const operationStillOwnsError = operationOwnsFailure({
        operation,
        currentOperation: currentAccountActionRef.current,
        pendingGeneration: pendingAccountActionsRef.current.get(accountId),
        currentAccountToken: account?.token,
        activeAccountId: getActiveAccountId(),
      });
      if (operationStillOwnsError && account) {
        publishedError = true;
        setAccountActionError(
          account.universityId === "vnu"
            ? t.common.vnuRevocationFailed
            : error instanceof Error
              ? error.message
              : t.common.vnuRevocationFailed,
        );
        setAccountActionErrorAccountId(accountId);
        setAccountActionErrorSource(source);
      }
      throw error;
    } finally {
      if (
        operationOwnsPendingEntry(
          operation,
          pendingAccountActionsRef.current.get(accountId),
        )
      ) {
        pendingAccountActionsRef.current.delete(accountId);
        setRemovingAccountIds((ids) => {
          const next = new Set(ids);
          next.delete(accountId);
          return next;
        });
      }
      if (
        operationMayClearOwner(
          operation,
          currentAccountActionRef.current,
          publishedError,
        )
      ) {
        currentAccountActionRef.current = undefined;
        accountActionErrorSourceRef.current = undefined;
        setAccountActionErrorSource(undefined);
      }
    }
  };

  const logout = async (
    source: AccountActionSource = "settings",
  ): Promise<void> => {
    const accountId = getActiveAccountId();
    if (!accountId) return;
    await removeStoredAccount(accountId, source);
    clearReloginSecrets();
  };

  return {
    universityId,
    selectUniversity,
    palette,
    setPalette,
    mode,
    setMode,
    themeHue,
    setThemeHue,
    termCode,
    setTermCode,
    universities,
    dashboard,
    ensureSession,
    refreshSession,
    logout,
    sessionNonce,
    accounts,
    activeAccountId,
    switchToAccount: switchAccount,
    removeStoredAccount,
    removingAccountIds,
    accountActionError,
    accountActionErrorAccountId,
    accountActionErrorSource,
    clearAccountActionError,
    vnuReconnectState,
  };
}

export function useFeatureQuery<T>(
  name: string,
  queryFn: () => Promise<T>,
  options: { enabled?: boolean } = {},
) {
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
