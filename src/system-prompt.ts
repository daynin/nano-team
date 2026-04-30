import type { TeamMember } from "./types.ts";

const TASK_SUMMARY_MAX_CHARS = 80;

const summarizeTask = (task: string): string => {
	const firstLine = task.split("\n")[0]?.trim() ?? "";
	if (firstLine.length === 0) return "(no default task)";
	return firstLine.length <= TASK_SUMMARY_MAX_CHARS
		? firstLine
		: `${firstLine.slice(0, TASK_SUMMARY_MAX_CHARS - 1)}…`;
};

const formatTeamMember = (member: TeamMember): string =>
	`- \`${member.name}\` (${member.role}, ${member.model}) — ${summarizeTask(member.task)}`;

const renderRoster = (team: ReadonlyMap<string, TeamMember>): string =>
	team.size === 0
		? "(none defined yet)"
		: Array.from(team.values(), formatTeamMember).join("\n");

const STATIC_GUIDANCE =
	"`nano_agent_spawn(name, task?)` runs an agent and returns its final output (`task` overrides the YAML default). `nano_agent_kill(name)` aborts; `nano_agent_status(name?)` inspects. Issue several `spawn` calls in one turn for parallel work; chain by passing one agent's output as the next agent's `task`.\n\n" +
	"Add a member: YAML at `.pi/nano-team/team/<name>.yaml` with fields `name`, `role` (one lowercased word), `model`, `instructions`, `task`. `/reload` after editing.";

export const buildSystemPromptAddition = (team: ReadonlyMap<string, TeamMember>): string =>
	`# nano-team subagents\n\nRoster:\n${renderRoster(team)}\n\n${STATIC_GUIDANCE}`;
