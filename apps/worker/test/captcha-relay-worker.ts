export { CaptchaRelayDurableObject } from "../src/captcha/captcha-relay-durable-object";
export { FeaturePolicyDurableObject } from "../src/policy/feature-policy-durable-object";
export { VnuProbeBudgetDurableObject } from "../src/vnu/vnu-probe-budget-durable-object";
export { VnuRefreshControlDurableObject } from "../src/vnu/vnu-refresh-control-durable-object";

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
