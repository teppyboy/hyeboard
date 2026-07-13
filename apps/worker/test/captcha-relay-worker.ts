export { CaptchaRelayDurableObject } from "../src/captcha-relay-durable-object";

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
