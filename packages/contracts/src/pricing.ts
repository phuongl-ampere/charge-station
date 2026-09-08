export const HOURLY_PRICE_VND = 5000;

export function calculateAmountVnd(durationMinutes: number): number {
  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes <= 0 ||
    durationMinutes % 60 !== 0
  ) {
    throw new Error("Duration must be a whole number of hours");
  }

  return (durationMinutes / 60) * HOURLY_PRICE_VND;
}
