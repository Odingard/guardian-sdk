// Generated file — do not edit.
import { connectCdp, type WebSocketFactory } from "./cdp.js";

/**
 * The trusted browser port. One `open()` = one Steel session the
 * executor owns end to end; it is released after every checkout so no
 * authenticated merchant state outlives the authorized action.
 */
export interface BrowserPage {
  navigate(url: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  evaluateAndWaitForNavigation(expression: string): Promise<unknown>;
  /** PNG (base64) of the current viewport — evidence only. */
  screenshot?(): Promise<string>;
}

export interface BrowserSession {
  readonly sessionRef: string;
  readonly page: BrowserPage;
  release(): Promise<void>;
}

export interface BrowserPort {
  open(): Promise<BrowserSession>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type SteelBrowserConfig = Readonly<{
  /** Steel API origin, e.g. http://steel:3000 (never exposed to the agent). */
  apiBaseUrl: string;
  /**
   * CDP websocket override. Steel reports `websocketUrl` from its DOMAIN
   * setting, which may not be routable from the executor's network.
   */
  cdpUrl?: string;
  navigationTimeoutMs?: number;
  fetch?: FetchLike;
  webSocket?: WebSocketFactory;
}>;

export function createSteelBrowser(config: SteelBrowserConfig): BrowserPort {
  const fetcher: FetchLike = config.fetch ?? ((url, init) => fetch(url, init));
  const base = config.apiBaseUrl.replace(/\/+$/, "");
  const navigationTimeoutMs = config.navigationTimeoutMs ?? 20_000;

  return {
    async open() {
      const created = await fetcher(`${base}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blockAds: true }),
      });
      if (!created.ok) throw new Error(`STEEL_SESSION_HTTP_${created.status}`);
      const session = (await created.json()) as {
        id?: unknown;
        websocketUrl?: unknown;
      };
      if (typeof session.id !== "string") {
        throw new Error("STEEL_SESSION_INVALID");
      }
      const sessionId = session.id;
      const webSocketUrl =
        config.cdpUrl ??
        (typeof session.websocketUrl === "string" ? session.websocketUrl : "");
      const releaseSteel = async () => {
        await fetcher(
          `${base}/v1/sessions/${encodeURIComponent(sessionId)}/release`,
          { method: "POST" },
        ).catch(() => undefined);
      };
      let cdp;
      try {
        cdp = await connectCdp({
          webSocketUrl,
          ...(config.webSocket === undefined
            ? {}
            : { webSocket: config.webSocket }),
        });
      } catch (error) {
        await releaseSteel();
        throw error;
      }
      let targetId: string;
      let pageSession: string;
      try {
        const target = await cdp.send("Target.createTarget", {
          url: "about:blank",
        });
        targetId = String(target.targetId);
        const attached = await cdp.send("Target.attachToTarget", {
          targetId,
          flatten: true,
        });
        pageSession = String(attached.sessionId);
        await cdp.send("Page.enable", {}, pageSession);
      } catch (error) {
        // No page means no checkout. Do not leave a live (billed)
        // Steel session or an open CDP socket behind.
        cdp.close();
        await releaseSteel();
        throw error;
      }

      const evaluate = async (expression: string) => {
        const evaluated = await cdp.send(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          pageSession,
        );
        if (evaluated.exceptionDetails !== undefined) {
          throw new Error("PAGE_SCRIPT_FAILED");
        }
        return (evaluated.result as { value?: unknown } | undefined)?.value;
      };

      return {
        sessionRef: sessionId,
        page: {
          async navigate(url) {
            const loaded = cdp.waitForEvent(
              "Page.loadEventFired",
              pageSession,
              navigationTimeoutMs,
            );
            const navigated = await cdp.send(
              "Page.navigate",
              { url },
              pageSession,
            );
            if (typeof navigated.errorText === "string") {
              loaded.catch(() => undefined);
              throw new Error(`NAVIGATION_FAILED:${navigated.errorText}`);
            }
            await loaded;
          },
          evaluate,
          async evaluateAndWaitForNavigation(expression) {
            const loaded = cdp.waitForEvent(
              "Page.loadEventFired",
              pageSession,
              navigationTimeoutMs,
            );
            let value: unknown;
            try {
              value = await evaluate(expression);
            } catch (error) {
              loaded.catch(() => undefined);
              throw error;
            }
            // The expression reports `true` only when it submitted. Anything
            // else means no navigation is coming: stop waiting, so a form
            // that never submitted is not mistaken for a lost submit.
            if (value !== true) {
              loaded.catch(() => undefined);
              return value;
            }
            await loaded;
            return value;
          },
          async screenshot() {
            const shot = await cdp.send(
              "Page.captureScreenshot",
              { format: "png" },
              pageSession,
            );
            return String(shot.data ?? "");
          },
        },
        async release() {
          await cdp
            .send("Target.closeTarget", { targetId })
            .catch(() => undefined);
          cdp.close();
          await releaseSteel();
        },
      };
    },
  };
}
