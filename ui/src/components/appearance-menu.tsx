import { MonitorIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react"

import { Hint } from "@/components/hint"
import { STYLES, useStyle, type StyleId } from "@/components/style-provider"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const THEMES = [
  { id: "system", label: "System", icon: MonitorIcon },
  { id: "light", label: "Light", icon: SunIcon },
  { id: "dark", label: "Dark", icon: MoonIcon },
] as const

/** Header menu: the dashboard's style (Classic, Studio, Terminal, Friendly) and light/dark. */
export function AppearanceMenu() {
  const { style, setStyle } = useStyle()
  const { theme, setTheme } = useTheme()
  return (
    <DropdownMenu>
      <Hint label="Appearance: style, and light or dark (press D to switch)">
        <DropdownMenuTrigger render={<Button size="icon-sm" variant="outline" aria-label="Appearance" />}>
          <PaletteIcon />
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Style</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={style} onValueChange={(v) => setStyle(v as StyleId)}>
            {STYLES.map((s) => (
              <DropdownMenuRadioItem key={s.id} value={s.id} closeOnClick={false}>
                <div className="grid leading-tight">
                  <span>{s.label}</span>
                  <span className="text-xs text-muted-foreground">{s.description}</span>
                </div>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as (typeof THEMES)[number]["id"])}>
            {THEMES.map((t) => (
              <DropdownMenuRadioItem key={t.id} value={t.id} closeOnClick={false}>
                <t.icon className="text-muted-foreground" />
                {t.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
