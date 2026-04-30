import { Type, type Static } from "typebox";

export type AgentState = "idle" | "thinking" | "working" | "done" | "error";

export type TeamMember = Readonly<{
	name: string;
	role: string;
	instructions: string;
	task: string;
	model: string;
	sourceFile: string;
}>;

export type AgentRun = Readonly<{
	name: string;
	state: AgentState;
	task: string;
	startedAt: number;
	endedAt: number | null;
	transcript: string;
	activity: string | null;
	lastError: string | null;
	pid: number | null;
}>;

export const LIVE_AGENT_STATES: ReadonlySet<AgentState> = new Set(["thinking", "working"]);

export const createInitialRun = (name: string, task = ""): AgentRun => ({
	name,
	state: "idle",
	task,
	startedAt: 0,
	endedAt: null,
	transcript: "",
	activity: null,
	lastError: null,
	pid: null,
});

export const SpawnParams = Type.Object({
	name: Type.String({ description: "Team member name (matches YAML 'name' field)" }),
	task: Type.Optional(
		Type.String({ description: "Override the agent's default task. Falls back to YAML 'task' when omitted." }),
	),
});

export const KillParams = Type.Object({
	name: Type.String({ description: "Team member name to abort" }),
});

export const StatusParams = Type.Object({
	name: Type.Optional(
		Type.String({ description: "Specific agent to inspect; omit to list every team member" }),
	),
});

export type SpawnArgs = Static<typeof SpawnParams>;
export type KillArgs = Static<typeof KillParams>;
export type StatusArgs = Static<typeof StatusParams>;

export const AGENT_PALETTE: readonly string[] = [
	"#e06363", "#7ad9d9", "#f0a060", "#80b8e0", "#f0c060", "#7a9aff",
	"#c0d860", "#b48cff", "#80c878", "#d880e0", "#5dd4a3", "#f0a0c0",
];
