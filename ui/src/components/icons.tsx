/* eslint-disable react-refresh/only-export-components */
/**
 * The app's icons, per style. Import icons from here, never from lucide-react directly.
 *
 * Every lucide icon is re-exported as is (Classic). An icon a style redraws is wrapped with
 * `styledIcon(lucideIcon, { terminal: TerminalVersion, ... })`, which renders the active
 * style's version and falls back to lucide. To give another style its own icons, add its
 * key to the variants of the icons it redraws (or wrap more icons the same way).
 */
import * as React from "react"
import * as Lucide from "lucide-react"
import type { LucideProps } from "lucide-react"

import * as Terminal from "@/components/icons-terminal"
import { useStyleId, type StyleId } from "@/components/style-provider"

export * from "lucide-react"

type Icon = React.ForwardRefExoticComponent<LucideProps & React.RefAttributes<SVGSVGElement>>

export function styledIcon(base: Icon, variants: Partial<Record<StyleId, Icon>>): Icon {
  const Styled = React.forwardRef<SVGSVGElement, LucideProps>(function StyledIcon(props, ref) {
    const Variant = variants[useStyleId()] ?? base
    return <Variant ref={ref} {...props} />
  })
  Styled.displayName = base.displayName
  return Styled
}

export const BotIcon = styledIcon(Lucide.BotIcon, { terminal: Terminal.BotIcon })
export const BrushCleaningIcon = styledIcon(Lucide.BrushCleaningIcon, { terminal: Terminal.BrushCleaningIcon })
export const CheckIcon = styledIcon(Lucide.CheckIcon, { terminal: Terminal.CheckIcon })
export const ChevronDownIcon = styledIcon(Lucide.ChevronDownIcon, { terminal: Terminal.ChevronDownIcon })
export const ChevronRightIcon = styledIcon(Lucide.ChevronRightIcon, { terminal: Terminal.ChevronRightIcon })
export const ChevronUpIcon = styledIcon(Lucide.ChevronUpIcon, { terminal: Terminal.ChevronUpIcon })
export const ChevronsUpDownIcon = styledIcon(Lucide.ChevronsUpDownIcon, { terminal: Terminal.ChevronsUpDownIcon })
export const CircleAlertIcon = styledIcon(Lucide.CircleAlertIcon, { terminal: Terminal.CircleAlertIcon })
export const CircleCheckIcon = styledIcon(Lucide.CircleCheckIcon, { terminal: Terminal.CircleCheckIcon })
export const CircleXIcon = styledIcon(Lucide.CircleXIcon, { terminal: Terminal.CircleXIcon })
export const CopyIcon = styledIcon(Lucide.CopyIcon, { terminal: Terminal.CopyIcon })
export const EllipsisIcon = styledIcon(Lucide.EllipsisIcon, { terminal: Terminal.EllipsisIcon })
export const ExternalLinkIcon = styledIcon(Lucide.ExternalLinkIcon, { terminal: Terminal.ExternalLinkIcon })
export const FlaskConicalIcon = styledIcon(Lucide.FlaskConicalIcon, { terminal: Terminal.FlaskConicalIcon })
export const FolderIcon = styledIcon(Lucide.FolderIcon, { terminal: Terminal.FolderIcon })
export const FolderOpenIcon = styledIcon(Lucide.FolderOpenIcon, { terminal: Terminal.FolderOpenIcon })
export const FolderPlusIcon = styledIcon(Lucide.FolderPlusIcon, { terminal: Terminal.FolderPlusIcon })
export const GitBranchIcon = styledIcon(Lucide.GitBranchIcon, { terminal: Terminal.GitBranchIcon })
export const GripVerticalIcon = styledIcon(Lucide.GripVerticalIcon, { terminal: Terminal.GripVerticalIcon })
export const HandIcon = styledIcon(Lucide.HandIcon, { terminal: Terminal.HandIcon })
export const InfoIcon = styledIcon(Lucide.InfoIcon, { terminal: Terminal.InfoIcon })
export const KeyRoundIcon = styledIcon(Lucide.KeyRoundIcon, { terminal: Terminal.KeyRoundIcon })
export const LayersIcon = styledIcon(Lucide.LayersIcon, { terminal: Terminal.LayersIcon })
export const LayoutGridIcon = styledIcon(Lucide.LayoutGridIcon, { terminal: Terminal.LayoutGridIcon })
export const LinkIcon = styledIcon(Lucide.LinkIcon, { terminal: Terminal.LinkIcon })
export const ListFilterIcon = styledIcon(Lucide.ListFilterIcon, { terminal: Terminal.ListFilterIcon })
export const Loader2Icon = styledIcon(Lucide.Loader2Icon, { terminal: Terminal.Loader2Icon })
export const LoaderCircleIcon = styledIcon(Lucide.LoaderCircleIcon, { terminal: Terminal.LoaderCircleIcon })
export const LoaderIcon = styledIcon(Lucide.LoaderIcon, { terminal: Terminal.LoaderIcon })
export const LockIcon = styledIcon(Lucide.LockIcon, { terminal: Terminal.LockIcon })
export const Maximize2Icon = styledIcon(Lucide.Maximize2Icon, { terminal: Terminal.Maximize2Icon })
export const MoreHorizontalIcon = styledIcon(Lucide.MoreHorizontalIcon, { terminal: Terminal.MoreHorizontalIcon })
export const OctagonXIcon = styledIcon(Lucide.OctagonXIcon, { terminal: Terminal.OctagonXIcon })
export const PanelLeftIcon = styledIcon(Lucide.PanelLeftIcon, { terminal: Terminal.PanelLeftIcon })
export const PencilIcon = styledIcon(Lucide.PencilIcon, { terminal: Terminal.PencilIcon })
export const PinIcon = styledIcon(Lucide.PinIcon, { terminal: Terminal.PinIcon })
export const PinOffIcon = styledIcon(Lucide.PinOffIcon, { terminal: Terminal.PinOffIcon })
export const PlayIcon = styledIcon(Lucide.PlayIcon, { terminal: Terminal.PlayIcon })
export const PlusIcon = styledIcon(Lucide.PlusIcon, { terminal: Terminal.PlusIcon })
export const RefreshCwIcon = styledIcon(Lucide.RefreshCwIcon, { terminal: Terminal.RefreshCwIcon })
export const RotateCcwIcon = styledIcon(Lucide.RotateCcwIcon, { terminal: Terminal.RotateCcwIcon })
export const RotateCwIcon = styledIcon(Lucide.RotateCwIcon, { terminal: Terminal.RotateCwIcon })
export const SaveIcon = styledIcon(Lucide.SaveIcon, { terminal: Terminal.SaveIcon })
export const ScrollTextIcon = styledIcon(Lucide.ScrollTextIcon, { terminal: Terminal.ScrollTextIcon })
export const SearchIcon = styledIcon(Lucide.SearchIcon, { terminal: Terminal.SearchIcon })
export const ServerIcon = styledIcon(Lucide.ServerIcon, { terminal: Terminal.ServerIcon })
export const Share2Icon = styledIcon(Lucide.Share2Icon, { terminal: Terminal.Share2Icon })
export const ShieldIcon = styledIcon(Lucide.ShieldIcon, { terminal: Terminal.ShieldIcon })
export const SquareIcon = styledIcon(Lucide.SquareIcon, { terminal: Terminal.SquareIcon })
export const TerminalIcon = styledIcon(Lucide.TerminalIcon, { terminal: Terminal.TerminalIcon })
export const Trash2Icon = styledIcon(Lucide.Trash2Icon, { terminal: Terminal.Trash2Icon })
export const TriangleAlertIcon = styledIcon(Lucide.TriangleAlertIcon, { terminal: Terminal.TriangleAlertIcon })
export const UploadIcon = styledIcon(Lucide.UploadIcon, { terminal: Terminal.UploadIcon })
export const UsersIcon = styledIcon(Lucide.UsersIcon, { terminal: Terminal.UsersIcon })
export const XIcon = styledIcon(Lucide.XIcon, { terminal: Terminal.XIcon })
export const MonitorIcon = styledIcon(Lucide.MonitorIcon, { terminal: Terminal.MonitorIcon })
export const SunIcon = styledIcon(Lucide.SunIcon, { terminal: Terminal.SunIcon })
export const MoonIcon = styledIcon(Lucide.MoonIcon, { terminal: Terminal.MoonIcon })
export const PaletteIcon = styledIcon(Lucide.PaletteIcon, { terminal: Terminal.PaletteIcon })
