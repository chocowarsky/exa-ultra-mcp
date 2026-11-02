import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAdmin } from "./admin.js";
import { registerAgent } from "./agent.js";
import { registerContents } from "./contents.js";
import { registerMonitors } from "./monitors.js";
import { registerSearch } from "./search.js";
import type { Ctx, ToolModule } from "./shared.js";

export type { Ctx, ToolModule } from "./shared.js";

/** Tool modules in registration order. To add a feature, write a ToolModule and list it here. */
export function toolModules(ctx: Ctx): ToolModule[] {
  return [
    registerSearch,
    registerContents,
    ...(ctx.config.enableAgent ? [registerAgent] : []),
    ...(ctx.config.enableMonitors ? [registerMonitors] : []),
    registerAdmin,
  ];
}

export function registerTools(server: McpServer, ctx: Ctx) {
  for (const m of toolModules(ctx)) m(server, ctx);
}
