export { CaptchaRelayDurableObject } from "../src/captcha-relay-durable-object";
export { FeaturePolicyDurableObject } from "../src/feature-policy-durable-object";
export { VnuProbeBudgetDurableObject } from "../src/vnu-probe-budget-durable-object";
export { VnuRefreshControlDurableObject } from "../src/vnu-refresh-control-durable-object";

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
