export function DeliveryInfoState({ title, message }: { title: string; message: string }) {
  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-16 text-zinc-950">
      <section className="mx-auto max-w-xl rounded-lg bg-white p-8 shadow-sm ring-1 ring-zinc-200">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-3 text-zinc-700">{message}</p>
      </section>
    </main>
  );
}
