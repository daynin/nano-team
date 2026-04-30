import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import type { TeamMember } from "./types.ts";

export const TEAM_DIR = path.join(".pi", "nano-team", "team");

export type LoadResult = Readonly<{
	team: ReadonlyMap<string, TeamMember>;
	errors: readonly string[];
}>;

const REQUIRED_FIELDS = ["name", "role", "instructions", "task", "model"] as const;

const isNonEmptyString = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;

type ParsedFile = Readonly<{ displayPath: string; parsed: unknown } | { displayPath: string; parseError: string }>;

const readAndParseFile = async (filePath: string, cwd: string): Promise<ParsedFile> => {
	const displayPath = path.relative(cwd, filePath);
	try {
		const content = await fs.readFile(filePath, "utf-8");
		return { displayPath, parsed: YAML.parse(content) as unknown };
	} catch (error) {
		return { displayPath, parseError: (error as Error).message };
	}
};

const listYamlFiles = async (directory: string): Promise<readonly string[]> => {
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		return entries
			.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && /\.ya?ml$/i.test(entry.name))
			.map((entry) => path.join(directory, entry.name))
			.sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
};

export const loadTeam = async (cwd: string): Promise<LoadResult> => {
	const files = await listYamlFiles(path.join(cwd, TEAM_DIR));
	const parsedFiles = await Promise.all(files.map((file) => readAndParseFile(file, cwd)));

	const team = new Map<string, TeamMember>();
	const errors: string[] = [];

	for (const file of parsedFiles) {
		if ("parseError" in file) {
			errors.push(`${file.displayPath}: ${file.parseError}`);
			continue;
		}
		if (file.parsed === null || typeof file.parsed !== "object") {
			errors.push(`${file.displayPath}: expected a YAML mapping at the top level`);
			continue;
		}
		const record = file.parsed as Record<string, unknown>;
		const missing = REQUIRED_FIELDS.filter((field) => !isNonEmptyString(record[field]));
		if (missing.length > 0) {
			errors.push(`${file.displayPath}: missing or empty field(s): ${missing.join(", ")}`);
			continue;
		}
		const role = (record.role as string).trim().toLowerCase();
		if (role.includes(" ")) {
			errors.push(`${file.displayPath}: 'role' must be a single word (got '${role}')`);
			continue;
		}
		const name = (record.name as string).trim();
		const existing = team.get(name);
		if (existing) {
			errors.push(
				`duplicate agent name '${name}' in ${existing.sourceFile} and ${file.displayPath} (keeping ${existing.sourceFile})`,
			);
			continue;
		}
		team.set(name, Object.freeze({
			name,
			role,
			instructions: (record.instructions as string).trim(),
			task: (record.task as string).trim(),
			model: (record.model as string).trim(),
			sourceFile: file.displayPath,
		}));
	}

	return Object.freeze({ team: team as ReadonlyMap<string, TeamMember>, errors: Object.freeze(errors) });
};
