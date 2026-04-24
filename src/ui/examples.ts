import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { PAGE_SIZE } from "../constants.js";
import { fileExists, readSummary } from "../utils/fs.js";
import type { Scope } from "../types/index.js";

interface ExampleEntry {
	id: string;
	displayName: string;
	sourcePath: string;
	summary: string;
	type: "file" | "directory";
}

interface ExampleInstallState {
	example: ExampleEntry;
	globalInstalled: boolean;
	projectInstalled: boolean;
}

export interface ExampleMenuOutcome {
	reloadRequired: boolean;
}

const CURRENT_FILE = fileURLToPath(import.meta.url);
const CURRENT_DIR = dirname(CURRENT_FILE);
const require = createRequire(import.meta.url);

function scopeRoot(scope: Scope, cwd: string): string {
	return scope === "global" ? join(homedir(), ".pi", "agent", "extensions") : join(cwd, ".pi", "extensions");
}

function targetDirForExample(exampleId: string, scope: Scope, cwd: string): string {
	const safeId = exampleId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return join(scopeRoot(scope, cwd), `pi-example-${safeId}`);
}

function targetIndexPaths(exampleId: string, scope: Scope, cwd: string): { active: string; disabled: string; dir: string } {
	const dir = targetDirForExample(exampleId, scope, cwd);
	const active = join(dir, "index.ts");
	return {
		active,
		disabled: `${active}.disabled`,
		dir,
	};
}

async function getExamplesRoot(): Promise<string> {
	const candidates: string[] = [];

	try {
		const piEntry = require.resolve("@mariozechner/pi-coding-agent");
		candidates.push(join(dirname(piEntry), "..", "examples", "extensions"));
	} catch {
		// Fall back to path guesses below.
	}

	candidates.push(
		// Typical when pi-extension-manager has a nested dependency install
		join(CURRENT_DIR, "..", "..", "node_modules", "@mariozechner", "pi-coding-agent", "examples", "extensions"),
		join(CURRENT_DIR, "..", "..", "..", "node_modules", "@mariozechner", "pi-coding-agent", "examples", "extensions"),
		// Typical when dependencies are hoisted next to this package
		join(CURRENT_DIR, "..", "..", "..", "..", "@mariozechner", "pi-coding-agent", "examples", "extensions"),
		// Project-local install fallback
		join(process.cwd(), "node_modules", "@mariozechner", "pi-coding-agent", "examples", "extensions"),
	);

	for (const candidate of candidates) {
		if (await fileExists(candidate)) return candidate;
	}

	throw new Error("Could not locate @mariozechner/pi-coding-agent examples/extensions directory");
}

async function discoverExampleExtensions(): Promise<ExampleEntry[]> {
	const root = await getExamplesRoot();
	const dirEntries = await readdir(root, { withFileTypes: true });
	const examples: ExampleEntry[] = [];

	for (const entry of dirEntries) {
		if (entry.isFile() && entry.name.endsWith(".ts")) {
			const id = entry.name.replace(/\.ts$/i, "");
			const sourcePath = join(root, entry.name);
			examples.push({
				id,
				displayName: id,
				sourcePath,
				summary: await readSummary(sourcePath),
				type: "file",
			});
			continue;
		}

		if (entry.isDirectory()) {
			const sourcePath = join(root, entry.name);
			const indexTs = join(sourcePath, "index.ts");
			if (!(await fileExists(indexTs))) continue;
			examples.push({
				id: entry.name,
				displayName: `${entry.name}/`,
				sourcePath,
				summary: await readSummary(indexTs),
				type: "directory",
			});
		}
	}

	examples.sort((a, b) => a.displayName.localeCompare(b.displayName));
	return examples;
}

async function isExampleInstalled(example: ExampleEntry, scope: Scope, cwd: string): Promise<boolean> {
	const paths = targetIndexPaths(example.id, scope, cwd);
	if (await fileExists(paths.active)) return true;
	if (await fileExists(paths.disabled)) return true;
	return fileExists(paths.dir);
}

async function getExampleInstallStates(cwd: string): Promise<ExampleInstallState[]> {
	const examples = await discoverExampleExtensions();
	const states: ExampleInstallState[] = [];

	for (const example of examples) {
		const [globalInstalled, projectInstalled] = await Promise.all([
			isExampleInstalled(example, "global", cwd),
			isExampleInstalled(example, "project", cwd),
		]);
		states.push({ example, globalInstalled, projectInstalled });
	}

	return states;
}

function scopeLabel(scope: Scope): string {
	return scope === "global" ? "global" : "project";
}

async function installExample(example: ExampleEntry, scope: Scope, cwd: string): Promise<void> {
	const target = targetDirForExample(example.id, scope, cwd);
	const targetIndex = join(target, "index.ts");

	await mkdir(target, { recursive: true });

	if (example.type === "file") {
		const source = await readFile(example.sourcePath, "utf8");
		await writeFile(targetIndex, source, "utf8");
		return;
	}

	await rm(target, { recursive: true, force: true });
	await cp(example.sourcePath, target, { recursive: true });
}

async function uninstallExample(exampleId: string, scope: Scope, cwd: string): Promise<void> {
	const target = targetDirForExample(exampleId, scope, cwd);
	await rm(target, { recursive: true, force: true });
}

function formatStateSuffix(state: ExampleInstallState): string {
	const parts: string[] = [];
	if (state.globalInstalled) parts.push("g");
	if (state.projectInstalled) parts.push("p");
	if (parts.length === 0) return "";
	return ` [${parts.join("/")}]`;
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else console.log(message);
}

async function pickScope(ctx: ExtensionCommandContext): Promise<Scope | undefined> {
	const choice = await ctx.ui.select("Install scope", [
		"Global (~/.pi/agent/extensions)",
		"Project (.pi/extensions)",
		"Cancel",
	]);
	if (!choice || choice === "Cancel") return undefined;
	return choice.startsWith("Global") ? "global" : "project";
}

async function showExamplePageSelect(
	ctx: ExtensionCommandContext,
	title: string,
	pageItems: ExampleInstallState[],
	start: number,
	total: number,
	page: number,
	totalPages: number,
): Promise<string | undefined> {
	const navItems: SelectItem[] = [];
	if (page > 0) navItems.push({ value: "nav:prev", label: "◀ Previous page", description: "Go to prior page" });
	if (page < totalPages - 1)
		navItems.push({ value: "nav:next", label: "▶ Next page", description: "Go to next page" });
	navItems.push({ value: "nav:cancel", label: "Cancel", description: "Return" });

	const exampleItems: SelectItem[] = pageItems.map((state) => ({
		value: `item:${state.example.id}`,
		label: `${state.example.displayName}${formatStateSuffix(state)}`,
		description: state.example.summary,
	}));
	const items: SelectItem[] = [...exampleItems, ...navItems];

	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const themedSelectList = {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		};

		const container = new Container();
		const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
		const header = new Text(
			theme.fg("accent", `${title} (${start + 1}-${Math.min(start + pageItems.length, total)} of ${total}, page ${page + 1}/${totalPages})`),
			1,
			0,
		);
		const details = new Text("", 1, 0);
		const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
		const list = new SelectList(items, Math.min(Math.max(items.length, 5), 14), themedSelectList);

		list.onSelectionChange = (item) => {
			details.setText(theme.fg("dim", item.description ?? ""));
			tui.requestRender();
		};
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);
		const initiallySelected = list.getSelectedItem();
		details.setText(theme.fg("dim", initiallySelected?.description ?? ""));

		container.addChild(topBorder);
		container.addChild(header);
		container.addChild(list);
		container.addChild(details);
		container.addChild(bottomBorder);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				list.handleInput(data);
			},
		};
	});
}

async function selectExampleWithPager(
	ctx: ExtensionCommandContext,
	title: string,
	items: ExampleInstallState[],
): Promise<ExampleInstallState | undefined> {
	if (items.length === 0) return undefined;

	let page = 0;
	const pageSize = Math.max(5, PAGE_SIZE);
	const totalPages = Math.max(1, Math.ceil(items.length / pageSize));

	while (true) {
		const start = page * pageSize;
		const pageItems = items.slice(start, start + pageSize);
		const selectedValue = await showExamplePageSelect(ctx, title, pageItems, start, items.length, page, totalPages);
		if (!selectedValue || selectedValue === "nav:cancel") return undefined;
		if (selectedValue === "nav:prev") {
			page = Math.max(0, page - 1);
			continue;
		}
		if (selectedValue === "nav:next") {
			page = Math.min(totalPages - 1, page + 1);
			continue;
		}
		if (selectedValue.startsWith("item:")) {
			const id = selectedValue.slice(5);
			const selected = pageItems.find((state) => state.example.id === id);
			if (selected) return selected;
		}
	}
}

async function installFromExamples(ctx: ExtensionCommandContext): Promise<boolean> {
	const scope = await pickScope(ctx);
	if (!scope) return false;

	const states = await getExampleInstallStates(ctx.cwd);
	const candidates = states.filter((state) => (scope === "global" ? !state.globalInstalled : !state.projectInstalled));
	if (candidates.length === 0) {
		notify(ctx, `All example extensions are already installed in ${scopeLabel(scope)} scope.`, "info");
		return false;
	}

	const selected = await selectExampleWithPager(
		ctx,
		`Install example extension (${scopeLabel(scope)})`,
		candidates,
	);
	if (!selected) return false;

	await installExample(selected.example, scope, ctx.cwd);
	notify(ctx, `Installed example extension '${selected.example.id}' (${scopeLabel(scope)}).`, "info");
	return true;
}

async function uninstallFromExamples(ctx: ExtensionCommandContext): Promise<boolean> {
	const states = await getExampleInstallStates(ctx.cwd);
	const installed = states.filter((state) => state.globalInstalled || state.projectInstalled);
	if (installed.length === 0) {
		notify(ctx, "No example extensions installed by pi-extension-manager.", "info");
		return false;
	}

	const selected = await selectExampleWithPager(ctx, "Uninstall example extension", installed);
	if (!selected) return false;

	const scopeChoices: string[] = [];
	if (selected.globalInstalled) scopeChoices.push("Global");
	if (selected.projectInstalled) scopeChoices.push("Project");
	if (scopeChoices.length > 1) scopeChoices.push("Both");
	scopeChoices.push("Cancel");

	const scopeChoice = await ctx.ui.select(`Uninstall '${selected.example.id}' from:`, scopeChoices);
	if (!scopeChoice || scopeChoice === "Cancel") return false;

	if (scopeChoice === "Global" || scopeChoice === "Both") {
		await uninstallExample(selected.example.id, "global", ctx.cwd);
	}
	if (scopeChoice === "Project" || scopeChoice === "Both") {
		await uninstallExample(selected.example.id, "project", ctx.cwd);
	}

	notify(ctx, `Uninstalled example extension '${selected.example.id}'.`, "info");
	return true;
}

export async function showExampleExtensionsMenu(ctx: ExtensionCommandContext): Promise<ExampleMenuOutcome> {
	if (!ctx.hasUI) {
		return { reloadRequired: false };
	}

	try {
		const examples = await discoverExampleExtensions();
		if (examples.length === 0) {
			notify(ctx, "No Pi example extensions found in your pi installation.", "warning");
			return { reloadRequired: false };
		}
	} catch (error) {
		notify(
			ctx,
			`Could not load Pi example extensions: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return { reloadRequired: false };
	}

	const action = await ctx.ui.select("Pi example extensions", [
		"Install example extension",
		"Uninstall example extension",
		"Cancel",
	]);
	if (!action || action === "Cancel") return { reloadRequired: false };

	if (action === "Install example extension") {
		const changed = await installFromExamples(ctx);
		return { reloadRequired: changed };
	}

	if (action === "Uninstall example extension") {
		const changed = await uninstallFromExamples(ctx);
		return { reloadRequired: changed };
	}

	return { reloadRequired: false };
}
