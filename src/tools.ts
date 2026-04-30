import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Runner } from "./runner.ts";
import {
	type AgentRun,
	createInitialRun,
	KillParams,
	type KillArgs,
	SpawnParams,
	type SpawnArgs,
	StatusParams,
	type StatusArgs,
	type TeamMember,
} from "./types.ts";

const asTextContent = (text: string) => ({ type: "text" as const, text });

const formatAvailableAgents = (team: ReadonlyMap<string, TeamMember>): string =>
	[...team.keys()].join(", ") || "(no team members loaded)";

const formatDuration = (millis: number): string => {
	if (millis < 1000) return `${millis}ms`;
	const seconds = Math.round(millis / 100) / 10;
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
};

const describeRunDuration = (run: AgentRun): string => {
	if (run.startedAt === 0) return "—";
	return formatDuration((run.endedAt ?? Date.now()) - run.startedAt);
};

const escapeTableCell = (raw: string): string =>
	raw.replace(/\|/g, "\\|").replace(/\n/g, " ").trim() || "—";

const buildTableRow = (cells: readonly string[]): string =>
	`| ${cells.map(escapeTableCell).join(" | ")} |`;

const truncateTaskCell = (task: string): string =>
	task.length <= 60 ? task : `${task.slice(0, 59)}…`;

const renderStatusTable = (
	team: ReadonlyMap<string, TeamMember>,
	runs: readonly AgentRun[],
): string => {
	const runsByName = new Map(runs.map((run) => [run.name, run]));
	const teamRows = Array.from(team.values(), (member) => {
		const run = runsByName.get(member.name);
		return buildTableRow([
			member.name,
			member.role,
			run?.state ?? "idle",
			run ? describeRunDuration(run) : "—",
			truncateTaskCell(run?.task || member.task),
		]);
	});
	const orphanRows = runs
		.filter((run) => !team.has(run.name))
		.map((run) => buildTableRow([run.name, "?", run.state, describeRunDuration(run), truncateTaskCell(run.task)]));
	return [
		buildTableRow(["name", "role", "state", "duration", "task"]),
		"|---|---|---|---|---|",
		...teamRows,
		...orphanRows,
	].join("\n");
};

const renderSingleAgentStatus = (run: AgentRun, member: TeamMember | undefined): string => {
	const lines = [
		`name: ${run.name}`,
		`role: ${member?.role ?? "?"}`,
		`state: ${run.state}`,
		`model: ${member?.model ?? "?"}`,
		`duration: ${describeRunDuration(run)}`,
		`task: ${run.task || member?.task || ""}`,
	];
	if (run.lastError) lines.push(`error: ${run.lastError}`);
	if (run.transcript) lines.push("", "transcript:", run.transcript);
	return lines.join("\n");
};

type StatusDetails = Readonly<{
	team: readonly TeamMember[];
	runs: readonly AgentRun[];
	focused?: { run: AgentRun; member: TeamMember | undefined };
}>;

export const registerTools = (
	pi: ExtensionAPI,
	runner: Runner,
	getTeam: () => ReadonlyMap<string, TeamMember>,
): void => {
	pi.registerTool({
		name: "nano_agent_spawn",
		label: "Spawn nano-team agent",
		description:
			"Run a pre-defined team member as an isolated pi subagent. The agent's YAML 'task' is the default; pass `task` to override per call. Multiple agents can run in parallel via parallel tool calls.",
		promptSnippet:
			"`nano_agent_spawn(name, task?)` — delegate a subtask to a pre-defined nano-team member.",
		parameters: SpawnParams,
		async execute(_toolCallId, params: SpawnArgs, signal) {
			const team = getTeam();
			const member = team.get(params.name);
			if (!member) {
				throw new Error(`unknown agent '${params.name}'. available: ${formatAvailableAgents(team)}`);
			}
			const task = (params.task ?? member.task).trim();
			if (!task) {
				throw new Error(`no task supplied for '${params.name}' and YAML 'task' is empty`);
			}
			const run = await runner.spawn(member, task, signal);
			if (run.state === "error") {
				throw new Error(run.lastError || run.transcript || `agent '${params.name}' failed`);
			}
			return { content: [asTextContent(run.transcript || "(no output)")], details: { run } };
		},
	});

	pi.registerTool({
		name: "nano_agent_kill",
		label: "Kill nano-team agent",
		description: "Abort a currently running team member. Use the agent's name (matches YAML 'name' field).",
		promptSnippet: "`nano_agent_kill(name)` — abort a stuck or no-longer-needed nano-team agent.",
		parameters: KillParams,
		async execute(_toolCallId, params: KillArgs) {
			if (!runner.kill(params.name)) {
				throw new Error(`agent '${params.name}' is not running`);
			}
			return { content: [asTextContent(`killed '${params.name}'`)], details: { name: params.name } };
		},
	});

	pi.registerTool<typeof StatusParams, StatusDetails>({
		name: "nano_agent_status",
		label: "Status of nano-team agents",
		description:
			"Inspect team members. With `name`, returns details for that agent (state, transcript, error). Without, returns a markdown table of all agents.",
		promptSnippet:
			"`nano_agent_status(name?)` — list nano-team agents and their states (or one agent's transcript).",
		parameters: StatusParams,
		async execute(_toolCallId, params: StatusArgs) {
			const team = getTeam();
			const teamArray = [...team.values()];
			const allRuns = runner.list();
			if (params.name) {
				const member = team.get(params.name);
				const existingRun = runner.get(params.name);
				if (!member && !existingRun) {
					throw new Error(`unknown agent '${params.name}'. available: ${formatAvailableAgents(team)}`);
				}
				const focusedRun = existingRun ?? createInitialRun(params.name, member?.task ?? "");
				return {
					content: [asTextContent(renderSingleAgentStatus(focusedRun, member))],
					details: { team: teamArray, runs: allRuns, focused: { run: focusedRun, member } },
				};
			}
			if (team.size === 0 && allRuns.length === 0) {
				return {
					content: [asTextContent("no team members defined. add YAML files under .pi/nano-team/team/")],
					details: { team: teamArray, runs: allRuns },
				};
			}
			return {
				content: [asTextContent(renderStatusTable(team, allRuns))],
				details: { team: teamArray, runs: allRuns },
			};
		},
	});
};
