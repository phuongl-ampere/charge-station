import { expect, test } from "@playwright/test";

async function mockLocalApi(
  page: import("@playwright/test").Page,
): Promise<{ authorizedOrderRead: () => boolean }> {
  let sawAuthorizedOrderRead = false;
  await page.context().route("http://localhost:4000/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === "GET" && url.pathname === "/public/connectors/ST01-C01") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          stationCode: "ST01",
          connectorCode: "ST01-C01",
          status: "AVAILABLE",
          allowedDurationsMinutes: [60, 120, 180],
          hourlyPriceVnd: 5000,
        }),
      });
      return;
    }
    if (method === "POST" && url.pathname === "/orders") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          orderId: "ord_1",
          amount: 10000,
          currency: "VND",
          payment: {
            provider: "PAYOS",
            checkoutUrl: "http://localhost:4000/payments/payos/mock/123",
          },
          realtimeAccessToken: "local-order-token",
        }),
      });
      return;
    }
    if (method === "GET" && url.pathname === "/orders/ord_1") {
      const authorization = route.request().headers()["authorization"];
      if (authorization !== "Bearer local-order-token") {
        await route.fulfill({
          contentType: "application/json",
          status: 401,
          body: JSON.stringify({ message: "Missing order capability" }),
        });
        return;
      }
      sawAuthorizedOrderRead = true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: "ord_1",
          status: "PENDING_PAYMENT",
          amountVnd: 10000,
          currency: "VND",
          durationMinutes: 120,
          connectorCode: "ST01-C01",
          payment: { provider: "PAYOS", status: "PENDING" },
        }),
      });
      return;
    }
    if (method === "GET" && url.pathname === "/payments/payos/mock/123") {
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Mock PayOS Checkout</title><h1>Mock PayOS Checkout</h1>",
      });
      return;
    }
    await route.fulfill({ status: 404, body: "mock route not found" });
  });
  return {
    authorizedOrderRead: () => sawAuthorizedOrderRead,
  };
}

async function mockAmbiguousLocalApi(
  page: import("@playwright/test").Page,
): Promise<{ authorizedPaymentLinkRead: () => boolean }> {
  let sawAuthorizedPaymentLinkRead = false;
  await page.context().route("http://localhost:4000/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === "GET" && url.pathname === "/public/connectors/ST01-C01") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          stationCode: "ST01",
          connectorCode: "ST01-C01",
          status: "AVAILABLE",
          allowedDurationsMinutes: [60, 120, 180],
          hourlyPriceVnd: 5000,
        }),
      });
      return;
    }
    if (method === "POST" && url.pathname === "/orders") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          orderId: "ord_ambiguous",
          amount: 10000,
          currency: "VND",
          payment: {
            provider: "PAYOS",
            paymentPending: true,
          },
          realtimeAccessToken: "ambiguous-order-token",
        }),
      });
      return;
    }
    if (
      method === "GET" &&
      url.pathname === "/orders/ord_ambiguous/payment-link"
    ) {
      if (
        route.request().headers()["authorization"] !==
        "Bearer ambiguous-order-token"
      ) {
        await route.fulfill({
          contentType: "application/json",
          status: 401,
          body: JSON.stringify({ message: "Missing order capability" }),
        });
        return;
      }
      sawAuthorizedPaymentLinkRead = true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          provider: "PAYOS",
          checkoutUrl: "http://localhost:4000/payments/payos/mock/ambiguous",
        }),
      });
      return;
    }
    if (method === "GET" && url.pathname === "/payments/payos/mock/ambiguous") {
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Mock PayOS Checkout</title><h1>Mock PayOS Checkout</h1>",
      });
      return;
    }
    await route.fulfill({ status: 404, body: "mock route not found" });
  });
  return {
    authorizedPaymentLinkRead: () => sawAuthorizedPaymentLinkRead,
  };
}

async function mockReturnCapabilityApi(
  page: import("@playwright/test").Page,
): Promise<{ authorizedOrderRead: () => boolean }> {
  let sawAuthorizedOrderRead = false;
  await page.context().route("http://localhost:4000/**", async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() === "GET" &&
      url.pathname === "/orders/ord_return"
    ) {
      if (
        route.request().headers()["authorization"] !==
        "Bearer returned-capability"
      ) {
        await route.fulfill({
          contentType: "application/json",
          status: 401,
          body: JSON.stringify({ message: "Missing order capability" }),
        });
        return;
      }
      sawAuthorizedOrderRead = true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: "ord_return",
          status: "PENDING_PAYMENT",
          amountVnd: 10000,
          currency: "VND",
          durationMinutes: 120,
          connectorCode: "ST01-C01",
          payment: { provider: "PAYOS", status: "PENDING" },
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "mock route not found" });
  });
  return {
    authorizedOrderRead: () => sawAuthorizedOrderRead,
  };
}

test("selects a duration, opens local PayOS checkout, and shows payment waiting", async ({
  page,
}, testInfo) => {
  const api = await mockLocalApi(page);
  await page.goto("/scan/ST01-C01");

  await page.getByRole("button", { name: "2 hours" }).click();
  await page.getByRole("button", { name: "Create payment link" }).click();

  await expect(
    page.getByRole("heading", { name: "Scan or open checkout" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("checkout.png"),
    fullPage: true,
  });
  const checkout = page.waitForURL(
    /localhost:4000\/payments\/payos\/mock\/123/,
  );
  await page.getByRole("button", { name: "Open PayOS checkout" }).click();
  await checkout;

  await page.goto("/charge/ord_1");
  await expect
    .poll(() =>
      page.evaluate(() => window.sessionStorage.getItem("charge-token:ord_1")),
    )
    .toBe("local-order-token");
  await expect(
    page.getByRole("heading", { name: "Waiting for payment" }),
  ).toBeVisible();
  await expect.poll(api.authorizedOrderRead).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("payment-waiting.png"),
    fullPage: true,
  });
});

test("uses an encrypted station QR URL to choose a connector without exposing station code", async ({
  page,
}) => {
  await page.context().route("http://localhost:4000/**", async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() === "GET" &&
      url.pathname === "/public/stations/scan/ciphertext-token"
    ) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          stationName: "Riverside Station",
          connectors: [
            {
              connectorCode: "ST01-C01",
              status: "AVAILABLE",
              allowedDurationsMinutes: [60, 120],
              hourlyPriceVnd: 5000,
            },
            {
              connectorCode: "ST01-C02",
              status: "OFFLINE",
              allowedDurationsMinutes: [60, 120],
              hourlyPriceVnd: 5000,
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "mock route not found" });
  });

  await page.goto("/scan/station/ciphertext-token");

  await expect(
    page.getByRole("heading", { name: "Riverside Station" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "ST01-C01" })).toBeVisible();
  await expect(page.getByRole("button", { name: "ST01-C02" })).toBeDisabled();
  expect(page.url()).toContain("/scan/station/ciphertext-token");
  expect(page.url()).not.toContain("ST01");
});

test("recovers an ambiguous payment link with its stored order capability", async ({
  page,
}, testInfo) => {
  const api = await mockAmbiguousLocalApi(page);
  await page.goto("/scan/ST01-C01");

  await page.getByRole("button", { name: "Create payment link" }).click();

  await expect(
    page.getByRole("heading", { name: "Payment link pending" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.sessionStorage.getItem("charge-token:ord_ambiguous"),
      ),
    )
    .toBe("ambiguous-order-token");

  await page.getByRole("button", { name: "Check payment link" }).click();

  await expect(
    page.getByRole("heading", { name: "Scan or open checkout" }),
  ).toBeVisible();
  await expect.poll(api.authorizedPaymentLinkRead).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("ambiguous-payment-recovered.png"),
    fullPage: true,
  });
  const checkout = page.waitForURL(
    /localhost:4000\/payments\/payos\/mock\/ambiguous/,
  );
  await page.getByRole("button", { name: "Open PayOS checkout" }).click();
  await checkout;
});

test("stores a PayOS return capability from the fragment before loading charge status", async ({
  page,
}) => {
  const api = await mockReturnCapabilityApi(page);

  await page.goto("/charge/ord_return#charge_access=returned-capability");

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.sessionStorage.getItem("charge-token:ord_return"),
      ),
    )
    .toBe("returned-capability");
  await expect
    .poll(() => page.url())
    .toBe("http://127.0.0.1:3100/charge/ord_return");
  await expect(
    page.getByRole("heading", { name: "Waiting for payment" }),
  ).toBeVisible();
  await expect.poll(api.authorizedOrderRead).toBe(true);
});
