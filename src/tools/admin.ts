import { z } from "zod";
import { isMode, MODES, MODE_NAMES, type ModeName } from "../modes.js";
import { invalid, ok, serverMode, type ToolModule } from "./shared.js";

/** exa_mode (server-wide preset) and exa_keys_status (key pool health). */
export const registerAdmin: ToolModule = (server, ctx) => {
  server.registerTool(
    "exa_mode",
    {
      title: "Exa Ultra mode",
      description:
        "Show or set the server-wide quality mode used when a call sets no type/effort: " +
        MODE_NAMES.map((m) => `${m} = ${MODES[m].summary}`).join(" ") +
        " Setting it applies to every agent and session on this machine. Only set it when the user asks.",
      inputSchema: {
        set: z.enum(MODE_NAMES as [ModeName, ...ModeName[]]).optional().describe("New server mode. Omit to show the current one."),
        reset: z.boolean().optional().describe("Forget the saved mode and go back to EXA_MODE from the config."),
      },
    },
    async (a) => {
      if (a.set && a.reset) return invalid("use set or reset, not both.");
      if (a.set) ctx.store.update((s) => (s.settings.mode = a.set));
      if (a.reset) ctx.store.update((s) => delete s.settings.mode);
      const cur = serverMode(ctx);
      const saved = ctx.store.read().settings.mode;
      const source = isMode(saved) ? "saved with exa_mode" : "from EXA_MODE / default";
      const m: { searchType: string; agentEffort: string } = MODES[cur];
      return ok(
        `Mode: ${cur} (${source})\n- search type: ${m.searchType}\n- agent effort: ${m.agentEffort}${m.agentEffort === "ultra" || m.agentEffort === "auto" ? ` (cap $${ctx.config.agentMaxCost}/run)` : ""}\n\n` +
          MODE_NAMES.map((n) => `${n === cur ? "▶" : "-"} ${n}: ${MODES[n].summary}`).join("\n") +
          "\n\nPer call: pass mode=fast|auto|max, or an explicit type/effort.",
        { mode: cur, source, searchType: m.searchType, agentEffort: m.agentEffort, agentMaxCost: ctx.config.agentMaxCost },
      );
    },
  );

  server.registerTool(
    "exa_keys_status",
    {
      title: "Exa key pool status",
      description: "Show health, cooldowns, requests and tracked spend of each Exa key (keys shown as last 4 chars only). action=reset clears cooldowns and disables.",
      inputSchema: {
        action: z.enum(["status", "reset"]).optional(),
        alias: z.string().regex(/^k\d+$/).optional().describe("Key alias like k2, for reset of one key."),
      },
    },
    async (a) => {
      if (a.action === "reset" && !ctx.pool.reset(a.alias)) return invalid(`unknown key alias ${a.alias}; aliases are k1-k${ctx.pool.size}.`);
      const st = ctx.pool.status();
      const lines = st.map(
        (s) =>
          `- ${s.alias} ${s.key}: ${s.state} · ${s.requests} req · $${s.spendUsd.toFixed(4)}${s.reservedUsd ? ` (+$${s.reservedUsd} reserved)` : ""} / $${s.budgetUsd} (${s.month})${s.lastError ? ` · last error: ${s.lastError}` : ""}`,
      );
      const total = st.reduce((n, s) => n + s.spendUsd, 0);
      const left = st.reduce((n, s) => n + Math.max(0, s.budgetUsd - s.spendUsd - s.reservedUsd), 0);
      return ok(
        `## Exa keys (${st.filter((s) => s.healthy).length}/${st.length} usable) · mode ${serverMode(ctx)}\n${lines.join("\n")}\n\n` +
          `Spend this month: $${total.toFixed(4)} · left: $${left.toFixed(2)} · cache entries: ${ctx.cache.size}\n` +
          "Spend is tracked from costDollars of calls made through this server (all sessions on this machine).",
        { keys: st, totalSpendUsd: Number(total.toFixed(4)), budgetLeftUsd: Number(left.toFixed(2)), mode: serverMode(ctx) },
      );
    },
  );
};
