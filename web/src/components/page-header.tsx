export function PageHeader({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <header className="hidden md:block">
      <h1 className="text-display text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1.5 max-w-prose text-[15px] leading-relaxed text-muted-foreground">{description}</p>
    </header>
  )
}
