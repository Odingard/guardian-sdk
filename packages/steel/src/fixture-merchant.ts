// Generated file — do not edit.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * The explicitly identified test merchant: "Guardian Fixture Shop"
 * (`fixture-shop.guardian.test`), a local storefront with no payment rail.
 * Orders are recorded in an in-memory ledger; no money moves (SANDBOX).
 *
 * The merchant account token is the protected credential: checkout only
 * succeeds when the trusted executor fills it in. The agent never sees it.
 */
export const FIXTURE_MERCHANT_ID = "fixture-shop.guardian.test";

export type FixtureOrder = Readonly<{
  orderId: string;
  sku: string;
  quantity: number;
  totalCents: number;
  currency: string;
  shipTo: Readonly<Record<string, string>>;
  placedAtEpochMs: number;
}>;

export type FixtureMerchant = Readonly<{
  merchantId: string;
  origin: string;
  accountToken: string;
  ledgerToken: string;
  orders(): readonly FixtureOrder[];
  rejectedSubmissions(): number;
  setPrice(sku: string, unitCents: number): void;
  close(): Promise<void>;
}>;

const SHIP_FIELDS = ["name", "line1", "city", "postalCode", "country"];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><header><strong>Guardian Fixture Shop</strong> — test merchant, no real payments</header>${body}</body></html>`;
}

export async function startFixtureMerchant(
  input: {
    host?: string;
    port?: number;
    /** Origin the browser uses to reach this server (e.g. via docker host). */
    publicOrigin?: string;
    accountToken?: string;
  } = {},
): Promise<FixtureMerchant> {
  const prices = new Map<string, { label: string; unitCents: number }>([
    ["GUARD-TEE-01", { label: "Guardian logo tee", unitCents: 2_400 }],
    ["GUARD-MUG-02", { label: "Authority mug", unitCents: 1_250 }],
  ]);
  const accountToken =
    input.accountToken ?? `fxacct_${randomBytes(18).toString("base64url")}`;
  const ledgerToken = `fxledger_${randomBytes(18).toString("base64url")}`;
  const orders: FixtureOrder[] = [];
  let rejected = 0;

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    const send = (status: number, html: string, headers = {}) => {
      response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        ...headers,
      });
      response.end(html);
    };
    if (request.method === "GET" && url.pathname === "/") {
      const items = [...prices.entries()]
        .map(
          ([sku, item]) =>
            `<li data-sku="${sku}">${escapeHtml(item.label)} — $${(item.unitCents / 100).toFixed(2)} <a href="/checkout?sku=${sku}&qty=1">Buy</a></li>`,
        )
        .join("");
      return send(200, page("Guardian Fixture Shop", `<ul>${items}</ul>`));
    }
    if (request.method === "GET" && url.pathname === "/checkout") {
      const sku = url.searchParams.get("sku") ?? "";
      const quantity = Number.parseInt(url.searchParams.get("qty") ?? "", 10);
      const item = prices.get(sku);
      if (!item || !Number.isInteger(quantity) || quantity < 1) {
        return send(404, page("Not found", "<p>Unknown item</p>"));
      }
      const total = item.unitCents * quantity;
      return send(
        200,
        page(
          "Checkout",
          `<main data-guardian-checkout data-merchant-id="${FIXTURE_MERCHANT_ID}" data-sku="${sku}" data-quantity="${quantity}" data-total-cents="${total}" data-currency="USD">
<h1>Checkout: ${escapeHtml(item.label)} × ${quantity}</h1><p>Total $${(total / 100).toFixed(2)} USD</p>
<form id="checkout" method="post" action="/orders">
<input type="hidden" name="sku" value="${sku}"><input type="hidden" name="quantity" value="${quantity}">
<input type="hidden" name="expectedTotalCents" value="">
${SHIP_FIELDS.map((field) => `<label>${field} <input name="ship_${field}"></label>`).join("")}
<input type="hidden" name="accountToken" value="">
<button type="submit">Place order</button></form></main>`,
        ),
      );
    }
    if (request.method === "POST" && url.pathname === "/orders") {
      let raw = "";
      request.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
        if (raw.length > 16_384) request.destroy();
      });
      request.on("end", () => {
        const form = new URLSearchParams(raw);
        const item = prices.get(form.get("sku") ?? "");
        const quantity = Number.parseInt(form.get("quantity") ?? "", 10);
        if (form.get("accountToken") !== accountToken) {
          rejected += 1;
          return send(
            401,
            page("Rejected", "<p>Merchant account required</p>"),
          );
        }
        if (!item || !Number.isInteger(quantity) || quantity < 1) {
          rejected += 1;
          return send(400, page("Rejected", "<p>Invalid order</p>"));
        }
        const total = item.unitCents * quantity;
        if (form.get("expectedTotalCents") !== String(total)) {
          rejected += 1;
          return send(409, page("Rejected", "<p>Price changed</p>"));
        }
        const orderId = `FX-${String(orders.length + 1).padStart(6, "0")}`;
        orders.push({
          orderId,
          sku: form.get("sku")!,
          quantity,
          totalCents: total,
          currency: "USD",
          shipTo: Object.fromEntries(
            SHIP_FIELDS.map((field) => [
              field,
              form.get(`ship_${field}`) ?? "",
            ]),
          ),
          placedAtEpochMs: Date.now(),
        });
        send(303, "", { location: `/orders/${orderId}` });
      });
      return;
    }
    const confirmation = /^\/orders\/(FX-\d{6})$/.exec(url.pathname);
    if (request.method === "GET" && confirmation) {
      const order = orders.find((entry) => entry.orderId === confirmation[1]);
      if (!order) return send(404, page("Not found", "<p>No order</p>"));
      return send(
        200,
        page(
          "Order confirmed",
          `<main data-guardian-order data-order-id="${order.orderId}" data-merchant-id="${FIXTURE_MERCHANT_ID}" data-sku="${order.sku}" data-quantity="${order.quantity}" data-total-cents="${order.totalCents}" data-currency="${order.currency}" data-status="confirmed"><h1>Order ${order.orderId} confirmed</h1></main>`,
        ),
      );
    }
    if (request.method === "GET" && url.pathname === "/__ledger") {
      if (request.headers["x-ledger-token"] !== ledgerToken) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ merchantId: FIXTURE_MERCHANT_ID, orders }));
      return;
    }
    send(404, page("Not found", "<p>Not found</p>"));
  });

  const host = input.host ?? "127.0.0.1";
  await new Promise<void>((resolve) =>
    server.listen(input.port ?? 0, host, resolve),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const origin = input.publicOrigin ?? `http://${host}:${port}`;

  return {
    merchantId: FIXTURE_MERCHANT_ID,
    origin: origin.replace(/:0$/, `:${port}`),
    accountToken,
    ledgerToken,
    orders: () => [...orders],
    rejectedSubmissions: () => rejected,
    setPrice(sku, unitCents) {
      const item = prices.get(sku);
      if (item) prices.set(sku, { ...item, unitCents });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
