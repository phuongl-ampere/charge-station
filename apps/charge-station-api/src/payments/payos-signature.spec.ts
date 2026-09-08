import { describe, expect, it } from "vitest";

import {
  buildPayosSignature,
  verifyPayosSignature,
} from "./payos-signature.js";

describe("PayOS signatures", () => {
  it("signs sorted non-empty webhook data", () => {
    expect(
      buildPayosSignature(
        { amount: 10000, orderCode: 100001, status: "PAID", ignored: "" },
        "checksum-key",
      ),
    ).toBe("fdfdaefba61fa5a11bf98f4642fde8e875b984116b0a9a1f48990793dbabf47f");
  });

  it("rejects a signature with the wrong checksum key", () => {
    expect(
      verifyPayosSignature({ orderCode: 100001 }, "not-valid", "checksum-key"),
    ).toBe(false);
  });
});
