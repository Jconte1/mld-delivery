"use client";

import { useState, type FormEvent } from "react";
import { useFormStatus } from "react-dom";

import {
  parseDateInputValue,
  validateRequestedDeliveryDateEligibility,
} from "@/lib/notifications/deliveryDateEligibility";

type DeliveryConfirmationActionsProps = {
  token: string;
  status: string;
  scheduledDateLabel: string;
  requestedNewDateLabel: string | null;
  minimumRequestedDate: string;
  currentDeliveryDate: string;
  deliveryAddressState: string | null;
  deliveryAddressPostalCode: string | null;
  requestedDateInstruction: string;
  isLocked: boolean;
  errorMessage: string | null;
  confirmDeliveryAction: (formData: FormData) => void | Promise<void>;
  requestDifferentDateAction: (formData: FormData) => void | Promise<void>;
};

function SubmitButton({
  children,
  className,
  disabled,
  isSubmitting,
  pendingLabel,
}: {
  children: React.ReactNode;
  className: string;
  disabled?: boolean;
  isSubmitting?: boolean;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();
  const submitting = pending || Boolean(isSubmitting);

  return (
    <button className={className} disabled={disabled || submitting}>
      {submitting ? pendingLabel : children}
    </button>
  );
}

function lockedMessage(props: DeliveryConfirmationActionsProps) {
  if (props.status === "CONFIRMED") {
    return `Your delivery has been confirmed for ${props.scheduledDateLabel}.`;
  }

  if (props.status === "NEW_DATE_REQUESTED" && props.requestedNewDateLabel) {
    return `We received your request to move your delivery to ${props.requestedNewDateLabel}. Our team will review and follow up if needed.`;
  }

  return null;
}

export function DeliveryConfirmationActions(props: DeliveryConfirmationActionsProps) {
  const [showDatePicker, setShowDatePicker] = useState(
    props.status === "AWAITING_NEW_DATE" || Boolean(props.errorMessage)
  );
  const [selectedDate, setSelectedDate] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);
  const [requestSubmitting, setRequestSubmitting] = useState(false);
  const finalMessage = lockedMessage(props);

  function onConfirmSubmit(event: FormEvent<HTMLFormElement>) {
    if (confirmSubmitting) {
      event.preventDefault();
      return;
    }

    if (
      !window.confirm(
        "Are you sure you want to confirm this delivery date? Once confirmed, you will need to call Mountain Land Design to make changes."
      )
    ) {
      event.preventDefault();
      setConfirmSubmitting(false);
      return;
    }

    setConfirmSubmitting(true);
  }

  function onRequestedDateSubmit(event: FormEvent<HTMLFormElement>) {
    if (requestSubmitting) {
      event.preventDefault();
      return;
    }

    if (!selectedDate) {
      event.preventDefault();
      setClientError("Please choose a requested delivery date.");
      return;
    }

    if (selectedDate < props.minimumRequestedDate) {
      event.preventDefault();
      setClientError("Please select a date after your current scheduled delivery date.");
      return;
    }

    const parsed = parseDateInputValue(selectedDate);
    const validation = validateRequestedDeliveryDateEligibility({
      requestedDate: parsed.valid ? parsed.date : null,
      currentDeliveryDate: props.currentDeliveryDate,
      address: {
        state: props.deliveryAddressState,
        postalCode: props.deliveryAddressPostalCode,
      },
    });

    if (!validation.allowed) {
      event.preventDefault();
      setClientError(validation.webMessage);
      return;
    }

    if (
      !window.confirm(
        "Are you sure you want to request this new delivery date? After submitting, you will need to call Mountain Land Design to make additional changes."
      )
    ) {
      event.preventDefault();
      setRequestSubmitting(false);
      return;
    }

    setRequestSubmitting(true);
  }

  if (props.isLocked) {
    return finalMessage ? (
      <div className="mt-6 rounded-md bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900 ring-1 ring-emerald-200">
        {finalMessage}
      </div>
    ) : null;
  }

  return (
    <div className="mt-6">
      <div className="flex flex-col gap-3 sm:flex-row">
        <form action={props.confirmDeliveryAction} onSubmit={onConfirmSubmit}>
          <input type="hidden" name="token" value={props.token} />
          <SubmitButton
            className="w-full rounded-md bg-zinc-950 px-5 py-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400 sm:w-auto"
            isSubmitting={confirmSubmitting}
            pendingLabel="Confirming..."
          >
            Confirm Delivery
          </SubmitButton>
        </form>

        {!showDatePicker ? (
          <button
            type="button"
            disabled={confirmSubmitting || requestSubmitting}
            onClick={() => {
              setShowDatePicker(true);
              setClientError(null);
            }}
            className="rounded-md border border-zinc-300 px-5 py-3 text-sm font-semibold text-zinc-900 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
          >
            Request Different Date
          </button>
        ) : null}
      </div>

      {showDatePicker ? (
        <form
          action={props.requestDifferentDateAction}
          onSubmit={onRequestedDateSubmit}
          className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start"
        >
          <input type="hidden" name="token" value={props.token} />
          <div>
            <label className="sr-only" htmlFor="requestedNewDate">
              Requested delivery date
            </label>
            <input
              id="requestedNewDate"
              type="date"
              name="requestedNewDate"
              min={props.minimumRequestedDate}
              value={selectedDate}
              onChange={(event) => {
                setSelectedDate(event.target.value);
                setClientError(null);
              }}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm sm:w-auto"
            />
            <p className="mt-2 text-xs text-zinc-500">{props.requestedDateInstruction}</p>
          </div>
          <SubmitButton
            className="rounded-md bg-zinc-950 px-5 py-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
            isSubmitting={requestSubmitting}
            pendingLabel="Submitting request..."
          >
            Confirm Requested Date
          </SubmitButton>
          <button
            type="button"
            disabled={requestSubmitting}
            onClick={() => {
              setShowDatePicker(false);
              setSelectedDate("");
              setClientError(null);
            }}
            className="rounded-md border border-zinc-300 px-5 py-3 text-sm font-semibold text-zinc-900 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
          >
            Cancel
          </button>
        </form>
      ) : null}

      {clientError || props.errorMessage ? (
        <div className="mt-3 rounded-md bg-rose-50 px-4 py-3 text-sm font-medium text-rose-900 ring-1 ring-rose-200">
          {clientError ?? props.errorMessage}
        </div>
      ) : null}
    </div>
  );
}
