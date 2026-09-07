import { TopNav } from "./top-nav";

export function PlaceholderPage({ title, detail }: { title: string; detail: string }) {
  return (
    <>
      <TopNav />
      <main className="mx-auto w-full max-w-7xl px-4 pb-10 sm:px-6 lg:px-8">
        <section className="rounded-sm border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[var(--shadow)]">
          <p className="text-sm text-[var(--muted)]">MVP 骨架</p>
          <h1 className="mt-2 text-2xl font-semibold">{title}</h1>
          <p className="mt-3 max-w-2xl leading-7 text-[var(--muted)]">{detail}</p>
        </section>
      </main>
    </>
  );
}
