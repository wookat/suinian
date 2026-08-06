export function PageHeader({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <header className="hidden md:block">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </header>
  )
}
