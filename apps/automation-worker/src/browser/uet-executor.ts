import type { UetImportJob } from "@hyeboard/automation-protocol";
import { createUetAdapter } from "@hyeboard/university-adapters/src/uet/adapter";
import type {
    BrowserConnection as AdapterBrowserConnection,
    ImportedSession,
    ImportSessionContext,
    LoginImportInput,
    UniversityAdapter,
} from "@hyeboard/university-adapters";
import { AutomationWorkerError } from "../runtime/errors";
import type {
    AutomationExecutionContext,
    AutomationExecutor,
    AutomationProgressPhase,
} from "./executor";
import { createUetAdapterConnection, type BrowserConnection } from "./provider";

export type UetAutomationCredential = Pick<
    LoginImportInput,
    "uetGoogleEmail" | "uetGooglePassword" | "uetGoogleCookies"
> & {
    uetGoogleEmail: string;
    uetGooglePassword: string;
};

export type UetCaptchaRequest = {
    job: UetImportJob;
    image: string;
    signal: AbortSignal;
};

/**
 * The worker event sink is publish-only. Hosts that can receive CAPTCHA
 * answers provide this hook; the executor never puts an answer in an event.
 */
export type UetCaptchaAnswerHandler = (
    request: UetCaptchaRequest,
) => Promise<string>;

export type UetAdapterConnectionFactory = (
    connection: BrowserConnection,
    assertOwned: () => Promise<void>,
) => AdapterBrowserConnection;

export type UetAutomationExecutorOptions = {
    adapter?: UniversityAdapter;
    adapterConnection?: UetAdapterConnectionFactory;
    onCaptchaNeeded?: UetCaptchaAnswerHandler;
};

function unsupported(message: string): AutomationWorkerError {
    return new AutomationWorkerError(message, "UET_BROWSER_BRIDGE_UNSUPPORTED");
}

function invalidCredential(): AutomationWorkerError {
    return new AutomationWorkerError(
        "The automation credential payload is invalid.",
        "UET_CREDENTIAL_INVALID",
    );
}

function assertCredential(
    value: unknown,
): asserts value is UetAutomationCredential {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw invalidCredential();
    const credential = value as Record<string, unknown>;
    if (
        typeof credential.uetGoogleEmail !== "string" ||
        credential.uetGoogleEmail.trim() === ""
    )
        throw invalidCredential();
    if (
        typeof credential.uetGooglePassword !== "string" ||
        credential.uetGooglePassword === ""
    )
        throw invalidCredential();
    if (
        credential.uetGoogleCookies !== undefined &&
        !Array.isArray(credential.uetGoogleCookies)
    )
        throw invalidCredential();
}

function progressForMessage(message: string): {
    phase: AutomationProgressPhase;
    percent: number;
} {
    const normalized = message.toLowerCase();
    if (normalized.includes("canvas")) return { phase: "import", percent: 85 };
    if (normalized.includes("finaliz"))
        return { phase: "finalize", percent: 75 };
    if (
        normalized.includes("sign") ||
        normalized.includes("studenthub") ||
        normalized.includes("vnu")
    ) {
        return {
            phase: "login",
            percent: normalized.includes("complet") ? 60 : 35,
        };
    }
    return { phase: "login", percent: 20 };
}

function assertExpectedStudentCode(
    result: ImportedSession,
    expectedStudentCode: string | undefined,
): void {
    if (!expectedStudentCode) return;
    const actualStudentCode = result.studentCode ?? result.session.studentCode;
    if (actualStudentCode !== expectedStudentCode) {
        throw new AutomationWorkerError(
            "The automated sign-in returned a different student account.",
            "UET_IDENTITY_MISMATCH",
        );
    }
}

async function waitForProgress(progressTail: Promise<void>): Promise<void> {
    await progressTail;
}

export function createUetAutomationExecutor(
    options: UetAutomationExecutorOptions = {},
): AutomationExecutor<UetAutomationCredential, ImportedSession> {
    const adapter = options.adapter ?? createUetAdapter();

    return {
        async execute(
            context: AutomationExecutionContext<UetAutomationCredential>,
        ): Promise<ImportedSession> {
            assertCredential(context.credential);
            context.cancellation.throwIfCancelled();

            const assertOwned = async (): Promise<void> => {
                context.cancellation.throwIfCancelled();
                await context.browser.assertOwned();
                context.cancellation.throwIfCancelled();
            };
            const adapterConnection = (
                options.adapterConnection ?? createUetAdapterConnection
            )(context.browser, assertOwned);
            if (adapterConnection.kind === "cloudflare") {
                throw unsupported(
                    "Cloudflare browser connections are not supported by the self-hosted automation worker.",
                );
            }
            await assertOwned();

            let progressTail = Promise.resolve();
            const reportProgress = (message: string): void => {
                context.cancellation.throwIfCancelled();
                const next = progressForMessage(message);
                progressTail = progressTail.then(async () => {
                    context.cancellation.throwIfCancelled();
                    await context.progress(next.phase, next.percent);
                });
            };

            await context.progress("queue", 0);
            await context.progress("login", 10);

            const captchaHandler = options.onCaptchaNeeded
                ? async (image: string, signal?: AbortSignal) =>
                      options.onCaptchaNeeded!({
                          job: context.job,
                          image,
                          signal: signal ?? context.cancellation.signal,
                      })
                : context.onCaptchaNeeded;
            const importContext: ImportSessionContext = {
                browserConnection: adapterConnection,
                signal: context.cancellation.signal,
                onProgress: reportProgress,
                onCaptchaNeeded: captchaHandler
                    ? async (image, signal) => {
                          context.cancellation.throwIfCancelled();
                          const answer = await captchaHandler(image, signal);
                          context.cancellation.throwIfCancelled();
                          if (
                              typeof answer !== "string" ||
                              answer.trim() === ""
                          ) {
                              throw new AutomationWorkerError(
                                  "The CAPTCHA answer was empty.",
                                  "UET_CAPTCHA_ANSWER_INVALID",
                              );
                          }
                          return answer;
                      }
                    : async () => {
                          throw new AutomationWorkerError(
                              "CAPTCHA answering is not configured for the automation worker.",
                              "UET_CAPTCHA_UNSUPPORTED",
                          );
                      },
            };

            let imported: ImportedSession;
            try {
                imported = await adapter.importSession(
                    {
                        uetGoogleEmail: context.credential.uetGoogleEmail,
                        uetGooglePassword: context.credential.uetGooglePassword,
                        ...(context.credential.uetGoogleCookies === undefined
                            ? {}
                            : {
                                  uetGoogleCookies:
                                      context.credential.uetGoogleCookies,
                              }),
                        signal: context.cancellation.signal,
                    },
                    importContext,
                );
                await waitForProgress(progressTail);
            } catch (error) {
                await progressTail.catch(() => undefined);
                throw error;
            }

            context.cancellation.throwIfCancelled();
            assertExpectedStudentCode(
                imported,
                context.job.expectedStudentCode,
            );
            await context.progress("finalize", 100);
            return imported;
        },
    };
}
