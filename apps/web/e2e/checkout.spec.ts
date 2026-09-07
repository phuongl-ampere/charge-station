import { expect, test } from "@playwright/test";

async function mockLocalApi(
  page: import("@playwright/test").Page,
): Promise<void> {
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
}

test("selects a duration, opens local PayOS checkout, and shows payment waiting", async ({
  page,
}, testInfo) => {
  await mockLocalApi(page);
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
  const checkout = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open PayOS checkout" }).click();
  const checkoutPage = await checkout;
  await expect(checkoutPage).toHaveURL(
    /localhost:4000\/payments\/payos\/mock\/123/,
  );

  await page.getByRole("button", { name: "View charging status" }).click();
  await expect(
    page.getByRole("heading", { name: "Waiting for payment" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("payment-waiting.png"),
    fullPage: true,
  });
});
