import type { UetImportJob } from "@hyeboard/automation-protocol";
import type { CancellationToken } from "../runtime/cancellation";
import type { BrowserConnection } from "./provider";

export type AutomationProgressPhase =
  | "queue"
  | "login"
  | "captcha"
  | "import"
  | "finalize";

export type AutomationCaptchaHandler = (
  image: string,
  signal?: AbortSignal,
) => Promise<string>;

export type AutomationExecutionContext<TCredential> = {
  job: UetImportJob;
  credential: TCredential;
  browser: BrowserConnection;
  cancellation: CancellationToken;
  progress(phase: AutomationProgressPhase, percent: number): Promise<void>;
  onCaptchaNeeded?: AutomationCaptchaHandler;
};

export interface AutomationExecutor<TCredential, TResult> {
  execute(context: AutomationExecutionContext<TCredential>): Promise<TResult>;
}
