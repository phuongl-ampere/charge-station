import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage from "./page";

describe("HomePage", () => {
  it("only directs visitors to scan an encrypted station QR", () => {
    render(<HomePage />);

    expect(
      screen.getByRole("heading", { name: "Scan your station QR" }),
    ).toBeVisible();
    expect(screen.queryByLabelText("Connector")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open connector" })).not.toBeInTheDocument();
  });
});
