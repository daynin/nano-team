import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentRun, type AgentState, createInitialRun, LIVE_AGENT_STATES, type TeamMember } from "./types.ts";

export type Runner = Readonly<{
	spawn(member: TeamMember, task: string, signal: AbortSignal | undefined): Promise<AgentRun>;
	kill(name: string): boolean;
	list(): readonly AgentRun[];
	get(name: string): AgentRun | undefined;
	shutdown(): void;
}>;

const KILL_GRACE_MS = 2000;
const ACTIVITY_MAX_CHARS = 80;
const TOOL_ARG_KEYS = [
	"path", "file", "filePath", "file_path", "url",
	"command", "query", "pattern", "name", "id", "title",
] as const;

type AssistantTextPart = { type: "text"; text: string };
type AssistantToolCallPart = { type: "toolCall"; name: string; arguments: unknown };
type AssistantPart = AssistantTextPart | AssistantToolCallPart | { type: string };

type StreamEvent = { type: string } & Record<string, unknown>;

type StreamAccumulator = {
	state: AgentState;
	transcript: string;
	activity: string | null;
	stopReason: string | undefined;
	errorMessage: string | undefined;
};

type PiInvocation = { command: string; baseArgs: readonly string[] };

let cachedPiInvocation: PiInvocation | null = null;

const derivePiInvocation = (): PiInvocation => {
	if (cachedPiInvocation) return cachedPiInvocation;
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return (cachedPiInvocation = { command: process.execPath, baseArgs: [currentScript] });
	}
	const executableName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(executableName);
	return (cachedPiInvocation = isGenericRuntime
		? { command: "pi", baseArgs: [] }
		: { command: process.execPath, baseArgs: [] });
};

const truncateActivity = (text: string): string =>
	text.length <= ACTIVITY_MAX_CHARS ? text : `${text.slice(0, ACTIVITY_MAX_CHARS - 1)}…`;

const summarizeToolArguments = (toolArguments: unknown): string => {
	if (!toolArguments || typeof toolArguments !== "object") return "";
	const record = toolArguments as Record<string, unknown>;
	for (const key of TOOL_ARG_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return "";
};

const formatTextSnippet = (text: string): string => {
	const lines = text.split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const trimmed = lines[index]?.replace(/\s+/g, " ").trim() ?? "";
		if (trimmed.length > 0) return truncateActivity(trimmed);
	}
	return "";
};

const formatToolActivity = (toolName: string, toolArguments: unknown): string => {
	const argumentSummary = summarizeToolArguments(toolArguments);
	return truncateActivity(argumentSummary.length > 0 ? `→ ${toolName}(${argumentSummary})` : `→ ${toolName}`);
};

const ingestAssistantMessage = (accumulator: StreamAccumulator, raw: unknown): boolean => {
	if (!raw || typeof raw !== "object") return false;
	const record = raw as Record<string, unknown>;
	if (record.role !== "assistant" || !Array.isArray(record.content)) return false;
	const parts = record.content as readonly AssistantPart[];
	let appendedText = "";
	let hasToolCall = false;
	for (const part of parts) {
		if (part.type === "text") appendedText += (part as AssistantTextPart).text;
		else if (part.type === "toolCall") hasToolCall = true;
	}
	let changed = false;
	if (appendedText.length > 0) {
		accumulator.transcript += appendedText;
		changed = true;
		if (!hasToolCall) {
			const snippet = formatTextSnippet(appendedText);
			if (snippet.length > 0) accumulator.activity = snippet;
		}
	}
	if (typeof record.stopReason === "string" && accumulator.stopReason !== record.stopReason) {
		accumulator.stopReason = record.stopReason;
		changed = true;
	}
	if (typeof record.errorMessage === "string" && accumulator.errorMessage !== record.errorMessage) {
		accumulator.errorMessage = record.errorMessage;
		changed = true;
	}
	return changed;
};

const applyStreamEvent = (accumulator: StreamAccumulator, event: StreamEvent): boolean => {
	switch (event.type) {
		case "message_start": {
			if (accumulator.state === "thinking") return false;
			accumulator.state = "thinking";
			return true;
		}
		case "tool_execution_start": {
			const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
			accumulator.state = "working";
			accumulator.activity = formatToolActivity(toolName, event.args);
			return true;
		}
		case "message_end":
			return ingestAssistantMessage(accumulator, event.message);
		default:
			return false;
	}
};

const killWithGrace = (child: ChildProcess): void => {
	if (child.killed) return;
	child.kill("SIGTERM");
	setTimeout(() => {
		if (!child.killed) child.kill("SIGKILL");
	}, KILL_GRACE_MS).unref();
};

const writeSystemPromptFile = async (instructions: string): Promise<{ filePath: string; directory: string }> => {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nano-team-"));
	const filePath = path.join(directory, "system.md");
	await fs.promises.writeFile(filePath, instructions, { encoding: "utf-8", mode: 0o600 });
	return { filePath, directory };
};

export const createRunner = (cwd: string, onChange: () => void): Runner => {
	const runs = new Map<string, AgentRun>();
	const children = new Map<string, ChildProcess>();
	const tempDirectories = new Set<string>();
	const spawning = new Set<string>();
	let isShuttingDown = false;

	const updateRun = (name: string, patch: Partial<AgentRun>): void => {
		const previous = runs.get(name) ?? createInitialRun(name);
		runs.set(name, { ...previous, ...patch });
		onChange();
	};

	const spawnAgent = async (
		member: TeamMember,
		task: string,
		signal: AbortSignal | undefined,
	): Promise<AgentRun> => {
		const existingRun = runs.get(member.name);
		if (spawning.has(member.name) || (existingRun && LIVE_AGENT_STATES.has(existingRun.state))) {
			throw new Error(`agent '${member.name}' is already running (state=${existingRun?.state ?? "spawning"})`);
		}
		if (signal?.aborted) throw new Error(`spawn aborted before start for '${member.name}'`);

		spawning.add(member.name);
		let promptFile: { filePath: string; directory: string };
		try {
			promptFile = await writeSystemPromptFile(member.instructions);
			tempDirectories.add(promptFile.directory);
		} catch (error) {
			spawning.delete(member.name);
			throw error;
		}

		const invocation = derivePiInvocation();
		const args = [
			...invocation.baseArgs,
			"--mode", "json",
			"-p",
			"--no-session",
			"--model", member.model,
			"--append-system-prompt", promptFile.filePath,
			task,
		];

		updateRun(member.name, {
			state: "thinking",
			task,
			startedAt: Date.now(),
			endedAt: null,
			transcript: "",
			activity: null,
			lastError: null,
			pid: null,
		});
		spawning.delete(member.name);

		return new Promise<AgentRun>((resolve) => {
			const child = spawn(invocation.command, args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			children.set(member.name, child);
			updateRun(member.name, { pid: child.pid ?? null });

			const accumulator: StreamAccumulator = {
				state: "thinking",
				transcript: "",
				activity: null,
				stopReason: undefined,
				errorMessage: undefined,
			};
			let aborted = false;
			let stderrBuffer = "";
			let pendingLine = "";
			let resolved = false;

			const consumeLine = (line: string): void => {
				if (line.length === 0) return;
				let parsed: unknown;
				try { parsed = JSON.parse(line); } catch { return; }
				if (!parsed || typeof parsed !== "object") return;
				const event = parsed as StreamEvent;
				if (typeof event.type !== "string") return;
				if (!applyStreamEvent(accumulator, event)) return;
				updateRun(member.name, {
					state: accumulator.state,
					transcript: accumulator.transcript,
					activity: accumulator.activity,
				});
			};

			child.stdout?.on("data", (chunk: Buffer) => {
				pendingLine += chunk.toString("utf-8");
				let newlineIndex = pendingLine.indexOf("\n");
				while (newlineIndex !== -1) {
					consumeLine(pendingLine.slice(0, newlineIndex));
					pendingLine = pendingLine.slice(newlineIndex + 1);
					newlineIndex = pendingLine.indexOf("\n");
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => { stderrBuffer += chunk.toString("utf-8"); });

			const onAbort = (): void => {
				aborted = true;
				killWithGrace(child);
			};
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			const finalize = (exitCode: number | null): void => {
				if (resolved) return;
				resolved = true;
				if (pendingLine.length > 0) consumeLine(pendingLine);
				signal?.removeEventListener("abort", onAbort);
				children.delete(member.name);
				tempDirectories.delete(promptFile.directory);
				fs.promises.rm(promptFile.directory, { recursive: true, force: true }).catch(() => {});

				const failed =
					aborted ||
					exitCode !== 0 ||
					accumulator.stopReason === "error" ||
					accumulator.stopReason === "aborted" ||
					accumulator.errorMessage !== undefined;

				if (!failed) {
					updateRun(member.name, { state: "done", endedAt: Date.now(), activity: null, lastError: null, pid: null });
				} else {
					const trimmedStderr = stderrBuffer.trim();
					const lastError =
						accumulator.errorMessage ??
						(trimmedStderr.length > 0 ? trimmedStderr : null) ??
						(aborted ? "aborted" : null) ??
						`pi exited with code ${exitCode ?? "unknown"}`;
					updateRun(member.name, { state: "error", endedAt: Date.now(), activity: null, lastError, pid: null });
				}
				resolve(runs.get(member.name) ?? createInitialRun(member.name, task));
			};

			child.on("error", (error) => {
				accumulator.errorMessage = error.message;
				if (!children.has(member.name)) finalize(null);
			});
			child.on("close", finalize);
		});
	};

	const shutdown = (): void => {
		if (isShuttingDown) return;
		isShuttingDown = true;
		process.removeListener("exit", shutdown);
		for (const child of children.values()) {
			try { if (!child.killed) child.kill("SIGKILL"); } catch { /* ignore */ }
		}
		children.clear();
		for (const directory of tempDirectories) {
			try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
		}
		tempDirectories.clear();
	};

	process.on("exit", shutdown);

	return Object.freeze({
		spawn: spawnAgent,
		kill: (name) => {
			const child = children.get(name);
			if (!child) return false;
			killWithGrace(child);
			return true;
		},
		list: () => Array.from(runs.values()),
		get: (name) => runs.get(name),
		shutdown,
	});
};
