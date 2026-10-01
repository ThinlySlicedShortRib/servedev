import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { StyleProvider } from "@/components/style-provider"
import { StudioDecor } from "@/components/studio-decor"
import { TerminalDecor } from "@/components/terminal-decor"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <StyleProvider>
        <TooltipProvider>
          <App />
          <Toaster />
          <TerminalDecor />
          <StudioDecor />
        </TooltipProvider>
      </StyleProvider>
    </ThemeProvider>
  </StrictMode>
)
