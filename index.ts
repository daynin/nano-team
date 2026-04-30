import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createRunner, type Runner } from "./src/runner.ts";
import { buildSystemPromptAddition } from "./src/system-prompt.ts";
import { loadTeam } from "./src/team.ts";
import { registerTools } from "./src/tools.ts";
import { LIVE_AGENT_STATES, type TeamMember } from "./src/types.ts";
import { renderChips } from "./src/widget.ts";

const WIDGET_KEY = "nano-team";
const FLUSH_DEBOUNCE_MS = 50;
const ANIMATION_FRAME_MS = 300;
const FALLBACK_TERMINAL_COLS = 80;

type WidgetFlusher = Readonly<{ schedule: () => void; cancel: () => void }>;

const createWidgetFlusher = (
	ctx: ExtensionContext,
	getRunner: () => Runner | null,
	getTeam: () => ReadonlyMap<string, TeamMember>,
): WidgetFlusher => {
	let pendingTimer: NodeJS.Timeout | null = null;
	let animationTimer: NodeJS.Timeout | null = null;

	const stopAnimation = (): void => {
		if (!animationTimer) return;
		clearInterval(animationTimer);
		animationTimer = null;
	};

	const flush = (): void => {
		pendingTimer = null;
		const runner = ctx.hasUI ? getRunner() : null;
		if (!runner) {
			stopAnimation();
			return;
		}
		const runs = runner.list();
		const lines = renderChips(
			runs,
			getTeam(),
			process.stdout.columns ?? FALLBACK_TERMINAL_COLS,
			ctx.ui.theme,
			Math.floor(Date.now() / ANIMATION_FRAME_MS),
		);
		ctx.ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined, { placement: "aboveEditor" });

		const hasLiveAgent = runs.some((run) => LIVE_AGENT_STATES.has(run.state));
		if (hasLiveAgent && !animationTimer) {
			animationTimer = setInterval(flush, ANIMATION_FRAME_MS);
			animationTimer.unref?.();
		} else if (!hasLiveAgent) {
			stopAnimation();
		}
	};

	return {
		schedule: () => {
			if (pendingTimer) return;
			pendingTimer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
		},
		cancel: () => {
			if (pendingTimer) {
				clearTimeout(pendingTimer);
				pendingTimer = null;
			}
			stopAnimation();
		},
	};
};

export default function nanoTeam(pi: ExtensionAPI): void {
	let team: ReadonlyMap<string, TeamMember> = new Map();
	let runner: Runner | null = null;
	let flusher: WidgetFlusher | null = null;

	pi.on("session_start", async (_event, ctx) => {
		const result = await loadTeam(ctx.cwd);
		team = result.team;

		if (ctx.hasUI && result.errors.length > 0) {
			ctx.ui.notify(`nano-team: ${result.errors.join("; ")}`, "warning");
		}

		flusher = createWidgetFlusher(ctx, () => runner, () => team);
		runner = createRunner(ctx.cwd, () => flusher?.schedule());
		registerTools(pi, runner, () => team);
		flusher.schedule();
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${buildSystemPromptAddition(team)}`,
	}));

	pi.on("session_shutdown", () => {
		flusher?.cancel();
		runner?.shutdown();
		runner = null;
		flusher = null;
	});
}
