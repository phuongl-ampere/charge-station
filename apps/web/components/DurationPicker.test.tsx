import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DurationPicker } from "./DurationPicker";

describe("DurationPicker", () => {
  it("selects two hours and shows the server price format", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <DurationPicker
        durations={[60, 120]}
        hourlyPriceVnd={5000}
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByRole("button", { name: "2 hours" }));

    expect(onSelect).toHaveBeenCalledWith(120);
    expect(screen.getByText("10,000 VND")).toBeVisible();
  });
});
