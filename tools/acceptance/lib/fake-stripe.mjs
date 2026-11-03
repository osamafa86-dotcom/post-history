// A local stand-in for the three Stripe test-mode calls the server's adapter makes (apps/api/src/commerce/stripe-provider.ts):
// create a Checkout Session (idempotent by Idempotency-Key), read it, and refund. No card, no network beyond 127.0.0.1, no
// real money; the notifications themselves are signed by the acceptance script with the stack's webhook secret.
import http from "node:http";
import { randomBytes } from "node:crypto";

export async function startFakeStripe() {
  const sessions = new Map();
  const byKey = new Map();
  let origin = "";
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (!/^Bearer sk_test_/.test(req.headers.authorization ?? "")) return json(401, { error: { type: "invalid_request_error" } });
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (req.method === "POST" && path === "/v1/checkout/sessions") {
      const key = req.headers["idempotency-key"];
      if (key && byKey.has(key)) return json(200, sessions.get(byKey.get(key)));
      const form = new URLSearchParams(body);
      const id = `cs_test_${randomBytes(12).toString("hex")}`;
      const session = {
        id, object: "checkout.session", url: `${origin}/c/pay/${id}`, status: "open", payment_status: "unpaid",
        expires_at: Number(form.get("expires_at")), amount_total: Number(form.get("line_items[0][price_data][unit_amount]")),
        currency: form.get("line_items[0][price_data][currency]"), payment_intent: `pi_${randomBytes(12).toString("hex")}`,
      };
      sessions.set(id, session);
      if (key) byKey.set(key, id);
      return json(200, session);
    }
    const read = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(path);
    if (req.method === "GET" && read && sessions.has(read[1])) return json(200, sessions.get(read[1]));
    if (req.method === "POST" && path === "/v1/refunds") return json(200, { id: `re_${randomBytes(12).toString("hex")}`, object: "refund" });
    return json(404, { error: { type: "invalid_request_error" } });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  // the hosted page link points back here: nothing in the run leaves the machine
  origin = `http://127.0.0.1:${server.address().port}`;
  return { url: origin, sessions, close: () => new Promise((ok) => server.close(ok)) };
}
