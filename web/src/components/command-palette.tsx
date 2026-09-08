import { useEffect, useState, type ComponentType } from "react"
import { ArrowRight, LogIn, Moon, PenLine, Search, Sun, SunMoon, Trash2 } from "lucide-react"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { setTheme } from "@/lib/theme"

export const COMMAND_PALETTE_EVENT = "suinian:command-palette"

export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_EVENT))
}

export interface CommandRoute {
  path: string
  label: string
  title: string
  icon: ComponentType<{ className?: string }>
}

/** 全局命令面板（⌘K / Ctrl+K）：页面跳转、搜索碎念、快速记录、切换主题 */
export function CommandPalette({ routes }: { routes: readonly CommandRoute[] }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener("keydown", onKey)
    window.addEventListener(COMMAND_PALETTE_EVENT, onOpen)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener(COMMAND_PALETTE_EVENT, onOpen)
    }
  }, [])

  const go = (hash: string) => {
    setOpen(false)
    setQuery("")
    window.location.hash = hash
  }

  const trimmed = query.trim()

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput value={query} onValueChange={setQuery} placeholder="搜索碎念、跳转页面或执行操作…" />
      <CommandList>
        <CommandEmpty>没有匹配的页面或操作</CommandEmpty>
        {trimmed && (
          <CommandGroup heading="搜索">
            <CommandItem value={`搜索 ${trimmed}`} onSelect={() => go(`#/?q=${encodeURIComponent(trimmed)}`)}>
              <Search />
              <span>
                在时间流里搜索「<span className="font-medium text-foreground">{trimmed}</span>」
              </span>
              <CommandShortcut>↵</CommandShortcut>
            </CommandItem>
            <CommandItem value={`提问 ${trimmed}`} onSelect={() => go(`#/?ask=${encodeURIComponent(trimmed)}`)}>
              <ArrowRight />
              <span>向我的碎念提问「{trimmed}」</span>
            </CommandItem>
          </CommandGroup>
        )}
        <CommandGroup heading="快速操作">
          <CommandItem value="快速记录 新建 写笔记" onSelect={() => go("#/?compose=1")}>
            <PenLine />
            快速记录一条碎念
            <CommandShortcut>N</CommandShortcut>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="页面">
          {routes.map((r) => {
            const Icon = r.icon
            return (
              <CommandItem key={r.path} value={`${r.label} ${r.title}`} onSelect={() => go(`#/${r.path}`)}>
                <Icon />
                {r.title}
              </CommandItem>
            )
          })}
          <CommandItem value="最近删除 回收站" onSelect={() => go("#/trash")}>
            <Trash2 />
            最近删除
          </CommandItem>
          <CommandItem value="注册 登录 账号" onSelect={() => go("#/auth")}>
            <LogIn />
            注册 / 登录
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="外观">
          <CommandItem
            value="浅色主题 light"
            onSelect={() => {
              setTheme("light")
              setOpen(false)
            }}
          >
            <Sun />
            浅色主题
          </CommandItem>
          <CommandItem
            value="深色主题 dark"
            onSelect={() => {
              setTheme("dark")
              setOpen(false)
            }}
          >
            <Moon />
            深色主题
          </CommandItem>
          <CommandItem
            value="跟随系统 system"
            onSelect={() => {
              setTheme("system")
              setOpen(false)
            }}
          >
            <SunMoon />
            跟随系统
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
