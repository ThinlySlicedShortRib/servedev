/* eslint-disable react-refresh/only-export-components */
/**
 * Terminal's icon set: 1-bit pixel glyphs drawn on a 7x7 grid, with lucide's names and props.
 * Wired in through components/icons.tsx; don't import these directly.
 * Each glyph sits in an 8x8 box with half a cell of margin, so at 16px every pixel
 * lands on whole device pixels and stays crisp.
 */
import * as React from "react"
import type { LucideProps } from "lucide-react"

import { cn } from "@/lib/utils"


/** Rows of '#' (on) and '.' (off) to one path of horizontal runs. */
export function toPath(rows: string[]): string {
  let d = ""
  rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      if (row[x] !== "#") {
        x++
        continue
      }
      let end = x
      while (row[end] === "#") end++
      d += `M${x} ${y}h${end - x}v1h${x - end}z`
      x = end
    }
  })
  return d
}

type IconProps = LucideProps

/** Drops lucide-only props so they don't land on the <svg>. */
function svgProps(props: Omit<IconProps, "size" | "color" | "className" | "children">) {
  const rest = { ...props }
  delete rest.strokeWidth
  delete rest.absoluteStrokeWidth
  return rest
}

function pixel(name: string, rows: string[]) {
  const d = toPath(rows)
  const Icon = React.forwardRef<SVGSVGElement, IconProps>(function PixelIcon(
    // Lucide-only props are dropped; the rest go to the <svg>.
    { size = 24, color, className, children, ...rest },
    ref
  ) {
    const props = svgProps(rest)
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="-0.5 -0.5 8 8"
        fill={color ?? "currentColor"}
        shapeRendering="crispEdges"
        aria-hidden={props["aria-label"] ? undefined : true}
        data-pixel-icon={name}
        className={cn("pixel-icon", className)}
        {...props}
      >
        <path d={d} />
        {children}
      </svg>
    )
  })
  Icon.displayName = name
  return Icon
}

/* prettier-ignore */
const G = {
  plus:      [".......", "...#...", "...#...", ".#####.", "...#...", "...#...", "......."],
  x:         [".......", ".#...#.", "..#.#..", "...#...", "..#.#..", ".#...#.", "......."],
  check:     [".......", "......#", ".....#.", "#...#..", ".#.#...", "..#....", "......."],
  down:      [".......", ".......", ".#...#.", "..#.#..", "...#...", ".......", "......."],
  up:        [".......", ".......", "...#...", "..#.#..", ".#...#.", ".......", "......."],
  right:     [".......", "..#....", "...#...", "....#..", "...#...", "..#....", "......."],
  upDown:    ["...#...", "..#.#..", ".#...#.", ".......", ".#...#.", "..#.#..", "...#..."],
  square:    [".......", ".#####.", ".#####.", ".#####.", ".#####.", ".#####.", "......."],
  play:      [".#.....", ".##....", ".###...", ".####..", ".###...", ".##....", ".#....."],
  search:    [".###...", "#...#..", "#...#..", "#...#..", ".###...", "....##.", ".....##"],
  copy:      ["####...", "#..#...", "#.####.", "#.#..#.", "###..#.", "..#..#.", "..####."],
  external:  ["....###", ".....##", "###.#.#", "#..#...", "#......", "#......", "#####.."],
  trash:     ["..###..", "#######", ".#...#.", ".#.#.#.", ".#.#.#.", ".#...#.", ".#####."],
  warn:      ["...#...", "..#.#..", "..#.#..", ".#.#.#.", ".#...#.", "#..#..#", "#######"],
  alert:     ["..###..", ".#...#.", "#..#..#", "#..#..#", "#.....#", ".#.#.#.", "..###.."],
  info:      ["..###..", ".#.#.#.", "#.....#", "#..#..#", "#..#..#", ".#...#.", "..###.."],
  okCircle:  ["..###..", ".#...#.", "#....##", "#.#.#.#", "#..#..#", ".#...#.", "..###.."],
  xCircle:   ["..###..", ".#...#.", "#.#.#.#", "#..#..#", "#.#.#.#", ".#...#.", "..###.."],
  pencil:    [".....##", "....###", "...###.", "..###..", ".###...", "##.....", "#......"],
  branch:    ["##...##", "##...##", ".#...#.", ".#..#..", ".#.#...", "##.....", "##....."],
  users:     [".#...#.", "###.###", ".#...#.", ".......", "###.###", "###.###", "......."],
  cw:        ["..###.#", ".#...##", "#...###", "#......", "#.....#", ".#...#.", "..###.."],
  ccw:       ["#.###..", "##...#.", "###...#", "......#", "#.....#", ".#...#.", "..###.."],
  grid:      ["###.###", "#.#.#.#", "###.###", ".......", "###.###", "#.#.#.#", "###.###"],
  key:       [".......", ".##....", "#..####", "#..##.#", ".##....", ".......", "......."],
  folder:    [".......", "###....", "#######", "#.....#", "#.....#", "#######", "......."],
  folderOpen:["###....", "#..###.", "#.....#", "#.#####", "##...#.", "#...#..", "#####.."],
  folderPlus:[".......", "###....", "#######", "#..#..#", "#.###.#", "#..#..#", "#######"],
  upload:    ["...#...", "..###..", ".#.#.#.", "...#...", "...#...", ".......", "#######"],
  save:      ["######.", "#.##.##", "#.##..#", "#.....#", "#.###.#", "#.###.#", "#######"],
  shield:    ["#######", "#.....#", "#..#..#", "#.###.#", ".#.#.#.", "..#.#..", "...#..."],
  share:     [".....##", ".....##", "...##..", "##.....", "...##..", ".....##", ".....##"],
  server:    ["#######", "#.....#", "#.#...#", "#######", "#.....#", "#.#...#", "#######"],
  scroll:    ["#######", "#.....#", "#.###.#", "#.....#", "#.##..#", "#.....#", "#######"],
  pin:       [".#####.", "..#.#..", "..#.#..", ".#####.", "...#...", "...#...", "...#..."],
  pinOff:    ["#.####.", ".#.#...", "..##...", ".####..", "...##..", "...#.#.", "...#..#"],
  panel:     ["#######", "#.#...#", "#.#...#", "#.#...#", "#.#...#", "#.#...#", "#######"],
  more:      [".......", ".......", ".......", "#..#..#", ".......", ".......", "......."],
  maximize:  ["....###", ".....##", "....#.#", "...#...", "#.#....", "##.....", "###...."],
  filter:    [".......", "#######", ".......", ".#####.", ".......", "..###..", "......."],
  layers:    ["..#####", "..#...#", "#####.#", "#...#.#", "#...###", "#...#..", "#####.."],
  hand:      [".#.#.#.", ".#.#.#.", ".#####.", "######.", ".#####.", "..###..", "..###.."],
  grip:      ["..#.#..", ".......", "..#.#..", ".......", "..#.#..", ".......", "..#.#.."],
  flask:     ["..###..", "..#.#..", "..#.#..", ".#...#.", ".#.#.#.", "#.###.#", "#######"],
  broom:     ["...#...", "...#...", "...#...", ".#####.", ".#.#.#.", ".#.#.#.", ".#.#.#."],
  bot:       ["...#...", ".#####.", "#.....#", "#.#.#.#", "#.....#", "#.###.#", ".#####."],
  link:      [".......", ".......", "###.###", "#.###.#", "###.###", ".......", "......."],
  lock:      ["..###..", ".#...#.", ".#...#.", "#######", "###.###", "###.###", "#######"],
  terminal:  ["#######", "#.....#", "#.#...#", "#..#..#", "#.#.###", "#.....#", "#######"],
  monitor:   ["#######", "#.....#", "#.....#", "#.....#", "#######", "...#...", "..###.."],
  sun:       ["...#...", ".#...#.", "..###..", "#.###.#", "..###..", ".#...#.", "...#..."],
  moon:      ["..###..", ".###...", "###....", "###....", "###...#", ".######", "..###.."],
  palette:   ["..###..", ".#...#.", "#.#...#", "#....##", "#.#..#.", ".#..#..", "..##..."],
}

export const PlusIcon = pixel("plus", G.plus)
export const XIcon = pixel("x", G.x)
export const CheckIcon = pixel("check", G.check)
export const ChevronDownIcon = pixel("chevron-down", G.down)
export const ChevronUpIcon = pixel("chevron-up", G.up)
export const ChevronRightIcon = pixel("chevron-right", G.right)
export const ChevronsUpDownIcon = pixel("chevrons-up-down", G.upDown)
export const SquareIcon = pixel("square", G.square)
export const PlayIcon = pixel("play", G.play)
export const SearchIcon = pixel("search", G.search)
export const CopyIcon = pixel("copy", G.copy)
export const ExternalLinkIcon = pixel("external-link", G.external)
export const Trash2Icon = pixel("trash", G.trash)
export const TriangleAlertIcon = pixel("triangle-alert", G.warn)
export const CircleAlertIcon = pixel("circle-alert", G.alert)
export const InfoIcon = pixel("info", G.info)
export const CircleCheckIcon = pixel("circle-check", G.okCircle)
export const CircleXIcon = pixel("circle-x", G.xCircle)
export const OctagonXIcon = pixel("octagon-x", G.xCircle)
export const PencilIcon = pixel("pencil", G.pencil)
export const GitBranchIcon = pixel("git-branch", G.branch)
export const UsersIcon = pixel("users", G.users)
export const RotateCwIcon = pixel("rotate-cw", G.cw)
export const RefreshCwIcon = pixel("refresh-cw", G.cw)
export const RotateCcwIcon = pixel("rotate-ccw", G.ccw)
export const LayoutGridIcon = pixel("layout-grid", G.grid)
export const KeyRoundIcon = pixel("key", G.key)
export const FolderOpenIcon = pixel("folder-open", G.folderOpen)
export const FolderIcon = pixel("folder", G.folder)
export const FolderPlusIcon = pixel("folder-plus", G.folderPlus)
export const UploadIcon = pixel("upload", G.upload)
export const SaveIcon = pixel("save", G.save)
export const ShieldIcon = pixel("shield", G.shield)
export const Share2Icon = pixel("share", G.share)
export const ServerIcon = pixel("server", G.server)
export const ScrollTextIcon = pixel("scroll", G.scroll)
export const PinIcon = pixel("pin", G.pin)
export const PinOffIcon = pixel("pin-off", G.pinOff)
export const PanelLeftIcon = pixel("panel-left", G.panel)
export const MoreHorizontalIcon = pixel("more", G.more)
export const EllipsisIcon = pixel("ellipsis", G.more)
export const Maximize2Icon = pixel("maximize", G.maximize)
export const ListFilterIcon = pixel("list-filter", G.filter)
export const LayersIcon = pixel("layers", G.layers)
export const HandIcon = pixel("hand", G.hand)
export const GripVerticalIcon = pixel("grip", G.grip)
export const FlaskConicalIcon = pixel("flask", G.flask)
export const BrushCleaningIcon = pixel("broom", G.broom)
export const BotIcon = pixel("bot", G.bot)
export const LinkIcon = pixel("link", G.link)
export const LockIcon = pixel("lock", G.lock)
export const TerminalIcon = pixel("terminal", G.terminal)
export const MonitorIcon = pixel("monitor", G.monitor)
export const SunIcon = pixel("sun", G.sun)
export const MoonIcon = pixel("moon", G.moon)
export const PaletteIcon = pixel("palette", G.palette)

/**
 * Braille spinner (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ in spirit): six dots of a braille cell, a gap chasing around it.
 * Pure CSS; holds still under reduced motion. Accepts `animate-spin` from callers and ignores it.
 */
export const Loader2Icon = React.forwardRef<SVGSVGElement, IconProps>(function BrailleSpinner(
  { size = 24, color, className, ...rest },
  ref
) {
  const props = svgProps(rest)
  // Clockwise around a 2x3 cell.
  const dots: [number, number][] = [[0, 0], [1, 0], [1, 1], [1, 2], [0, 2], [0, 1]]
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="-0.5 -0.5 8 8"
      fill={color ?? "currentColor"}
      shapeRendering="crispEdges"
      aria-hidden={props["aria-label"] ? undefined : true}
      className={cn("braille-spinner", className?.replace(/\banimate-spin\b/g, ""))}
      {...props}
    >
      {dots.map(([x, y], i) => (
        <rect key={i} x={1 + x * 3} y={y * 2.5 + 0.5} width={2} height={1.5} style={{ animationDelay: `${(i - 6) * 0.1}s` }} />
      ))}
    </svg>
  )
})
Loader2Icon.displayName = "Loader2Icon"
export const LoaderIcon = Loader2Icon
export const LoaderCircleIcon = Loader2Icon
