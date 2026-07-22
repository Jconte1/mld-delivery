import {
  getSalespersonContactDisplay,
  type SalespersonContactInput,
} from "@/lib/notifications/salespersonContactDisplay";

export function SalespersonContactBlock({
  contact,
}: {
  contact?: SalespersonContactInput | null;
}) {
  const display = getSalespersonContactDisplay(contact);
  if (!display) return null;

  return (
    <div className="mt-5 rounded-md bg-sky-50 px-4 py-3 text-sm text-sky-950 ring-1 ring-sky-200">
      Questions or changes? Contact{" "}
      {display.name ? (
        <>
          <span className="font-medium">{display.name}</span> at{" "}
        </>
      ) : null}
      {display.phone && display.phoneHref ? (
        <a
          className="font-medium underline decoration-sky-300 underline-offset-2"
          href={display.phoneHref}
        >
          {display.phone}
        </a>
      ) : display.phone ? (
        <span className="font-medium">{display.phone}</span>
      ) : null}
      {display.phone && display.email ? " or " : null}
      {display.email ? (
        <a
          className="font-medium underline decoration-sky-300 underline-offset-2"
          href={`mailto:${display.email}`}
        >
          {display.email}
        </a>
      ) : null}
      .
    </div>
  );
}
