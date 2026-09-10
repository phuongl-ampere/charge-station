import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AdminLogin } from "./AdminLogin";

describe("AdminLogin", () => {
  it("authenticates an operator and forwards the issued token", async () => {
    const user = userEvent.setup();
    const onAuthenticated = vi.fn();
    const login = vi.fn().mockResolvedValue({ accessToken: "admin-token" });

    render(<AdminLogin api={{ login }} onAuthenticated={onAuthenticated} />);

    await user.type(screen.getByLabelText("Email"), "admin@charge.local");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(login).toHaveBeenCalledWith({
        email: "admin@charge.local",
        password: "correct-password",
      }),
    );
    expect(onAuthenticated).toHaveBeenCalledWith("admin-token");
  });
});
