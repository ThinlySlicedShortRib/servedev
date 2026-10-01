"use client"

import * as React from "react"
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { type VariantProps } from "class-variance-authority"
import { cn } from "cn"

import { toggleVariants } from "@/components/ui/toggle"
import { useStyleId } from "@/components/style-provider"

const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants> & {
    spacing?: number
    orientation?: "horizontal" | "vertical"
  }
>({
  size: "default",
  variant: "default",
  spacing: 2,
  orientation: "horizontal",
})

/**
 * Studio style: one thumb under the pressed item of an outline group, so the selection glides
 * between items instead of jumping. Presentational only: it reads data-pressed and sizes.
 */
function StudioThumb() {
  const ref = React.useRef<HTMLSpanElement>(null)
  React.useLayoutEffect(() => {
    const thumb = ref.current
    const group = thumb?.parentElement
    if (!thumb || !group) return
    const place = () => {
      const item = group.querySelector<HTMLElement>("button[data-pressed]")
      if (!item) {
        thumb.style.opacity = "0"
        return
      }
      const g = group.getBoundingClientRect()
      const r = item.getBoundingClientRect()
      thumb.style.width = `${r.width}px`
      thumb.style.height = `${r.height}px`
      thumb.style.transform = `translate(${r.left - g.left - group.clientLeft}px, ${r.top - g.top - group.clientTop}px)`
      thumb.style.opacity = "1"
      // Appear in place the first time; glide after that.
      if (!("ready" in thumb.dataset)) requestAnimationFrame(() => (thumb.dataset.ready = ""))
    }
    place()
    const mo = new MutationObserver(place)
    mo.observe(group, { subtree: true, attributes: true, attributeFilter: ["data-pressed"] })
    const ro = new ResizeObserver(place)
    ro.observe(group)
    group.querySelectorAll("button").forEach((el) => ro.observe(el))
    return () => {
      mo.disconnect()
      ro.disconnect()
    }
  }, [])
  return <span ref={ref} aria-hidden data-slot="toggle-group-thumb" className="studio-thumb" />
}

function ToggleGroup({
  className,
  variant,
  size,
  spacing = 2,
  orientation = "horizontal",
  children,
  ...props
}: ToggleGroupPrimitive.Props &
  VariantProps<typeof toggleVariants> & {
    spacing?: number
    orientation?: "horizontal" | "vertical"
  }) {
  const studio = useStyleId() === "studio"
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      data-orientation={orientation}
      style={{ "--gap": spacing } as React.CSSProperties}
      className={cn(
        "group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] rounded-lg data-[size=sm]:rounded-[min(var(--radius-md),10px)] data-vertical:flex-col data-vertical:items-stretch",
        className
      )}
      {...props}
    >
      {studio && variant === "outline" && <StudioThumb />}
      <ToggleGroupContext.Provider
        value={{ variant, size, spacing, orientation }}
      >
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  )
}

function ToggleGroupItem({
  className,
  children,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext)

  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      data-variant={context.variant || variant}
      data-size={context.size || size}
      data-spacing={context.spacing}
      className={cn(
        "shrink-0 group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:px-2 focus:z-10 focus-visible:z-10 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-end]:pr-1.5 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-start]:pl-1.5 group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-l-lg group-data-vertical/toggle-group:data-[spacing=0]:first:rounded-t-lg group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-r-lg group-data-vertical/toggle-group:data-[spacing=0]:last:rounded-b-lg group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:border-l-0 group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0 group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-l group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t",
        toggleVariants({
          variant: context.variant || variant,
          size: context.size || size,
        }),
        className
      )}
      {...props}
    >
      {children}
    </TogglePrimitive>
  )
}

export { ToggleGroup, ToggleGroupItem }
