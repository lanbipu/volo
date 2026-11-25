/* 新壳入口：main.tsx 在开关打开时动态 import 本模块（旧壳及其 CSS 不会被加载）。 */
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import "@/ui/fonts.css";
import "@/ui/tokens.css";
import "@/ui/base.css";
import "@/ui/components/runyard.css";
import "@/ui/components/volo.css";
import { AppShell } from "./AppShell";
import { createQueryClient } from "./queryClient";

export function App() {
  const [client] = useState(createQueryClient);
  return (
    <StrictMode>
      <QueryClientProvider client={client}>
        <AppShell />
      </QueryClientProvider>
    </StrictMode>
  );
}
