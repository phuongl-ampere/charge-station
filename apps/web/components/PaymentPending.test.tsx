import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PaymentPending } from "./PaymentPending";

describe("PaymentPending", () => {
  it("offers a payment-link recovery action while preserving status navigation", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const onViewStatus = vi.fn();

    render(
      <PaymentPending
        amount={10000}
        currency="VND"
        onRefresh={onRefresh}
        onViewStatus={onViewStatus}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Payment link pending" }),
    ).toBeVisible();
    expect(screen.getByText("10,000 VND")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Check payment link" }),
    );
    await user.click(
      screen.getByRole("button", { name: "View charging status" }),
    );

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onViewStatus).toHaveBeenCalledOnce();
  });
});
