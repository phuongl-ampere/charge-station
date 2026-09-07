"use client";

import { Clock3 } from "lucide-react";
import { useState } from "react";

interface DurationPickerProps {
  durations: number[];
  hourlyPriceVnd: number;
  onSelect: (durationMinutes: number) => void;
  disabled?: boolean;
}

function formatVnd(amount: number): string {
  return `${new Intl.NumberFormat("en-US").format(amount)} VND`;
}

function durationLabel(durationMinutes: number): string {
  const hours = durationMinutes / 60;
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function DurationPicker({
  durations,
  hourlyPriceVnd,
  onSelect,
  disabled = false,
}: DurationPickerProps) {
  const [selectedDuration, setSelectedDuration] = useState(
    durations.at(0) ?? 60,
  );
  const total = Math.round(hourlyPriceVnd * (selectedDuration / 60));

  function selectDuration(durationMinutes: number): void {
    setSelectedDuration(durationMinutes);
    onSelect(durationMinutes);
  }

  return (
    <section aria-labelledby="duration-heading" className="duration-picker">
      <div className="section-heading">
        <span className="section-icon" aria-hidden="true">
          <Clock3 size={16} strokeWidth={2} />
        </span>
        <div>
          <p className="eyebrow">Energy window</p>
          <h2 id="duration-heading">Select charging time</h2>
        </div>
      </div>
      <div className="duration-options" role="group" aria-label="Charging time">
        {durations.map((duration) => (
          <button
            className="duration-option"
            type="button"
            key={duration}
            aria-label={durationLabel(duration)}
            aria-pressed={selectedDuration === duration}
            disabled={disabled}
            onClick={() => selectDuration(duration)}
          >
            <span>{durationLabel(duration)}</span>
          </button>
        ))}
      </div>
      <output className="duration-total" aria-live="polite">
        <span>Total from station</span>
        <strong>{formatVnd(total)}</strong>
      </output>
    </section>
  );
}
