/**
 * pi-monitor — wake the agent once when a background command finishes, matches
 * output, or goes quiet.
 *
 * Two tools, one job each:
 *   Monitor     — run a command in the background, wake once on a condition.
 *   CheckLater  — wake the agent after a delay, for checks that are not a
 *                 shell command. The fallback when Monitor cannot apply.
 *
 * Plus MonitorList, MonitorStop, and /monitors for transparency.
 */

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { MonitorManager, type MonitorRecord } from "./monitor-manager.ts";

const WAKE_TYPE = "pi-monitor";

function describeCause(record: MonitorRecord): string {
  const cause = record.cause;
  if (!cause) return "unknown";
  switch (cause.kind) {
    case "matched":
      return `output matched: ${cause.line.trim()}`;
    case "exited":
      if (cause.signal) return `process ended (signal ${cause.signal})`;
      return `process exited with code ${cause.code ?? "unknown"}`;
    case "quiet":
      return `no output for ${Math.round(cause.silentMs / 1000)}s`;
    case "elapsed":
      return `delay elapsed (${Math.round(cause.afterMs / 1000)}s)`;
    case "error":
      return `failed to start: ${cause.message}`;
  }
}

function buildWakeText(record: MonitorRecord): string {
  const lines: string[] = [];
  lines.push(`Monitor #${record.id} fired.`);
  if (record.command) lines.push(`Command: ${record.command}`);
  lines.push(`Why: ${describeCause(record)}`);
  if (record.outputPath) lines.push(`Full output: ${record.outputPath}`);
  lines.push("");
  lines.push(
    record.onDone ??
      record.prompt ??
      "Inspect the result and continue the task.",
  );
  return lines.join("\n");
}

function formatAge(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m${rest}s` : `${minutes}m`;
}

export default function (pi: ExtensionAPI) {
  // Last context seen. Used for status repaints that happen from timers, where
  // no context is passed. Replaced on every session_start and tool call.
  let uiCtx: ExtensionContext | undefined;

  const manager = new MonitorManager({
    now: () => Date.now(),
    wake: (record) => {
      pi.sendMessage(
        {
          customType: WAKE_TYPE,
          content: buildWakeText(record),
          display: true,
          details: {
            id: record.id,
            kind: record.kind,
            command: record.command,
            outputPath: record.outputPath,
            cause: record.cause,
          },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
    changed: () => refreshStatus(),
  });

  function refreshStatus(): void {
    if (!uiCtx?.hasUI) return;
    const records = manager.list();
    const running = records.filter((r) => r.status === "running").length;
    if (running === 0) {
      uiCtx.ui.setStatus(WAKE_TYPE, undefined);
      return;
    }
    uiCtx.ui.setStatus(WAKE_TYPE, `⏱ ${running} monitor${running === 1 ? "" : "s"}`);
  }

  // --- Tools -------------------------------------------------------------

  const monitorTool = defineTool({
    name: "Monitor",
    label: "Monitor",
    description:
      "Run a shell command in the background and wake you once when it finishes, " +
      "matches a pattern, or goes quiet. Use this instead of blocking or polling " +
      "(no `sleep && check` loops). Fires once, then stops the command and retires. " +
      "Use it to wait for a condition, not to keep a process running. Output is " +
      "captured to a temp file whose path is included in the wake.",
    promptSnippet: "Monitor a background command and wake once on a condition",
    promptGuidelines: [
      "Prefer Monitor over blocking or polling when a command may take more than a few seconds.",
    ],
    parameters: Type.Object({
      command: Type.String({
        description: "Shell command to run in the background.",
      }),
      match: Type.Optional(
        Type.String({
          description:
            "Regular expression. Wake when an output line matches, e.g. 'listening on'.",
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({
          description:
            "Silence threshold in seconds. Any output renews it. Default 300. " +
            "0 disables. The command is stopped when this fires.",
        }),
      ),
      onDone: Type.Optional(
        Type.String({
          description:
            "What to do when it fires. Delivered to the agent as the wake instruction.",
        }),
      ),
      label: Type.Optional(
        Type.String({ description: "Short human-readable label." }),
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      uiCtx = ctx;
      const record = manager.createProcess({
        command: params.command,
        match: params.match,
        timeoutSeconds: params.timeoutSeconds,
        onDone: params.onDone,
        label: params.label,
        cwd: ctx.cwd,
      });
      return {
        content: [
          {
            type: "text",
            text: `Monitoring #${record.id}: ${record.label}\nOutput: ${record.outputPath}\nYou will be woken once when it fires.`,
          },
        ],
        details: { id: record.id, outputPath: record.outputPath },
      };
    },
  });

  const checkLaterTool = defineTool({
    name: "CheckLater",
    label: "CheckLater",
    description:
      "Wake you after a delay so you can re-check something the shell cannot " +
      "observe (e.g. an external deployment). Fallback only: if the check can be " +
      "a shell command, use Monitor instead. Each fire costs a turn.",
    parameters: Type.Object({
      prompt: Type.String({
        description: "What to do when woken, e.g. 'check the deployment status'.",
      }),
      delaySeconds: Type.Number({
        description: "Seconds to wait before waking you.",
      }),
      label: Type.Optional(
        Type.String({ description: "Short human-readable label." }),
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      uiCtx = ctx;
      const record = manager.createTimer({
        prompt: params.prompt,
        delaySeconds: params.delaySeconds,
        label: params.label,
      });
      return {
        content: [
          {
            type: "text",
            text: `CheckLater #${record.id} scheduled in ${params.delaySeconds}s.`,
          },
        ],
        details: { id: record.id },
      };
    },
  });

  const listTool = defineTool({
    name: "MonitorList",
    label: "MonitorList",
    description: "List monitors and their status.",
    parameters: Type.Object({}),
    async execute() {
      const records = manager.list();
      if (records.length === 0) {
        return { content: [{ type: "text", text: "No monitors." }], details: {} };
      }
      const now = Date.now();
      const text = records
        .map((r) => {
          const head = `#${r.id} [${r.status}] ${r.label}`;
          const age = `started ${formatAge(now - r.startedAt)} ago`;
          return r.status === "fired"
            ? `${head} — ${describeCause(r)} (${formatAge((r.firedAt ?? now) - r.startedAt)}), ${age}`
            : `${head} — ${age}`;
        })
        .join("\n");
      return { content: [{ type: "text", text }], details: { count: records.length } };
    },
  });

  const stopTool = defineTool({
    name: "MonitorStop",
    label: "MonitorStop",
    description: "Stop a running monitor without waking the agent.",
    parameters: Type.Object({
      id: Type.String({ description: "Monitor id, from MonitorList." }),
    }),
    async execute(_callId, params) {
      const result = manager.stop(params.id);
      const text =
        result === "stopped"
          ? `Stopped monitor #${params.id}.`
          : result === "not-running"
            ? `Monitor #${params.id} is not running.`
            : `No monitor with id ${params.id}.`;
      return { content: [{ type: "text", text }], details: { result } };
    },
  });

  pi.registerTool(monitorTool);
  pi.registerTool(checkLaterTool);
  pi.registerTool(listTool);
  pi.registerTool(stopTool);

  // --- Command -----------------------------------------------------------

  pi.registerCommand("monitors", {
    description: "List active monitors",
    handler: async (_args, ctx) => {
      const records = manager.list();
      if (records.length === 0) {
        ctx.ui.notify("No monitors.", "info");
        return;
      }
      const lines = records.map((r) => {
        const cause = r.status === "fired" ? ` — ${describeCause(r)}` : "";
        return `#${r.id} [${r.status}] ${r.label}${cause}`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // --- Rendering ---------------------------------------------------------

  pi.registerMessageRenderer(WAKE_TYPE, (message, _options, theme) => {
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(
      new Text(`${theme.fg("accent", "⏱")} ${message.content}`, 0, 0),
    );
    return box;
  });

  // --- Lifecycle ---------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    uiCtx = ctx;
    refreshStatus();
  });

  pi.on("session_shutdown", async () => {
    manager.shutdown();
  });
}
