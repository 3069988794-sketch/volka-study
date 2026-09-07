const navItems = [
  { href: "/", label: "今日" },
  { href: "/map", label: "地图" },
  { href: "/ability", label: "能力" },
  { href: "/library", label: "词库" },
  { href: "/settings", label: "设置" }
];

export function TopNav() {
  return (
    <header className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 pb-5 pt-5 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between gap-4">
        <a href="/" className="flex items-center gap-3 rounded-sm">
          <span className="grid size-10 place-items-center rounded-sm bg-[var(--ink)] text-sm font-semibold text-[var(--paper)]">
            VS
          </span>
          <span>
            <span className="block text-base font-semibold tracking-normal">Volka Study</span>
            <span className="block text-xs text-[var(--muted)]">60 分钟学习工作台</span>
          </span>
        </a>
        <nav className="flex max-w-full gap-1 overflow-x-auto rounded-sm border border-[var(--line)] bg-[var(--panel)] p-1 shadow-sm">
          {navItems.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="whitespace-nowrap rounded-sm px-3 py-2 text-sm font-medium text-[var(--muted)] transition hover:bg-[color-mix(in_srgb,var(--accent),transparent_88%)] hover:text-[var(--ink)]"
            >
              {item.label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}
