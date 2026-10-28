import { useState, type ReactNode } from "react";

export function Field({
  label,
  className = "",
  children
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`field flex flex-col gap-1 text-sm ${className}`}>
      <span className="text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
    </label>
  );
}

export const SUGGESTED_INTERESTS = [
  "food",
  "history",
  "art",
  "architecture",
  "museums",
  "nature",
  "viewpoints",
  "nightlife",
  "shopping",
  "beaches",
  "markets",
  "music"
];

/** Toggleable suggestion chips plus free-text entry. */
export function InterestPicker({
  value,
  onChange
}: {
  value: string[];
  onChange: (interests: string[]) => void;
}) {
  const [text, setText] = useState("");
  const options = [...new Set([...SUGGESTED_INTERESTS, ...value])];

  function toggle(interest: string) {
    onChange(
      value.includes(interest)
        ? value.filter((i) => i !== interest)
        : [...value, interest]
    );
  }

  function addTyped() {
    const interest = text.trim().toLowerCase();
    if (interest && !value.includes(interest) && value.length < 20) {
      onChange([...value, interest]);
    }
    setText("");
  }

  return (
    <fieldset className="text-sm">
      <legend className="mb-1 text-neutral-600 dark:text-neutral-400">
        Interests
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((interest) => {
          const on = value.includes(interest);
          return (
            <button
              key={interest}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(interest)}
              className={
                on
                  ? "rounded-full border border-orange-600 bg-orange-600 px-3 py-1 text-white"
                  : "rounded-full border border-neutral-300 px-3 py-1 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
              }
            >
              {interest}
            </button>
          );
        })}
      </div>
      <div className="field mt-2 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTyped();
            }
          }}
          placeholder="Add your own…"
          aria-label="Add an interest"
          maxLength={40}
          className="min-w-0 flex-1"
        />
        <SecondaryButton onClick={addTyped} disabled={!text.trim()}>
          Add
        </SecondaryButton>
      </div>
    </fieldset>
  );
}

export function PrimaryButton(
  props: React.ButtonHTMLAttributes<HTMLButtonElement>
) {
  return (
    <button
      type="button"
      {...props}
      className={`rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50 ${props.className ?? ""}`}
    />
  );
}

export function SecondaryButton(
  props: React.ButtonHTMLAttributes<HTMLButtonElement>
) {
  return (
    <button
      type="button"
      {...props}
      className={`rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900 ${props.className ?? ""}`}
    />
  );
}

/** Small text button for row actions. */
export function LinkButton(
  props: React.ButtonHTMLAttributes<HTMLButtonElement>
) {
  return (
    <button
      type="button"
      {...props}
      className={`rounded px-1.5 py-0.5 text-xs text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 ${props.className ?? ""}`}
    />
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm whitespace-pre-wrap text-red-600">
      {children}
    </p>
  );
}
